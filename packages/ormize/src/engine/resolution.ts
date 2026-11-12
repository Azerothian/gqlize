// Read resolution: the engine that turns a `resolveFindAll` or a relationship
// accessor call into adapter queries, counts, and pagination.
//
// Free functions over explicit host interfaces (see `ResolutionHost`).

import { whereOperatorsFor, expandOrderBy } from "@azerothian/utilize/exposed-methods";
import { clampPageSize } from "@azerothian/utilize/utils/page-size";
import { completeIncludePlan, toIncludeLevels } from "@azerothian/utilize/utils/include-plan";
import { applyScopeWhere } from "../scope";
import { scopeIncludePlan } from "../scope";
import { joinScope } from "../cross-adapter";
import { applyThroughRequired, assertThroughArgs, isThroughRead, resolveThroughRelationship } from "./through-reads";
import type {
  AdapterRow, AdapterQueryOptions, RequestContext,
  Selection, IncludeMap, FindAllArgs, OrderEntry, Association,
} from "@azerothian/utilize/types/index";
import type { PortableWhere } from "@azerothian/utilize/gate";
import type { MutationHost, ResolveOptions } from "../types/engine";
import Events from "../events";

import type { HookHost } from "./hooks";
import { runHook, applyEagerAfterFind } from "./hooks";
import type { ScopeHost } from "./scope-bridge";
import { resolveRowScope, reassertRowScope, withScopeFor } from "./scope-bridge";
import type { ReadCacheHost } from "./read-cache-bridge";
import { cachedCount, cachedFindAll } from "./read-cache-bridge";

// ---------------------------------------------------------------------------
// Host interface — the union of what the resolution helpers need
// ---------------------------------------------------------------------------

export interface ResolutionHost extends HookHost, ScopeHost, ReadCacheHost {
  host: MutationHost;
  defsAdapters: { [name: string]: string };
  optionsForAdapter<T extends AdapterQueryOptions | undefined>(fromDefName: string, toDefName: string, options: T): Promise<T>;
}

// ---------------------------------------------------------------------------
// Pure helpers (module-level, no host needed)
// ---------------------------------------------------------------------------

/**
 * A count over the same rows a fetch's options match, for a backend that counts
 * inline and so built no `countOptions` of its own.
 *
 * Derived by *removing* the keys that mean nothing to a count, rather than
 * whitelisting the few that do. A whitelist silently drops any adapter-specific
 * key that decides which rows match (Sequelize's `paranoid` is one), and then
 * `total` answers from a different row set than `edges` would have returned.
 * Only includes that filter the parent (required, joined) are kept.
 */
export function countableFrom(getOptions: AdapterQueryOptions): AdapterQueryOptions {
  const {limit: _l, offset: _o, order: _ord, attributes: _a, ...countable} = getOptions;
  return Object.assign({}, countable, {
    include: (getOptions.include || []).filter((i: {required?: boolean, separate?: boolean}) => i.required && !i.separate),
  });
}

// Build the resolve-context object passed to adapter fetch/mutation functions.
// Hooks read `options.getGraphQLArgs().info`; gqlize sets `selection.raw` to the
// real GraphQLResolveInfo so that behaviour is identical, while ormize itself
// stays graphql-free (it only forwards the opaque `raw`).
export function createResolveContext(context: RequestContext, selection: Selection | undefined, source: AdapterRow, options: AdapterQueryOptions = {}): ResolveOptions {
  const base: ResolveOptions = {
    getGraphQLArgs() {
      return {
        context,
        info: selection?.raw,
        source,
      };
    },
  };
  // Propagate an in-flight transaction (set by withTransaction) so every nested
  // Sequelize call — create/update/destroy/findAll and relationship accessors —
  // joins the same transaction and a multi-step mutation is atomic.
  if (context && context.transaction) {
    base.transaction = context.transaction;
  }
  return Object.assign(base, options);
}

