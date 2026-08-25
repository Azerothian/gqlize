// Row-level scoping, adapter side (§13, decision 8).
//
// `./scope` and `./manager` merge the scope into the query the engine is about
// to run. This re-imposes it one layer lower, on the model hooks the adapter
// fires — which sit *below* every path the engine cannot see: an eager include
// a `definition.before` hook added, an association accessor called off a row, a
// class method that reached for the model directly.
//
// Belt and braces, deliberately: the two halves overlap on every ordinary query
// and the overlap is one redundant `and`. That redundancy is the point — remove
// either half and a test fails, rather than a hole opening quietly.
//
// The seam is `Ormize.createHook`, which already composes definition hooks first
// and global hooks last and hands the global ones `(defName, value, ...args)`.
// A model name in front of the hook's own arguments is exactly a scope
// predicate's first parameter, so nothing new had to be threaded down. These are
// *not* registered through `globalHooks` though: they run after that loop, from
// a map userland cannot reach, so no registration order can displace them.

import type {
  AdapterQueryOptions, AdapterRow, AdapterWhere, RequestContext,
} from "@azerothian/utilize/types/index";
import { isScopeSeen, markScopeSeen, type ScopeOperation } from "@azerothian/utilize/gate";
import { filterMerger, writable } from "./cross-adapter";
import { ScopeDeniedError, isSystemQuery, resolvingScope } from "./scope";
import type { AdapterRoutingHost } from "./types/engine";

/**
 * A hook in the shape `createHook` calls a global one: the model's name, then
 * whatever the adapter passes its own hooks.
 */
export type ScopeHook = (defName: string, value: any, ...args: any[]) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The hooks whose first argument is the *options bag* of a query about to run:
 * there is a `where` to narrow, so a scope can be merged into it.
 */
const QUERY_HOOKS: {[hookName: string]: ScopeOperation} = {
  beforeFind: "read",
  beforeCount: "read",
  beforeBulkUpdate: "update",
  beforeBulkDestroy: "delete",
  // Undeleting a row is a write to a row that already exists, which is what
  // `update` means here — there is no separate `restore` operation to configure,
  // and inventing one would make "which rows may I write" two questions.
  beforeBulkRestore: "update",
};

/**
 * The hooks whose first argument is a *row*: no filter to narrow, so the scope
 * is checked and the write refused.
 */
const INSTANCE_HOOKS: {[hookName: string]: ScopeOperation} = {
  beforeUpdate: "update",
  beforeDestroy: "delete",
};

/** Sequelize's include entries, seen through the members this file reads. */
type NativeInclude = {
  model?: { name?: string };
  where?: AdapterWhere;
  required?: boolean;
  include?: NativeInclude[];
};

/**
 * The request a query belongs to, or `undefined` when it belongs to none.
 *
 * `getGraphQLArgs` is the channel `docs/guide.md` §9 already documents for
 * `beforeFind`, and it is present on every options bag the engine builds — so
 * gqlize, nestize and temporalize all arrive with one. A query without one came
 * from userland holding the model directly (`db.models.Task.findAll(…)`), which
 * is a documented feature used throughout this repo's own tests: there is no
 * principal to ask a predicate about, and refusing every such call would break
 * far more than it protected. §12's build-time check is what covers that
 * surface, by refusing to *build* a scoped model reachable that way.
 */
function requestOf(options: unknown): { context: RequestContext } | undefined {
  const bag = options as { getGraphQLArgs?: () => { context: RequestContext } } | undefined;
  if (!bag || typeof bag.getGraphQLArgs !== "function") {
    return undefined;
  }
  return { context: bag.getGraphQLArgs().context };
}

/**
 * The request to enforce against, or `undefined` to stand aside.
 *
 * Three reasons to stand aside, and they are not interchangeable: the query is
 * ormize asking whether a row is in scope (marked, or the check recurses); the
 * caller *is* a scope predicate (guarded, or resolution deadlocks on its own
 * memo); or there is no request at all.
 */
function enforceFor(options: unknown): { context: RequestContext } | undefined {
  if (resolvingScope() || isSystemQuery(options)) {
    return undefined;
  }
  return requestOf(options);
}

/**
 * An adapter-native filter no row satisfies: the primary key `in []`.
 *
 * A denied scope has no filter to merge — see `applyScopeWhere` — but a hook has
 * already been handed a query that is going to run. Cancelling it is not on
 * offer, so the filter has to say "nothing" out loud. Built through the
 * adapter's own `mergeFilterStatement` rather than written as an operator
 * literal, so it stays in whatever vocabulary the adapter actually speaks.
 */
