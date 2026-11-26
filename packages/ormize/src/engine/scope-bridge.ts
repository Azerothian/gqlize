// Row-scope helpers that bridge the Ormize class to the scope module.
//
// These functions mediate between the class's state (permission, adapters,
// definitions) and the pure scope logic in `../scope.ts`.

import { whereOperatorsFor } from "@azerothian/utilize/exposed-methods";
import type { Permission, PortableWhere, ResolvedScope, ScopeOperation } from "@azerothian/utilize/gate";
import {
  resolveViaMarkers, collectQuantifierTargets, parseQuantifier, LOGICAL_OPERATORS,
  ScopeConfigurationError, THROUGH_SCOPE_KEY, mergeScopeWhere,
} from "@azerothian/utilize/gate";
import { applyScopeWhere, scopeFor, scopeMiss, markSystemQuery } from "../scope";
import type { ScopeMissBehaviour } from "../scope";
import { ScopeDeniedError, ScopeEscapeError } from "../scope";
import { filterMerger } from "../cross-adapter";
import { resolveGlobalFilters } from "./global-filters";
import type { OrmAdapter, AdapterQueryOptions, AdapterWhere, RequestContext } from "@azerothian/utilize/types/index";
import type { Definition } from "../types";
import type { MutationHost } from "../types/engine";

// ---------------------------------------------------------------------------
// Host interface — what the scope helpers read from the class
// ---------------------------------------------------------------------------

