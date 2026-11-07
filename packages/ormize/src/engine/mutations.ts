// Mutation entry points: create, update, select, delete, restore.
//
// Each one opens (or joins) a transaction, runs the mutation body, and
// invalidates the read cache on the way out. Extracted from the `Ormize` class
// so all mutation logic lives in one module.

import waterfall from "@azerothian/utilize/utils/waterfall";
import { isStructurallyWritable } from "@azerothian/utilize/gate";
import { whereOperatorsFor, definitionMethods, mutationInstanceMethods } from "@azerothian/utilize/exposed-methods";
import { ScopeDeniedError } from "../scope";
import { applyRelationshipMutations } from "../relationship-mutations";
import Events from "../events";
import type {
  OrmAdapter, AdapterRow, RequestContext,
  Selection, GlobalKeyTargets,
} from "@azerothian/utilize/types/index";
import type { ScopeOperation } from "@azerothian/utilize/gate";
import type { Definition } from "../types";
import type {
  InstanceRow, MutationApply, MutationFilter, MutationHost,
  MutationInput, MutationInputTree,
} from "../types/engine";

import type { HookHost } from "./hooks";
import type { ScopeHost } from "./scope-bridge";
import { resolveRowScope, scopedWriteWhere, assertRowsInScope, scopeMiss as scopeMissFn } from "./scope-bridge";
import type { ReadCacheHost } from "./read-cache-bridge";
import { writeFootprint } from "./read-cache-bridge";
import { createResolveContext } from "./resolution";

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