function matchNothing(host: AdapterRoutingHost, defName: string): AdapterWhere {
  const [pk] = host.getModelAdapter(defName).getPrimaryKeyNameForModel(defName);
  return filterMerger(host, defName)(pk, [], true, undefined);
}

/**
 * The pair of scopes a query answers to: the operation's own, ANDed under the
 * model's read scope.
 *
 * Reaching a row is a read whatever happens to it next, so a deployment that
 * writes "these are your rows" once — as a read scope — has said it about
 * updates and deletes too. Returns `false` when either half denies outright.
 */
async function scopedWhere(
  host: AdapterRoutingHost, defName: string, operation: ScopeOperation,
  context: RequestContext, where: AdapterWhere | undefined, options: AdapterQueryOptions,
): Promise<AdapterWhere | undefined | false> {
  let merged = await host.scopedWhere(defName, "read", context, where, options);
  if (merged === false) {
    return false;
  }
  if (operation === "read") {
    return merged;
  }
  merged = await host.scopedWhere(defName, operation, context, merged, options);
  return merged;
}

/**
 * Impose a scope's `set` on a row about to be inserted.
 *
 * `processInputs` already forces these on the engine's own path; this is the
 * copy for rows that reached the adapter another way. A client value that
 * *disagrees* is a denial rather than a silent overwrite, for the same reason it
 * is there: writing the safe value anyway turns a forged request into a
 * successful mutation, and nothing downstream would ever know one had been sent.
 */
function forceScopeValues(defName: string, row: AdapterRow, set: {[field: string]: unknown}) {
  const instance = row as { get?(field: string): unknown; set?(field: string, value: unknown): void };
  if (typeof instance.get !== "function" || typeof instance.set !== "function") {
    // Not an instance with an attribute bag — a plain object handed to a bulk
    // insert, say. Nothing to force onto, and nothing forged to detect either.
    return;
  }
  for (const field of Object.keys(set)) {
    const current = instance.get(field);
    if (current !== undefined && current !== null && current !== set[field]) {
      throw new ScopeDeniedError(defName, "create");
    }
    instance.set(field, set[field]);
  }
}

/**
 * Build the enforcement map `Ormize.createHook` runs after every registered
 * hook. Keyed by hook name; a name that is absent imposes nothing.
 *
 * Built once and unconditionally — whether a scope is configured is asked at
 * *call* time, so a `setPermission` after `initialise()` takes effect on the
 * models that already exist.
 */
export function buildScopeHooks(host: AdapterRoutingHost): {[hookName: string]: ScopeHook} {
  const hooks: {[hookName: string]: ScopeHook} = {};

  for (const hookName of Object.keys(QUERY_HOOKS)) {
    const operation = QUERY_HOOKS[hookName];
    hooks[hookName] = async(defName: string, options: AdapterQueryOptions) => {
      // Before the stand-aside, and that is the whole contract: the mark says a
      // scope layer looked at this query, not that it narrowed it. A query that
      // legitimately runs unscoped has been looked at too, and refusing it later
      // would turn every exemption into an outage.
      markScopeSeen(options);
      const request = enforceFor(options);
      if (!request || !options) {
        return options;
      }
      const where = await scopedWhere(host, defName, operation, request.context, options.where, options);
      if (where === false) {
        // A read denied outright answers with an empty page, which is what a
        // caller with no matching rows already sees. A write follows the
        // deployment's `onScopeMiss` — and then still runs against a filter
        // nothing satisfies, because "quiet" has to mean the write did not
        // happen, not that it happened unscoped.
        host.scopeMiss(defName, operation);
        options.where = matchNothing(host, defName);
        return options;
      }
      options.where = where;
      return options;
    };
  }

  /**
   * The include tree, once the adapter has expanded it.
   *
   * An eagerly-loaded relationship is fetched by its *parent's* query, so no
   * per-relationship resolver ever sees it and no filter of its own exists to
   * merge into — F4. `scopeIncludePlan` covers the plan the engine builds; this
   * covers every include that reached the query some other way.
   */
  hooks.beforeFindAfterExpandIncludeAll = async(_defName: string, options: AdapterQueryOptions) => {
    markScopeSeen(options);
    const request = enforceFor(options);
    const include = (options as { include?: NativeInclude[] } | undefined)?.include;
    if (!request || !Array.isArray(include)) {
      return options;
    }
    await scopeIncludes(host, include, request.context, options);
    return options;
  };

  for (const hookName of Object.keys(INSTANCE_HOOKS)) {
    const operation = INSTANCE_HOOKS[hookName];
    hooks[hookName] = async(defName: string, row: AdapterRow, options: AdapterQueryOptions) => {
      markScopeSeen(options);
      const request = enforceFor(options);
      if (!request || !row) {
        return row;
      }
      if (!await writable(host, defName, host.getModelAdapter(defName), row, operation, options)) {
        // An instance write has no filter to narrow and no empty page to hand
        // back: `instance.save()` either happens or it does not. So this refuses
        // loudly whatever `onScopeMiss` says — the quiet alternative here is not
        // silence, it is letting the write through.
        throw new ScopeDeniedError(defName, operation);
      }
      return row;
    };
  }

  const create = async(defName: string, rows: AdapterRow[], options: AdapterQueryOptions) => {
    markScopeSeen(options);
    const request = enforceFor(options);
    if (!request) {
      return;
    }
    const resolved = await host.resolveScope(defName, "create", request.context);
    if (resolved === false) {
      host.scopeMiss(defName, "create");
      throw new ScopeDeniedError(defName, "create");
    }
    if (!resolved?.set) {
      // A `where`-only scope says which rows are yours, not what a new one has
      // to contain — there is nothing here to hold a row inside it. The
      // post-write re-check (F6) is what catches a create that lands outside.
      return;
    }
    for (const row of rows) {
      forceScopeValues(defName, row, resolved.set);
    }
  };

  hooks.beforeCreate = async(defName: string, row: AdapterRow, options: AdapterQueryOptions) => {
    await create(defName, row ? [row] : [], options);
    return row;
  };
  hooks.beforeBulkCreate = async(defName: string, rows: AdapterRow[], options: AdapterQueryOptions) => {
    await create(defName, Array.isArray(rows) ? rows : [], options);
    return rows;
  };

  return hooks;
}