/** The narrow slice of the `Ormize` class the scope-bridge helpers need. */
export interface ScopeHost {
  permission: Permission | undefined;
  onScopeMiss: ScopeMissBehaviour;
  defs: { [name: string]: Definition };
  defsAdapters: { [name: string]: string };
  adapters: { [name: string]: OrmAdapter };
  host: MutationHost;
  getModelAdapter(modelName: string): OrmAdapter;
  getDefinition(defName: string): Definition;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `permission.scope` for one model and operation.
 *
 * `undefined` imposes nothing, `false` denies every row, anything else is the
 * filter (and, for writes, the values) to apply. Memoised per request inside
 * {@link scopeFor} — a nested selection would otherwise re-run the predicate
 * once per parent row.
 *
 * After basic scope resolution, this resolves any `__via` markers the scope
 * sugar emitted into proper quantifier nesting using the association graph,
 * and checks that no quantifier crosses adapter boundaries.
 */
export async function resolveRowScope(self: ScopeHost, defName: string, operation: ScopeOperation, context: RequestContext): Promise<ResolvedScope> {
  const resolved = await scopeFor(self.permission, defName, operation, context);
  if (resolved === undefined || resolved === false) {
    return resolved;
  }
  if (!resolved.where) {
    return resolved;
  }
  // Resolve __via markers into proper quantifier nesting.
  const associationInfo = (model: string, relName: string): { associationType: string; target: string } | undefined => {
    if (!self.defs[model]) {
      return undefined;
    }
    const assocs = self.host.getAssociations(model);
    const assoc = assocs[relName];
    if (!assoc) {
      return undefined;
    }
    return { associationType: assoc.associationType, target: assoc.target };
  };
  const resolvedWhere = resolveViaMarkers(resolved.where, defName, associationInfo);
  // Validate that no quantifier crosses adapter boundaries.
  const associations = (model: string) => {
    if (!self.defs[model]) {
      return {};
    }
    return self.host.getAssociations(model);
  };
  const targets = collectQuantifierTargets(resolvedWhere, defName, associations);
  const sourceAdapter = self.defsAdapters[defName];
  for (const target of targets) {
    const targetAdapter = self.defsAdapters[target];
    if (targetAdapter !== undefined && targetAdapter !== sourceAdapter) {
      throw new ScopeConfigurationError(
        `A relationship quantifier in the scope for '${defName}' reaches '${target}', ` +
        `which lives on a different adapter ('${targetAdapter}' vs '${sourceAdapter}'). ` +
        "One query cannot reach another database.",
      );
    }
  }
  return { ...resolved, where: resolvedWhere };
}

/**
 * Re-impose a scope on options that have already been translated into the
 * backend's vocabulary.
 *
 * Only needed where userland code has had a chance to rewrite `where` after
 * the portable merge. An adapter with no way to AND two native filters cannot
 * be scoped behind such a hook; running the query anyway would run it
 * unscoped, so this refuses instead.
 */
export async function reassertRowScope(
  self: ScopeHost,
  adapter: OrmAdapter, defName: string, where: PortableWhere,
  whereOperators: ReturnType<typeof whereOperatorsFor>, options: AdapterQueryOptions,
  targets: (AdapterQueryOptions | undefined)[],
  context?: RequestContext,
) {
  if (!adapter.andFilterStatements) {
    throw new Error(
      `Adapter '${adapter.adapterName}' cannot re-assert a row-level scope on '${defName}': ` +
      "it does not implement andFilterStatements, and '" + defName + "' has a `before` hook " +
      "that could have rewritten the filter. Implement andFilterStatements, or drop the hook.",
    );
  }
  // Also reassert global filters: a `before` hook may have rewritten the
  // filter, dropping them too.
  const gf = resolveModelGlobalFilters(self, defName, "read");
  const combined = gf ? mergeScopeWhere(where, gf) : where;
  const embedded = context ? await embedThroughScopes(self, defName, combined, context) : combined;
  const native = await adapter.processFilterArgument(embedded, whereOperators, options, defName);
  for (const target of targets) {
    if (target) {
      // In place on purpose. These are the adapter's own options bags, built
      // by `processListArgsToOptions` and about to be executed; re-imposing
      // the scope *after* a `before` hook may have rewritten the filter is
      // the whole job. A copy would have to be rebound by every caller, and
      // a caller that forgot would run the query unscoped.
      target.where = adapter.andFilterStatements(target.where, native);
    }
  }
}

/**
 * A model's scope for one operation, in its adapter's vocabulary, ANDed onto
 * `where`. Used by cross-adapter accessors that need the native shape rather
 * than the portable one.
 */
export async function scopeNativeWhere(
  self: ScopeHost,
  defName: string, operation: ScopeOperation, context: RequestContext,
  where: AdapterWhere | undefined, options: AdapterQueryOptions | undefined,
): Promise<AdapterWhere | undefined | false> {
  const resolved = await resolveRowScope(self, defName, operation, context);
  if (resolved === false) {
    return false;
  }
  // Global filters (RFC §5), merged alongside scope in native vocabulary.
  const gf = resolveModelGlobalFilters(self, defName, operation);
  const scopeWhere = resolved?.where;
  const combined = gf
    ? (scopeWhere ? mergeScopeWhere(gf, scopeWhere) : gf)
    : scopeWhere;
  if (!combined) {
    return where;
  }
  const adapter = self.getModelAdapter(defName);
  const embedded = await embedThroughScopes(self, defName, combined, context);
  const native = await adapter.processFilterArgument(
    embedded, whereOperatorsFor(self.getDefinition(defName)), options || {}, defName,
  );
  if (!where) {
    return native;
  }
  if (!adapter.andFilterStatements) {
    throw new Error(
      `Adapter '${adapter.adapterName}' cannot scope a cross-adapter relationship on '${defName}': ` +
      "it does not implement andFilterStatements, and a row-level scope has to be ANDed onto the join filter.",
    );
  }
  return adapter.andFilterStatements(where, native);
}

/**
 * The portable filter a root write runs under: the caller's, ANDed with the
 * model's **read** scope as well as the operation's own. `false` when either
 * half denies outright.
 *
 * Reaching a row is a read whatever happens to it next. The nested verbs
 * (`applyRelationshipMutations`) and the cross-adapter instance checks
 * (`writable`) have both required the read half since they were written;
 * without this the root verbs would be the one path left where naming a row
 * you are not allowed to *see* is enough to write it.
 */
export async function scopedWriteWhere(
  self: ScopeHost,
  defName: string, operation: ScopeOperation, context: RequestContext,
  userWhere: PortableWhere | undefined,
): Promise<PortableWhere | undefined | false> {
  let own = await resolveRowScope(self, defName, operation, context);
  if (own === false) {
    return false;
  }
  let read = await resolveRowScope(self, defName, "read", context);
  if (read === false) {
    return false;
  }
  // Embed through-scopes so quantifiers on btm relationships carry the join
  // model's read scope when the merged where reaches processFilterArgument.
  if (own?.where) {
    const embedded = await embedThroughScopes(self, defName, own.where, context);
    if (embedded !== own.where) {
      own = { ...own, where: embedded };
    }
  }
  if (read?.where) {
    const embedded = await embedThroughScopes(self, defName, read.where, context);
    if (embedded !== read.where) {
      read = { ...read, where: embedded };
    }
  }
  // Composition order: clientWhere AND globalFilters AND scope.
  let merged = userWhere;
  const gf = resolveModelGlobalFilters(self, defName, operation);
  if (gf) {
    merged = mergeScopeWhere(merged, gf);
  }
  return applyScopeWhere(applyScopeWhere(merged, read), own);
}

/**
 * F6. Assert every row a write just produced still satisfies the scope.
 *
 * A scope's `set` forces the fields it *names*; nothing forces the fields it
 * *filters on*. An update naming a writable column — or an `add`/`set` verb
 * re-pointing a foreign key, which writes no column the caller named at all —
 * can carry a row from inside the principal's slice to outside it. By then
 * there is no filter left to merge into, so the rows are read back and the
 * scope asked again.
 *
 * Always throws, whatever `onScopeMiss` says. The quiet path exists so that a
 * refused write is indistinguishable from one that matched no rows, and that
 * equivalence is gone here: the row *was* written. Inside `orm.transaction()`
 * the throw rolls it back; outside one, the caller is at least told plainly
 * that it did not.
 */
export async function assertRowsInScope(
  self: ScopeHost,
  defName: string, operation: ScopeOperation, context: RequestContext,
  rows: import("@azerothian/utilize/types/index").AdapterRow[], options: AdapterQueryOptions | undefined,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  // The pair the write ran under, asked again. An update reached an existing
  // row, and reaching one is a read, so it answers to both halves. A create
  // reached nothing — and a principal allowed to add rows to a model it may
  // not read back is a legitimate arrangement that asking the read scope here
  // would quietly ban.
  let where = operation === "create"
    ? undefined
    : await scopeNativeWhere(self, defName, "read", context, undefined, options);
  if (where !== false) {
    where = await scopeNativeWhere(self, defName, operation, context, where, options);
  }
  if (where === false) {
    // Not reachable from today's call sites — every one of them refuses an
    // outright deny before writing anything — but it is the other half of
    // what `scopeNativeWhere` returns, and once a row has been written
    // "no row can satisfy this" has exactly one honest answer.
    throw new ScopeEscapeError(defName, operation);
  }
  if (where === undefined) {
    // Neither half imposes a filter, so every row satisfies it by
    // construction — and reading them back would cost an extra query per
    // mutation on every unscoped deployment in exchange for no answer.
    return;
  }
  const adapter = self.getModelAdapter(defName);
  const [pk] = adapter.getPrimaryKeyNameForModel(defName);
  const ids = rows.map((r) => adapter.getValueFromInstance(r, pk));
  const found = await adapter.findAll(defName, markSystemQuery({
    ...(options?.transaction !== undefined ? {transaction: options.transaction} : {}),
    where: filterMerger(self.host, defName)(pk, ids, true, where),
    limit: ids.length,
  }));
  if (found.length < ids.length) {
    throw new ScopeEscapeError(defName, operation);
  }
}

/**
 * Hand a request context the resolved scope, for the surfaces S12 names.
 *
 * A `scopeAware` method has claimed it will apply the filter itself, and this
 * is where it gets one. Backed by the same per-request memo every other call
 * site uses, so a method that asks costs nothing extra.
 *
 * Non-enumerable, and only ever added: the context belongs to the host, and a
 * key that showed up in `Object.keys` would reach anything that serialises or
 * spreads it. Defined rather than assigned for the same reason `markSystemQuery`
 * is — a property `args` cannot carry is a property a request cannot forge.
 */
export function withScopeFor<T>(self: ScopeHost, context: T): T {
  if (!context || typeof context !== "object" || typeof self.permission?.scope !== "function") {
    return context;
  }
  const target = context as { scopeFor?: unknown };
  if (target.scopeFor !== undefined) {
    return context;
  }
  Object.defineProperty(target, "scopeFor", {
    value: (defName: string, operation: ScopeOperation = "read") =>
      resolveRowScope(self, defName, operation, context as RequestContext),
    enumerable: false, writable: false, configurable: true,
  });
  return context;
}

// ---------------------------------------------------------------------------
// Through-scope embedding
// ---------------------------------------------------------------------------

/**
 * Walk a scope's portable where and, for each `belongsToMany` quantifier
 * whose association has a registered `throughModel`, resolve the join model's
 * read scope and embed it under the `__throughScope` key alongside the
 * quantifier key. The adapter reads it in the subquery compiler.
 *
 * Through-scopes that themselves contain quantifiers are embedded recursively
 * (they will be compiled by the adapter's relationship-filter compiler).
 *
 * This runs in the engine, where scope resolution and the association graph
 * are available, so the adapter never needs either.
 */
export async function embedThroughScopes(
  self: ScopeHost,
  defName: string,
  where: PortableWhere | undefined,
  context: RequestContext,
): Promise<PortableWhere | undefined> {
  if (!where || typeof where !== "object") {
    return where;
  }
  const associations = self.defs[defName] ? self.host.getAssociations(defName) : {};
  const result: PortableWhere = {};
  let changed = false;
  for (const key of Object.keys(where)) {
    const lower = key.toLowerCase();
    if (LOGICAL_OPERATORS.has(lower)) {
      const branch = where[key];
      if (Array.isArray(branch)) {
        const mapped = await Promise.all(
          branch.map((b) => embedThroughScopes(self, defName, b as PortableWhere, context)),
        );
        if (mapped.some((m, i) => m !== branch[i])) {
          changed = true;
        }
        result[lower] = mapped;
      } else {
        const mapped = await embedThroughScopes(self, defName, branch as PortableWhere, context);
        if (mapped !== branch) {
          changed = true;
        }
        result[lower] = mapped;
      }
      continue;
    }
    const quantifier = parseQuantifier(where[key]);
    const association = associations[key];
    if (quantifier && association) {
      // Recurse into the inner filter for nested quantifiers on the target model.
      const innerEmbedded = await embedThroughScopes(self, association.target, quantifier.inner, context);
      if (association.associationType === "belongsToMany" && association.throughModel && association.through) {
        // Resolve the join model's read scope.
        const joinModel = association.through;
        const throughResolved = await resolveRowScope(self, joinModel, "read", context);
        let throughWhere: PortableWhere | false | undefined;
        if (throughResolved === false) {
          // A denying through-scope means no link qualifies. Carried as
          // `false`, which the adapter writes as a contradiction; a made-up
          // column here would turn "nothing qualifies" into a SQL error.
          throughWhere = false;
        } else if (throughResolved && throughResolved.where) {
          // The through-scope may itself contain quantifiers; embed their
          // through-scopes recursively.
          throughWhere = await embedThroughScopes(self, joinModel, throughResolved.where, context);
        }
        const quantifierValue: PortableWhere = { [quantifier.quantifier]: innerEmbedded || {} };
        if (throughWhere !== undefined) {
          quantifierValue[THROUGH_SCOPE_KEY] = throughWhere;
        }
        // Carry forward any existing __throughScope from an outer embedding.
        if (quantifier.throughScope !== undefined && throughWhere === undefined) {
          quantifierValue[THROUGH_SCOPE_KEY] = quantifier.throughScope;
        }
        result[key] = quantifierValue;
        changed = true;
      } else if (innerEmbedded !== quantifier.inner) {
        result[key] = { [quantifier.quantifier]: innerEmbedded || {} };
        if (quantifier.throughScope !== undefined) {
          (result[key] as PortableWhere)[THROUGH_SCOPE_KEY] = quantifier.throughScope;
        }
        changed = true;
      } else {
        result[key] = where[key];
      }
      continue;
    }
    result[key] = where[key];
  }
  return changed ? result : where;
}

// ---------------------------------------------------------------------------
// Global filter merging
// ---------------------------------------------------------------------------

/**
 * Resolve the global filters for one model and operation. `undefined` when no
 * filter applies (the common case for models without `options.filters`).
 *
 * This is a pure function over the definition and the current
 * `AsyncLocalStorage` bypass, so it needs no `context` and no memo.
 */
export function resolveModelGlobalFilters(self: ScopeHost, defName: string, operation: ScopeOperation): PortableWhere | undefined {
  const def = self.defs[defName];
  return resolveGlobalFilters(def, operation);
}

/**
 * Merge global filters into a portable where clause.  Called at every read and
 * write chokepoint between the client where and the scope merge.
 *
 * Order: `clientWhere AND globalFilters AND scope` (the AND is commutative,
 * but the order is fixed for a stable read-cache fingerprint).
 */
export function applyGlobalFilters(
  where: PortableWhere | undefined,
  self: ScopeHost,
  defName: string,
  operation: ScopeOperation,
): PortableWhere | undefined {
  const gf = resolveModelGlobalFilters(self, defName, operation);
  if (!gf) {
    return where;
  }
  return mergeScopeWhere(where, gf);
}

// Re-export the symbols the class needs without reaching into scope.ts itself.
export { ScopeDeniedError, ScopeEscapeError, scopeMiss };