export interface MutationEntryHost extends HookHost, ScopeHost, ReadCacheHost {
  host: MutationHost;
  defsAdapters: { [name: string]: string };
  getGlobalKeys(defName: string): string[];
  getGlobalKeyTargets(defName: string): GlobalKeyTargets;
  getFields(defName: string): Record<string, { type?: unknown; foreignKey?: boolean; primaryKey?: boolean; writable?: boolean | undefined; index?: boolean; allowNull?: boolean }>;
  withTransaction<T>(defName: string, context: RequestContext, fn: (ctx: RequestContext) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// mutationEntry — the wrapper every top-level mutation shares
// ---------------------------------------------------------------------------

/**
 * Open (or join) the unit of work a top-level mutation runs in, then hand the
 * body the four lookups all four of them opened with.
 *
 * It is a wrapper rather than four copies of the preamble because of the
 * `context` shadowing: {@link withTransaction} hands back a context carrying
 * the adapter's transaction handle, and a body that used the one it was called
 * with would run outside the transaction. Making the shadow a parameter is what
 * stops that being a rename away.
 */
export function mutationEntry<T>(
  self: MutationEntryHost,
  defName: string,
  context: RequestContext,
  selection: Selection | undefined,
  fn: (entry: {
    context: RequestContext;
    adapter: OrmAdapter;
    definition: Definition;
    globalKeys: string[];
    idTargets: GlobalKeyTargets;
    translateFilter: NonNullable<Selection["translateFilter"]>;
  }) => Promise<T>,
): Promise<T> {
  return self.withTransaction(defName, context, async(context: RequestContext) => {
    try {
      return await fn({
        context,
        adapter: self.getModelAdapter(defName),
        definition: self.getDefinition(defName),
        globalKeys: self.getGlobalKeys(defName),
        idTargets: self.getGlobalKeyTargets(defName),
        translateFilter: selection?.translateFilter || (<W,>(w: W) => w),
      });
    } finally {
      // Also on a throw: a mutation that wrote some rows and then failed may
      // have committed them on an adapter with no transaction to roll back.
      // Inside a transaction, `invalidate` bumps again after the commit.
      await self.readCache?.invalidate(writeFootprint(self, defName), context?.transaction);
    }
  });
}

// ---------------------------------------------------------------------------
// processInputs — the allow-list and scope `set` merge
// ---------------------------------------------------------------------------

export async function processInputs(
  self: MutationEntryHost,
  defName: string, input: MutationInputTree, args: unknown, context: RequestContext,
  info: unknown, model?: AdapterRow, operationHint?: ScopeOperation,
): Promise<MutationInput> {
  const definition = self.getDefinition(defName);
  const fields = self.getFields(defName);
  // Allow-list scalar input to writable columns. `isStructurallyWritable`
  // drops primary keys, foreign keys, and auto-populated columns by default
  // (unless a field opts in with `writable: true`) — a defense-in-depth guard
  // against mass-assignment / IDOR that applies to both create and update
  // (processUpdate funnels its payload back through here).
  let i = Object.keys(fields).reduce((o, key) => {
    if (input[key] !== undefined && isStructurallyWritable(fields[key])) {
      o[key] = input[key];
    }
    return o;
  }, {} as MutationInput);

  if (definition.override) {
    i = await waterfall(Object.keys(definition.override), async(key: string, o: MutationInput) => {
      if (definition.override) {
        const input = definition.override[key].input;
        if (input) {
          const val = await input(o[key], args, context, info, model);
          if (val !== undefined) {
            o[key] = val;
          }
        }
      }
      return o;
    }, i);
  }

  // The `set` half of a row-level scope: field values the scope *forces*.
  //
  // Applied after `definition.override` rather than merely after the
  // mass-assignment allow-list, because an `override.ownerId.input` returning
  // a value would otherwise stomp what the scope forces. The allow-list is the
  // complementary half — `ownerId` is a foreign key, so
  // `isStructurallyWritable` has already dropped whatever the client sent, and
  // `set` supplies a value the client had no way to send.
  // `model` is the row being written, so its presence names the operation —
  // except where the caller already knows and has no row to hand over. The
  // nested `update` verb is exactly that: it processes one input for the whole
  // set of rows a filter matched, so it passes the hint rather than an
  // arbitrary member of that set (which `definition.override` would then see).
  const operation: ScopeOperation = operationHint || (model === undefined ? "create" : "update");
  const rowScope = await resolveRowScope(self, defName, operation, context);
  const forced = rowScope ? rowScope.set : undefined;
  if (forced) {
    for (const key of Object.keys(forced)) {
      if (i[key] !== undefined && i[key] !== forced[key]) {
        // A value survived the allow-list (the field opted in with
        // `writable: true`) and disagrees with the scope. Writing the safe
        // value anyway is the tempting implementation and it hides a forged
        // request behind a successful mutation; refuse instead.
        throw new ScopeDeniedError(defName, operation);
      }
      i[key] = forced[key];
    }
  }
  return i;
}

// ---------------------------------------------------------------------------
// processRelationshipMutation
// ---------------------------------------------------------------------------

/**
 * Apply the relationship sub-mutations nested under each association name of
 * `input` to a row that was just created, updated or selected. The verbs
 * themselves are a table in `../relationship-mutations`.
 */
export async function processRelationshipMutation(
  self: MutationEntryHost,
  defName: string, source: AdapterRow, input: MutationInputTree | undefined,
  context: RequestContext, selection?: Selection,
): Promise<AdapterRow> {
  return applyRelationshipMutations(self.host, defName, source, input, context,
    createResolveContext(context, selection, source), selection);
}

// ---------------------------------------------------------------------------
// applyInstanceTransforms
// ---------------------------------------------------------------------------

/**
 * Run the pre-commit instance-method transforms an `apply` argument asked for,
 * and fold what they wrote into the values about to be persisted.
 *
 * `this` inside a transform is the thing being written: on update the live row
 * (so it can read columns it did not receive), on create the pending values
 * (no row exists yet). A transform may either return an object to merge or
 * assign to `this` directly — on update the direct writes have to be captured,
 * because the adapter persists the values map rather than whatever the row
 * happens to have changed, hence the recording proxy.
 *
 * Called from inside {@link mutationEntry}, so a throw here rolls the whole
 * mutation back — relationship writes included.
 */
export async function applyInstanceTransforms(
  self: MutationEntryHost,
  defName: string,
  definition: Definition,
  apply: { [methodName: string]: unknown } | undefined,
  row: AdapterRow | undefined,
  values: MutationInput,
  args: unknown,
  context: RequestContext,
  info: unknown,
): Promise<MutationInput> {
  const requested = apply ? Object.keys(apply) : [];
  if (requested.length === 0) {
    return values;
  }
  const methods = mutationInstanceMethods(definition);
  const written: MutationInput = {};
  // Same shape as `InstanceRow` — the row is reached through members named
  // only at runtime (a Sequelize accessor bound to the real receiver, or
  // whatever field a transform reads/writes).
  const target: InstanceRow | MutationInput = row === undefined ? values : new Proxy(row as InstanceRow, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      // Methods have to keep seeing the real row as their receiver, or a
      // Sequelize accessor would run against the proxy and re-enter the trap.
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, p, v) {
      if (typeof p === "string") {
        written[p] = v;
      }
      return Reflect.set(t, p, v, t);
    },
  });
  // `requested.length === 0` already returned above, so `apply` is defined
  // from here on; the assertion just recovers that for the type checker.
  const applyMap = apply as { [methodName: string]: unknown };
  for (const methodName of requested) {
    const value = applyMap[methodName];
    // A no-arg transform is a `Boolean` flag; naming it without asking for it
    // is not a request to run it.
    if (value === false || value === null || value === undefined) {
      continue;
    }
    const entry = methods[methodName];
    if (!entry) {
      throw new Error(`ormize: "${defName}.${methodName}" is not exposed as an instance-method transform.`);
    }
    // The same merged view the adapter installs onto the model prototype.
    const implementation = definitionMethods(definition, "instanceMethods")[methodName];
    if (typeof implementation !== "function") {
      throw new Error(`ormize: instance-method transform "${defName}.${methodName}" is exposed but the model declares no such instance method.`);
    }
    let methodArgs: unknown = value === true ? {} : value;
    if (entry.before) {
      methodArgs = await entry.before({
        params: methodArgs, args, context, info,
        modelDefinition: definition,
        type: row === undefined ? Events.MUTATION_CREATE : Events.MUTATION_UPDATE,
      });
    }
    let result = await implementation.call(target, methodArgs, context);
    if (entry.after) {
      result = await entry.after(result, context);
    }
    // Assigning through `target` keeps a later transform in the same mutation
    // reading what an earlier one wrote, whichever way it wrote it.
    if (result && typeof result === "object" && !Array.isArray(result)) {
      Object.assign(target, result);
    }
  }
  // Both writes stay in place. `target` is either the recording proxy over the
  // live row or the values bag itself, and the sequencing above depends on a
  // later transform seeing what an earlier one wrote. `values` is never the
  // caller's: `processInputs` reduces into a fresh object on both the create
  // and the update path.
  return row === undefined ? values : Object.assign(values, written);
}