/**
 * The Sequelize-*instance* enforcement map (§12's runtime twin).
 *
 * `beforeQuery` fires once per statement, after the SQL is fully built — which
 * is why it refuses rather than rewrites. By then there is nothing left to
 * narrow: the text is text, and the only honest options are let it run or do
 * not.
 *
 * What it catches is the gap `beforeFind` cannot: a statement that reached the
 * driver bound to a model without passing any of the model hooks above. In
 * practice that is `sequelize.query(sql, {model, mapToModel})` written by hand —
 * the documented escape hatch, and the one thing a row-level scope has no other
 * way to see. Its build-time twin (`scope-audit.ts`) covers the declared form;
 * this covers the undeclared one.
 *
 * It cannot see a raw statement that names no model, because nothing can: which
 * tables an arbitrary SQL string touches is not a question available at this
 * layer. That is a limit of the surface, and the reason §12 refuses to *build*
 * an unannotated raw-SQL method rather than relying on this.
 *
 * Registered outside `globalHooks`, like the model-hook map above, so no
 * registration order can displace it.
 */
export function buildScopeInstanceHooks(
  isDefinition: (name: string) => boolean,
): {[hookName: string]: (...args: unknown[]) => unknown} {
  return {
    beforeQuery: (options: unknown) => {
      if (isScopeSeen(options) || resolvingScope() || isSystemQuery(options)) {
        return;
      }
      const bag = options as { model?: { name?: string } } | undefined;
      const defName = bag?.model?.name;
      if (!defName || !isDefinition(defName)) {
        // No model, or one this orm does not own. DDL, a `describeTable`, a
        // migration — nothing a row-level scope has an opinion about.
        return;
      }
      throw new ScopeDeniedError(defName, "read");
    },
  };
}

/**
 * AND each include's read scope onto its own `where`, depth first.
 *
 * Mutates in place: by this hook the adapter owns the tree and is about to build
 * SQL from it, so handing back a copy would change nothing.
 */
async function scopeIncludes(
  host: AdapterRoutingHost, include: NativeInclude[],
  context: RequestContext, options: AdapterQueryOptions,
): Promise<void> {
  for (const inc of include) {
    const target = inc?.model?.name;
    if (!inc) {
      continue;
    }
    if (Array.isArray(inc.include)) {
      await scopeIncludes(host, inc.include, context, options);
    }
    if (!target) {
      continue;
    }
    const where = await host.scopedWhere(target, "read", context, inc.where, options);
    if (where === false) {
      inc.where = matchNothing(host, target);
    } else if (where !== inc.where) {
      inc.where = where;
    } else {
      continue;
    }
    if (inc.required === undefined) {
      // Decision 6, and not a preference: an adapter that infers requiredness
      // from the presence of a `where` — Sequelize does — would read the
      // injected filter as an INNER JOIN and drop every parent whose children
      // are all out of scope. A scope on a child must never become a filter on
      // the parent.
      inc.required = false;
    }
  }
}