// Cursor-based offset from decoded `after`/`before` args (shared by the top-level
// list resolver and the relationship resolver).
//
// `before` paging: offset so the window ends just before the cursor position.
// `args.limit` was never populated by the connection layer — it carries `first`
// and `last`, not `limit` — so the subtraction was a no-op and `before` returned
// rows AFTER the cursor.  Fixed to use `clampPageSize(first ?? last)` and the
// correct formula: `max(0, cursor.index - pageSize)`.
export function cursorOffset(args: FindAllArgs) {
  if (args.after) {
    return args.after.index + 1;
  }
  if (args.before) {
    const pageSize = clampPageSize(
      (args as Record<string, unknown>).first != null
        ? (args as Record<string, unknown>).first
        : (args as Record<string, unknown>).last,
    );
    return Math.max(0, args.before.index - pageSize);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Computed order expansion
// ---------------------------------------------------------------------------

/**
 * Rewrite any computed `orderBy` entry into the real column ordering it stands
 * for, at the root and at every level of the include plan.
 *
 * A generated `<method>ASC` enum member carries the method's own name rather
 * than a column, so this lookup is what makes it mean anything — deliberately
 * at runtime, so a materialized schema snapshot picks up a changed declaration
 * for free. Push-down only: the expansion produces query fragments, never an
 * in-memory post-sort (which would break `first`/`last`, cursor offsets and
 * `total`).
 */
export function expandComputedOrder(self: ResolutionHost, defName: string, a: FindAllArgs, ctx: {context?: unknown, info?: unknown}): FindAllArgs {
  const definition = self.getDefinition(defName);
  const orderBy = expandOrderBy(definition, a.orderBy as OrderEntry[] | undefined, ctx);
  const include = expandComputedIncludeOrder(self, a.include as IncludeMap[] | IncludeMap | undefined, ctx);
  if (orderBy === a.orderBy && include === a.include) {
    return a;
  }
  return {...a, orderBy, include};
}

/**
 * The same expansion, one level down and at every level below it.
 *
 * Returns a new plan rather than writing on the one it is given — the rule
 * {@link scopeIncludePlan} already states, and for a sharper reason here. An
 * include descriptor declared on a definition (`expose.instanceMethods.query.
 * <m>.include`) reaches this method as the definition's *own* object: the
 * merge path hands it through by identity when only one side declares a
 * relation. Writing the expansion onto it rewrote the declaration itself, so
 * the first request's ordering was frozen into the definition for the life of
 * the process and a context-dependent `orderBy` never ran a second time.
 *
 * Copy-on-write, not copy: `expandOrderBy` returns its input unchanged when
 * there is nothing to expand, so the steady state — every request that orders
 * by a real column — allocates nothing on what is a per-parent-row path.
 */
function expandComputedIncludeOrder(
  self: ResolutionHost,
  include: IncludeMap[] | IncludeMap | undefined,
  ctx: {context?: unknown, info?: unknown},
): IncludeMap[] | IncludeMap | undefined {
  if (!include) {
    return include;
  }
  const expandMap = (map: IncludeMap): IncludeMap => {
    let out: IncludeMap | undefined;
    for (const relName of Object.keys(map)) {
      const descriptor = map[relName];
      // Undefined for a target this engine does not own, which has nothing to
      // expand against. `getDefinition` indexes and does not throw — the
      // try/catch this replaces could never fire.
      const targetDef = self.getDefinition(descriptor.target);
      const orderBy = expandOrderBy(targetDef, descriptor.orderBy, ctx);
      const nested = expandComputedIncludeOrder(self, descriptor.include, ctx);
      if (orderBy === descriptor.orderBy && nested === descriptor.include) {
        continue;
      }
      out = out || {...map};
      out[relName] = {...descriptor, orderBy, include: nested as IncludeMap[] | undefined};
    }
    return out || map;
  };
  if (!Array.isArray(include)) {
    return expandMap(include);
  }
  let changed = false;
  const mapped = include.map((map) => {
    const expanded = expandMap(map);
    changed = changed || expanded !== map;
    return expanded;
  });
  return changed ? mapped : include;
}

// ---------------------------------------------------------------------------
// Relationship resolution
// ---------------------------------------------------------------------------

/**
 * A cross-adapter relationship is just a root query on the target model scoped
 * to the join key — the target's adapter cannot see the source's rows, so there
 * is nothing to JOIN and no accessor to call. Routing it through
 * {@link resolveFindAll} keeps `where`, ordering, pagination, count-only and
 * the target model's own hooks behaving exactly as they do at the root.
 */
async function resolveCrossAdapterRelationship(self: ResolutionHost, defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection) {
  const scope = await joinScope(self.host, association, source, context);
  const empty = scope.value === undefined || scope.value === null
    || (Array.isArray(scope.value) && scope.value.length === 0);
  if (scope.field === undefined || empty) {
    return {total: 0, models: []};
  }
  // The query runs on the target's adapter, so any transaction handle carried by
  // the (source-side) context has to be swapped for that adapter's own.
  const targetContext = await self.optionsForAdapter(association.source, defName, context);
  return resolveFindAll(self, defName, source, args, targetContext, selection, scope);
}

export async function resolveManyRelationship(self: ResolutionHost, defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection) {
  assertThroughArgs(association, args, selection);
  if (isThroughRead(association)) {
    // Join rows first, then targets — on every adapter, cross-adapter included
    // (see `through-reads.ts`). Ahead of the cross-adapter branch, which it
    // generalises: that one only ever reads the keys off the join rows.
    return resolveThroughRelationship(self, resolveFindAll, defName, association, source, args, context, selection);
  }
  if (association.crossAdapter) {
    // Routed through `resolveFindAll`, which scopes the target itself.
    return resolveCrossAdapterRelationship(self, defName, association, source, args, context, selection);
  }
  // F4. `defName` is the *target* model here, and this is the branch that runs
  // when the relationship was not eager-loaded: the accessor query and the
  // `total` count both derive from `args.where`, so merging here covers both.
  // The eager branch is covered upstream, in the include plan.
  const rowScope = await resolveRowScope(self, defName, "read", context);
  if (rowScope === false) {
    return { total: 0, models: [] };
  }
  const options = createResolveContext(context, selection, source);
  const adapter = self.getModelAdapter(defName);
  const definition = self.getDefinition(defName);
  // Copy-on-write from here: `args` is the caller's bag, and the scope merge
  // and the order expansion both used to write onto it in place. Nothing
  // downstream needs the caller to see the rewrite — everything that consumes
  // it is handed `a` explicitly.
  let a = args;
  if (rowScope?.where) {
    a = {...a, where: applyScopeWhere(a.where as PortableWhere | undefined, rowScope)};
  }
  // A nested connection's own `include` argument goes to the adapter's
  // per-parent query: normalised as at the root, and a through-mode relation in
  // it is a key filter here rather than an adapter JOIN.
  if (a.include !== undefined) {
    a = {...a, include: completeIncludePlan(toIncludeLevels(a.include), defName, (n) => self.getAssociations(n))};
    const throughFiltered = await applyThroughRequired(self, defName, a, context, selection);
    if (throughFiltered === false) {
      return { total: 0, models: [] };
    }
    a = throughFiltered;
  }
  a = expandComputedOrder(self, defName, a, {context, info: selection?.raw});
  const offset = cursorOffset(args);
  // --- Backward pagination adjustments for relationships ----------------
  // Clamp the effective page size when paging backward so the window does
  // not overshoot past the cursor position (same logic as resolveFindAll).
  if (args.before) {
    const relArgs = a as Record<string, unknown>;
    const pageSize = clampPageSize(relArgs.first != null ? relArgs.first : relArgs.last);
    const clamped = Math.min(pageSize, args.before.index);
    // Rewrite first/last to the clamped value — processListArgsToOptions and
    // the in-memory slice both read these.
    if (relArgs.first != null) {
      a = {...a, first: clamped};
    } else {
      a = {...a, last: clamped};
    }
  }
  // `last` without a cursor on a relationship: count first, then offset from
  // the end — the same strategy as resolveFindAll. The adapter's eager path
  // loaded from offset 0, so the models are the wrong page; passing the right
  // offset forces the non-eager (accessor query) path.
  let effectiveOffset = offset;
  if ((a as Record<string, unknown>).last != null && !args.after && !args.before && (a as Record<string, unknown>).first == null) {
    const lastPageSize = clampPageSize((a as Record<string, unknown>).last);
    const countResult = await adapter.resolveManyRelationship(defName, association, source, {
      args: a, offset: undefined, selection, whereOperators: whereOperatorsFor(definition), options,
      countOnly: true, selectedFields: selection?.fields, runHook: (d, h, v, ...rest) => runHook(self, d, h, v, ...rest),
    });
    effectiveOffset = Math.max(0, countResult.total - lastPageSize);
  }
  // --------------------------------------------------------------------
  // Count-only: the nested connection selects `total` but not `edges`/rows — the
  // adapter runs a count instead of a findAll (fires beforeCount natively); fire
  // afterCount here.
  const countOnly = Boolean(selection?.countOnly);
  const result = await adapter.resolveManyRelationship(defName, association, source, {
    args: a, offset: effectiveOffset, selection, whereOperators: whereOperatorsFor(definition), options, countOnly,
    selectedFields: selection?.fields, runHook: (d, h, v, ...rest) => runHook(self, d, h, v, ...rest),
  });
  if (countOnly && result) {
    result.total = await runHook(self, defName, "afterCount", result.total, options);
  }
  // afterFind for JOIN-eager loads is fired centrally by resolveFindAll's
  // post-pass (which knows JOIN vs separate authoritatively). A fresh accessor
  // query and the separate path both fire it natively.
  return result;
}

export async function resolveSingleRelationship(self: ResolutionHost, defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection) {
  if (association.crossAdapter) {
    // `countOnly` is inferred from a connection's selection set; a singular
    // relation has no `edges`, so the inference misreads it. It always wants
    // the row.
    const single = selection ? {...selection, countOnly: false} : selection;
    const {models} = await resolveCrossAdapterRelationship(self, defName, association, source, {...args, first: 1}, context, single);
    return models[0] || null;
  }
  const rowScope = await resolveRowScope(self, defName, "read", context);
  if (rowScope === false) {
    return null;
  }
  const adapter = self.getModelAdapter(defName);
  const options = createResolveContext(context, selection, source);
  if (rowScope?.where) {
    // A singular relationship never reads `args.where` — the accessor is called
    // with the options bag alone — so the scope goes there, already translated
    // into the backend's vocabulary. The eager branch ignores the bag entirely
    // and is covered upstream by the include plan.
    //
    // Written in place, and not a caller's object: `createResolveContext`
    // builds a fresh bag on every call.
    options.where = await adapter.processFilterArgument(
      applyScopeWhere(options.where as PortableWhere | undefined, rowScope),
      whereOperatorsFor(self.getDefinition(defName)),
      options,
    );
  }
  // afterFind for JOIN-eager single relations is fired by resolveFindAll's post-pass.
  return adapter.resolveSingleRelationship(defName, association, source, {args, selection, context, options});
}

// ---------------------------------------------------------------------------
// resolveClassMethod
// ---------------------------------------------------------------------------

export async function resolveClassMethod(self: ResolutionHost, defName: string, methodName: string, args: unknown, context: RequestContext,
  before?: (args: unknown, context: RequestContext) => unknown,
  after?: (result: unknown, context: RequestContext) => unknown) {
  const Model = self.getModelAdapter(defName).getModel(defName);
  context = withScopeFor(self, context);
  if(before) {
    args = await before(args, context);
  }
  let result = await Model[methodName](args, context);
  if(after) {
    result = await after(result, context);
  }
  return result;
}

// ---------------------------------------------------------------------------
// resolveFindAll — the main list resolver
// ---------------------------------------------------------------------------

/**
 * @param scope optional `{field, value}` equality filter merged into the built
 * query on top of the caller's `where`. Used to scope a cross-adapter
 * relationship to its join key.
 */
export async function resolveFindAll(self: ResolutionHost, defName: string, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection, scope?: {field: string, value: unknown}) {
  const definition = self.getDefinition(defName);
  const adapter = self.getModelAdapter(defName);
  const options = createResolveContext(context, selection, source);
  // Copy-on-write from here: `args` is the caller's bag. Everything that
  // consumes the rewritten form is handed `a` explicitly, so nothing needs the
  // caller's object to change underneath it.
  let a = args;
  const selectedFields = selection?.fields;
  // The eager-include plan is built by the caller (gqlize, from the GraphQL
  // selection set) and passed via `selection.include`; apply it when the args
  // don't already carry one.
  if (selection?.include && !a.include) {
    a = {...a, include: selection.include};
  }
  // One shape from here on: a list of complete descriptors, whatever shape the
  // `include` argument had (a single object on an `includeIsList = false`
  // adapter) and whatever a client left out of its descriptors (#68).
  if (a.include !== undefined) {
    a = {...a, include: completeIncludePlan(toIncludeLevels(a.include), defName, (n) => self.getAssociations(n))};
  }
  // F4. An eagerly-loaded relationship is fetched by *this* query, so its own
  // resolver never gets a filter in edgeways — the include plan is the only
  // place its model's scope can be applied.
  const scopedInclude = await scopeIncludePlan(
    a.include as IncludeMap[] | undefined,
    (targetName) => resolveRowScope(self, targetName, "read", context),
    // "No rows", in the include's own vocabulary: the target's key `in []`.
    // Lets a `required` relation whose model is denied outright still filter
    // its parent rather than vanish from the plan.
    (targetName) => {
      const [pk] = self.getModelAdapter(targetName).getPrimaryKeyNameForModel(targetName);
      return pk ? {[pk]: {in: []}} : undefined;
    },
  );
  if (scopedInclude !== a.include) {
    a = {...a, include: scopedInclude};
  }
  // After the scope pass, so a required link's target is already scoped: the
  // through-mode descriptors become a key filter on this query.
  const throughFiltered = await applyThroughRequired(self, defName, a, context, selection);
  if (throughFiltered === false) {
    return { total: 0, models: [] };
  }
  a = throughFiltered;
  a = expandComputedOrder(self, defName, a, {context, info: selection?.raw});
  // Row-level scope, merged while the filter is still in the caller's
  // vocabulary. That is also what gives the count the same filter, since
  // `processListArgsToOptions` derives `countOptions` from these args — a
  // scope applied only to the fetch leaves `total` counting rows the caller
  // is not allowed to see.
  const rowScope = await resolveRowScope(self, defName, "read", context);
  if (rowScope === false) {
    // Denied outright. There is no portable filter for "match nothing" (§9.4
    // of the design rejects `{in: []}` as one), and no reason to ask the
    // backend: an empty page is exactly what a caller whose rows do not exist
    // already sees, which is what makes the two indistinguishable.
    return { total: 0, models: [] };
  }
  if (rowScope?.where) {
    a = {...a, where: applyScopeWhere(a.where as PortableWhere | undefined, rowScope)};
  }
  const offset = cursorOffset(args);
  const {getOptions, countOptions} = await adapter.processListArgsToOptions(defName, {
    args: a, offset, selection, whereOperators: whereOperatorsFor(definition), options, selectedFields,
    runHook: (d, h, v, ...rest) => runHook(self, d, h, v, ...rest),
  });
  if (scope) {
    if (!adapter.mergeFilterStatement) {
      throw new Error(`Adapter '${adapter.adapterName}' cannot scope a query and so cannot be the target of a cross-adapter relationship: it does not implement mergeFilterStatement`);
    }
    getOptions.where = adapter.mergeFilterStatement(scope.field, scope.value, true, getOptions.where);
    if (countOptions) {
      countOptions.where = adapter.mergeFilterStatement(scope.field, scope.value, true, countOptions.where);
    }
  }
  if (definition.before) {
    await definition.before({
      params: getOptions, args, context, info: selection?.raw,
      modelDefinition: definition,
      type: Events.QUERY,
    });
    if (rowScope?.where) {
      // F3. The hook is handed the built options and mutates them in place, so
      // `params.where = {...}` drops the scope entirely. This is not a remote
      // possibility: `before` + `Events.QUERY` is where row filtering lived
      // before this key existed, so the deployments most likely to have such a
      // hook are exactly the ones whose hook rewrites `where`.
      await reassertRowScope(
        self, adapter, defName, rowScope.where, whereOperatorsFor(definition), options,
        [getOptions, countOptions],
      );
    }
  }
  // An exposed method's `input` runs last, after the model-wide `before`, so it
  // sees the final options rather than having its work overwritten by them.
  // One run per selection occurrence, in selection order.
  const optionHooks = selection?.optionHooks || [];
  for (const hook of optionHooks) {
    await hook(getOptions, context);
  }
  if (optionHooks.length > 0 && countOptions) {
    // A backend without an inline count answers `total` from a second query.
    // A hook that narrowed the row set has to narrow that one too, or `total`
    // reports a page size the connection never returns. Only the two keys that
    // decide *which* rows match are carried over — `limit`/`order` mean nothing
    // to a count, and copying them would corrupt it.
    countOptions.where = getOptions.where;
    countOptions.include = getOptions.include;
  }
  // --- Backward pagination adjustments (after hooks, before the query) -----
  // `before`: clamp the LIMIT so the window stops before the cursor, not past it.
  if (args.before) {
    getOptions.limit = Math.min(getOptions.limit ?? Infinity, args.before.index);
  }
  // `last` without a cursor: the relay "last N" semantics are "the last N rows
  // of the total ordered set". We need the total count to compute the right
  // offset. For adapters with inline count this is an extra round-trip; for the
  // `before`+`last` case the offset was already computed by `cursorOffset`.
  const includePlan = a.include as IncludeMap[] | undefined;
  const count = (countWith: AdapterQueryOptions) => cachedCount(self, defName, adapter, context, includePlan, countWith);
  const lastArgs = args as Record<string, unknown>;
  if (lastArgs.last != null && !args.after && !args.before) {
    const preTotal = await count(countOptions || countableFrom(getOptions));
    getOptions.offset = Math.max(0, preTotal - (getOptions.limit ?? preTotal));
  }
  // -----------------------------------------------------------------------

  // Count-only: the connection selects `total` but not `edges`/rows — skip the
  // findAll and run a count (fires beforeCount natively + afterCount manually).
  if (selection?.countOnly) {
    const countOnlyOptions = countOptions || countableFrom(getOptions);
    let total = await count(countOnlyOptions);
    total = await runHook(self, defName, "afterCount", total, countOnlyOptions);
    return { total, models: [] };
  }
  const models = (await cachedFindAll(self, defName, adapter, context, includePlan, getOptions)).filter((m) => (m !== undefined && m !== null));

  // Sequelize does not fire a child model's afterFind for JOIN-loaded includes.
  // Walk the built include plan and fire afterFind for each JOIN (non-separate)
  // relation on the loaded instances before the nested field resolvers read them;
  // separate/cross-adapter relations fire it natively via their own query.
  const plan = includePlan?.[0];
  if (plan) {
    await applyEagerAfterFind(self, plan, models, options);
  }

  let total;
  if (adapter.hasInlineCountFeature()) {
    total = await adapter.getInlineCount(models);
    // Inline count reads `full_count` from the first row. When the page is
    // empty (e.g. `after` past the end), there is no row to read from and it
    // returns 0 — but the connection total is still the true row count. Fall
    // back to a separate COUNT when this happens.
    if (total === 0 && models.length === 0 && (getOptions.offset ?? 0) > 0) {
      total = await count(countableFrom(getOptions));
    }
  } else {
    // `countOptions` is only optional for adapters that count inline; the two
    // are the same decision, so an adapter reaching here without one has a
    // contract bug that would otherwise surface as an unfiltered count.
    if (!countOptions) {
      throw new Error(`Adapter '${adapter.adapterName}' has no inline count feature but returned no countOptions for '${defName}'`);
    }
    total = await count(countOptions);
  }
  return {
    total, models,
  };
}