// ---------------------------------------------------------------------------
// The four process* entry points
// ---------------------------------------------------------------------------

/** No-op row transform shared by processDelete and processRestore. */
const identityRow = (model: AdapterRow) => model;

/**
 * Build the `before` callback processDelete and processRestore both hand to the
 * adapter's delete/restore function. Returns `model` unchanged when the
 * definition has no `before` hook; otherwise fires it with the given event type.
 */
function makeDefinitionBeforeHook(
  definition: Definition, args: unknown, context: RequestContext,
  selection: Selection | undefined, type: Events,
) {
  return (model: AdapterRow) => {
    if (!definition.before) {
      return model;
    }
    return definition.before({
      params: model, args, context, info: selection?.raw,
      model, modelDefinition: definition, type,
    });
  };
}

export async function processCreate(
  self: MutationEntryHost,
  defName: string, source: AdapterRow, args: { input: MutationInputTree; apply?: MutationApply },
  context: RequestContext, selection?: Selection,
): Promise<AdapterRow[]> {
  return mutationEntry(self, defName, context, selection, async({context, adapter, definition, globalKeys, idTargets, translateFilter}) => {
    const processCreateFn = adapter.getCreateFunction(defName);
    if (await resolveRowScope(self, defName, "create", context) === false) {
      // No row may be created at all. `processInputs` still forces whatever
      // `set` a *live* scope carries; this is the outright deny, which has no
      // values to force.
      scopeMissFn(defName, "create", self.onScopeMiss);
      return [];
    }
    const i = await processInputs(self, defName, args.input, args, context, selection?.raw);
    let input = translateFilter(i, globalKeys, idTargets);
    if (definition.before) {
      input = await definition.before({
        params: input, args, context, info: selection?.raw,
        modelDefinition: definition,
        type: Events.MUTATION_CREATE,
      });
    }
    input = await applyInstanceTransforms(self, defName, definition, args.apply, undefined, input, args, context, selection?.raw);
    if (Object.keys(input).length > 0) {
      let result = await processCreateFn(input, createResolveContext(context, selection, source));
      if (result !== undefined && result !== null) {
        result = await processRelationshipMutation(self, defName, result, args.input, context, selection);
        // F6. `processInputs` forced whatever the create scope's `set` names,
        // but `definition.before`, `override.input` and the nested `add`/`set`
        // verbs all run after it — the last of those re-points a foreign key
        // nobody named. Cheaper to look than to reason about the ordering.
        await assertRowsInScope(self, defName, "create", context, [result], createResolveContext(context, selection, source));
        return [result];
      }
    }
    return [];
  });
}

export async function processUpdate(
  self: MutationEntryHost,
  defName: string, source: AdapterRow,
  args: { input: MutationInputTree; where: MutationFilter; limit?: number; apply?: MutationApply },
  context: RequestContext, selection?: Selection,
): Promise<AdapterRow[]> {
  return mutationEntry(self, defName, context, selection, async({context, adapter, definition, globalKeys, idTargets, translateFilter}) => {
    const translateId = selection?.translateId || ((v: unknown) => v);
    const processUpdateFn = adapter.getUpdateFunction(defName, whereOperatorsFor(definition));
    let i: MutationInput = Object.keys(args.input).reduce((o, k) => {
      if (globalKeys.indexOf(k) > -1) {
        let v = args.input[k];
        // A global-id argument may arrive as a thunk over the operation's
        // variables — gqlize defers relay id translation that way.
        if (typeof v === "function") {
          v = v(selection?.variableValues);
        }
        if (v === null || v === undefined) {
          o[k] = null;
        } else {
          o[k] = translateId(v, k);
        }
      } else {
        o[k] = args.input[k];
      }
      return o;
    }, {} as MutationInput);
    // A read scope alone is a false sense of security: the caller cannot see
    // the row but can still name its id here. Merged after `translateFilter`,
    // which decodes the *caller's* opaque ids — the scope's values are already
    // raw, and a codec handed one would corrupt whatever it half recognised.
    const scoped = await scopedWriteWhere(self, defName, "update", context, translateFilter(args.where, globalKeys, idTargets));
    if (scoped === false) {
      scopeMissFn(defName, "update", self.onScopeMiss);
      return [];
    }
    // The cast keeps the pre-existing shape: `getUpdateFunction` declares a
    // non-optional filter, and an absent `args.where` already reached it as
    // `undefined` before this line existed. Substituting `{}` would be a
    // behaviour change on a delete-shaped path, which is not this commit.
    const where = scoped as MutationFilter;
    if (definition.before) {
      // Unlike the query hook, this one is handed the *input* and returns it;
      // `where` is already built and out of its reach, so there is nothing to
      // re-assert here (compare F3 in `resolveFindAll`).
      i = await definition.before({
        params: i, args, context, info: selection?.raw,
        modelDefinition: definition,
        type: Events.MUTATION_UPDATE,
      });
    }
    const results = await processUpdateFn(where, async(model) => {
      const values = await processInputs(self, defName, i, args, context, selection?.raw, model);
      return applyInstanceTransforms(self, defName, definition, args.apply, model, values, args, context, selection?.raw);
    }, createResolveContext(context, selection, source, {limit: args.limit}));
    await waterfall(results, async(r: AdapterRow) => {
      await processRelationshipMutation(self, defName, r, args.input, context, selection);
    });
    // F6. The filter above decided which rows may be written; this decides
    // whether the write left them where it found them. A scope filtering on a
    // column the caller may also write is the ordinary case, not a corner one.
    await assertRowsInScope(self, defName, "update", context, results, createResolveContext(context, selection, source));
    return results;
  });
}

export async function processSelect(
  self: MutationEntryHost,
  defName: string, source: AdapterRow,
  args: { input?: MutationInputTree; where?: MutationFilter; limit?: number },
  context: RequestContext, selection?: Selection,
): Promise<AdapterRow[]> {
  // Find matching elements and run relationship mutations on them via `args.input`
  // WITHOUT modifying the elements themselves (no field write / lifecycle change);
  // scalar fields in `input` are ignored. Returns the found rows so the caller can
  // select fields back.
  return mutationEntry(self, defName, context, selection, async({context, adapter, definition, globalKeys, idTargets, translateFilter}) => {
    const options = createResolveContext(context, selection, source, {limit: args.limit});
    // `select` writes no field, so it is easy to mistake for a read. It runs
    // relationship sub-mutations against every row its filter matches, which
    // makes it an update in everything but name — a layer that scoped only
    // update and delete leaves this one open.
    const scoped = await scopedWriteWhere(self, defName, "update", context, translateFilter(args.where, globalKeys, idTargets));
    if (scoped === false) {
      scopeMissFn(defName, "update", self.onScopeMiss);
      return [];
    }
    const where = await adapter.processFilterArgument(scoped, whereOperatorsFor(definition), options);
    const results = await adapter.findAll(defName, Object.assign({where, limit: args.limit}, options));
    await waterfall(results, async(r: AdapterRow) => {
      await processRelationshipMutation(self, defName, r, args.input, context, selection);
    });
    return results;
  });
}

export async function processDelete(
  self: MutationEntryHost,
  defName: string, source: AdapterRow, args: MutationFilter,
  context: RequestContext, selection?: Selection,
): Promise<AdapterRow[]> {
  return mutationEntry(self, defName, context, selection, async({context, adapter, definition, globalKeys, idTargets, translateFilter}) => {
    const processDeleteFn = adapter.getDeleteFunction(defName, whereOperatorsFor(definition));
    const scoped = await scopedWriteWhere(self, defName, "delete", context, translateFilter(args, globalKeys, idTargets));
    if (scoped === false) {
      scopeMissFn(defName, "delete", self.onScopeMiss);
      return [];
    }
    return processDeleteFn(
      scoped as MutationFilter,
      createResolveContext(context, selection, source),
      makeDefinitionBeforeHook(definition, args, context, selection, Events.MUTATION_DELETE),
      identityRow,
    );
  });
}

/**
 * Undelete soft-deleted rows. The mirror of {@link processDelete}, but scoped
 * as an **update**: a restore changes a row that is already there rather than
 * removing one, which is the same reading `VERB_OPERATIONS.restore` and the
 * `beforeRestore` hook mapping already take.
 *
 * Only available on a model whose adapter soft-deletes — there is nothing for
 * it to undo otherwise, and gqlize does not generate the mutation at all.
 */
export async function processRestore(
  self: MutationEntryHost,
  defName: string, source: AdapterRow, args: MutationFilter,
  context: RequestContext, selection?: Selection,
): Promise<AdapterRow[]> {
  return mutationEntry(self, defName, context, selection, async({context, adapter, definition, globalKeys, idTargets, translateFilter}) => {
    if (!adapter.getRestoreFunction) {
      throw new Error(`restore is not supported by the adapter backing ${defName}`);
    }
    const processRestoreFn = adapter.getRestoreFunction(defName, whereOperatorsFor(definition));
    const scoped = await scopedWriteWhere(self, defName, "update", context, translateFilter(args, globalKeys, idTargets));
    if (scoped === false) {
      scopeMissFn(defName, "update", self.onScopeMiss);
      return [];
    }
    // `Events.MUTATION_UPDATE` rather than an event of its own: a new member
    // is a surface change every exhaustive hook has to learn, and treating a
    // restore as an update is already this codebase's position everywhere
    // else it has had to choose.
    const results = await processRestoreFn(
      scoped as MutationFilter, createResolveContext(context, selection, source),
      makeDefinitionBeforeHook(definition, args, context, selection, Events.MUTATION_UPDATE),
      identityRow,
    );
    // The same re-check `processUpdate` makes, for the same reason: the filter
    // decided which rows could be written, this decides whether the write left
    // them where it found them.
    await assertRowsInScope(self, defName, "update", context, results, createResolveContext(context, selection, source));
    return results;
  });
}
