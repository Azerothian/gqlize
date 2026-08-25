// Row-level scoping, engine side.
//
// `@azerothian/utilize/gate` owns what a scope *is* — the predicate's contract,
// the fail-closed asymmetry, and how two filters combine. This owns what the
// engine *does* with one: when it is resolved, how often, and what "denied"
// means at a call site that has to return something.
//
// The split matters because `utilize` has no engine and must not gain one: the
// permission bag is also read by gqlize at schema build, where none of this
// applies.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  mergeScopeWhere, resolveScope,
  type Permission, type PortableWhere, type ResolvedScope, type ScopeOperation,
} from "@azerothian/utilize/gate";
import type { IncludeMap, RequestContext, ScopeMissBehaviour } from "@azerothian/utilize/types/index";

// `ScopeMissBehaviour` is declared in `@azerothian/utilize` because
// `GqlizeOptions` names it and utilize cannot import the engine. Re-exported
// here because this file is where the behaviour it describes actually lives:
// `"empty"` reports the same nothing an unscoped write reports for a row that
// does not exist — the two have to be indistinguishable, or the difference is
// itself a read of the scoped-out row — and `"throw"` trades that for a loud
// refusal, accepting that it confirms the row exists (F9).
export type { ScopeMissBehaviour };

/** Raised when a write is refused because the scope matched nothing. */
export class ScopeDeniedError extends Error {
  readonly defName: string;
  readonly operation: ScopeOperation;
  constructor(defName: string, operation: ScopeOperation) {
    super(`Not permitted: '${operation}' on '${defName}' is out of scope for this principal.`);
    this.name = "ScopeDeniedError";
    this.defName = defName;
    this.operation = operation;
  }
}

/**
 * Raised when a write left a row outside the scope that let it be written.
 *
 * Distinct from {@link ScopeDeniedError}: that one refuses a write *before* it
 * happens, and can therefore be answered quietly with an empty result. This one
 * is raised after the row was written, so there is nothing quiet left to
 * report — see {@link ScopeMissBehaviour} for why the two are not the same
 * decision.
 */
export class ScopeEscapeError extends Error {
  readonly defName: string;
  readonly operation: ScopeOperation;
  constructor(defName: string, operation: ScopeOperation) {
    super(`Not permitted: this '${operation}' would leave a '${defName}' row outside the scope this principal may reach.`);
    this.name = "ScopeEscapeError";
    this.defName = defName;
    this.operation = operation;
  }
}

/**
 * Marks an options bag as ormize's own traffic, exempt from the adapter-side
 * hooks in `./scope-hooks`.
 *
 * A `Symbol`, and deliberately not a string key: `args` reach the engine as
 * JSON, so any string a caller could guess is a string a caller could *send*,
 * and this one turns enforcement off. A symbol is unforgeable from outside the
 * module that owns it — which is why the module that owns it is this one and
 * not the hooks themselves.
 *
 * Used only for queries ormize issues *about* the scope — the re-reads in
 * {@link applyScopeWhere}'s callers that check whether a row is still reachable.
 * Reads and writes the engine has already scoped are **not** marked: the
 * adapter hook re-imposing the same filter costs one redundant `and`, and
 * paying it is what keeps deleting either half of decision 8 a test failure
 * rather than a hole.
 */
const SYSTEM_QUERY = Symbol("ormize.systemQuery");

/** Exempt an options bag from the adapter-side scope hooks. See {@link SYSTEM_QUERY}. */
export function markSystemQuery<T>(options: T): T {
  if (options && typeof options === "object") {
    Object.defineProperty(options, SYSTEM_QUERY, {
      value: true, enumerable: false, writable: false, configurable: true,
    });
  }
  return options;
}

/** Whether an options bag carries {@link SYSTEM_QUERY}. */
export function isSystemQuery(options: unknown): boolean {
  return Boolean(options) && typeof options === "object"
    && (options as { [SYSTEM_QUERY]?: boolean })[SYSTEM_QUERY] === true;
}

/**
 * Set for exactly as long as a scope predicate is running.
 *
 * "Which groups is this principal in?" is answered with a query, and a query
 * fires `beforeFind`, which resolves the scope — the same scope, still
 * resolving. The memo holds the *promise*, so the second resolution would await
 * the first and neither would ever settle: a deadlock, not a slow request.
 *
 * `AsyncLocalStorage` rather than a flag on the manager because the guard has to
 * cover exactly the async context the predicate runs in. A counter would be
 * turned on for every request that merely overlapped it — which is enforcement
 * silently disabled under concurrency, the worst shape this bug could take.
 */
const RESOLVING = new AsyncLocalStorage<true>();

/** Whether the caller is running inside a scope predicate. See {@link RESOLVING}. */
export function resolvingScope(): boolean {
  return RESOLVING.getStore() === true;
}

/**
 * A request's resolved scopes, keyed by `(principal, model, operation)`.
 *
 * A nested selection (`projects { tasks { … } }`) resolves the child's scope
 * once per parent row, so without this a group-membership lookup runs N times.
 * That is not only wasted work: a predicate that reads a database can return
 * different answers within one request, and a request scoped two different ways
 * is worse than one scoped either way.
 *
 * Deliberately *not* a module-level cache and *not* keyed on the context object.
 * It holds permission decisions, so the only safe lifetime is one request and
 * the only safe key includes who the request is acting as. It is parked on the
 * context under a private symbol, which is per-request under every host — and
 * the principal is in the key regardless, so a context a deployment reuses
 * across principals still cannot serve one principal's decision to another.
 */
type ScopeMemo = Map<string, Promise<ResolvedScope>>;

const MEMO = Symbol("ormize.scopeMemo");

/**
 * Enough of the principal to key a memo with. Not an identity check and not a
 * security boundary — the predicate still runs and still decides. This only has
 * to be different for different principals, so that two of them never share an
 * entry.
 */
function principalKey(context: RequestContext): string {
  const bag = context as {
    user?: { id?: unknown }; principal?: { id?: unknown };
    req?: { user?: { id?: unknown } }; request?: { user?: { id?: unknown } };
  } | undefined;
  const principal = bag?.user || bag?.principal || bag?.req?.user || bag?.request?.user;
  const id = principal?.id;
  if (typeof id === "string" || typeof id === "number" || typeof id === "bigint") {
    return String(id);
  }
  if (id === undefined || id === null) {
    // Nobody to key on. Safe as a shared bucket only because the memo itself is
    // per-context: within one request there is one anonymous principal.
    return "\u0000anonymous";
  }
  // A composite id — a tuple, an ObjectId wrapper. `String` flattens every one
  // of them onto "[object Object]", and that is the single collision that
  // matters here: two principals sharing a memoised *permission decision*.
  try {
    return `\u0000json:${JSON.stringify(id)}`;
  } catch {
    // Circular, or a toJSON that throws. Nothing left to distinguish them by,
    // so stop memoising rather than guess: `scopeFor` re-resolves on a miss.
    return `\u0000opaque:${String(nextOpaqueKey++)}`;
  }
}

/** Counter behind the last resort in {@link principalKey}; see its comment. */
let nextOpaqueKey = 0;

function memoFor(context: RequestContext): ScopeMemo | undefined {
  if (!context || typeof context !== "object") {
    // Nothing request-shaped to hang a memo on; resolve every time. Correctness
    // never depends on the memo, only the number of predicate calls does.
    return undefined;
  }
  const host = context as { [MEMO]?: ScopeMemo };
  if (!host[MEMO]) {
    Object.defineProperty(host, MEMO, {
      value: new Map<string, Promise<ResolvedScope>>(),
      enumerable: false, writable: false, configurable: true,
    });
  }
  return host[MEMO];
}

/**
 * Carry a request's memo onto a context derived from another one.
 *
 * The engine re-points a context at an adapter's transaction handle by copying
 * it — `Object.assign({}, context, {transaction})` — and the memo hangs off a
 * *non-enumerable symbol*, which a copy does not bring along. Without this every
 * nested mutation entry starts an empty memo and resolves the predicate again,
 * which is exactly the repetition F7 exists to prevent: a predicate that reads a
 * database can answer differently the second time, and a request scoped two ways
 * is worse than one scoped either way.
 *
 * Sharing the same `Map` rather than copying it is deliberate — a decision made
 * on the derived context should be visible to the original, since they are the
 * same request acting as the same principal.
 */
export function inheritScopeMemo<T>(source: unknown, derived: T): T {
  if (!source || typeof source !== "object" || !derived || typeof derived !== "object") {
    return derived;
  }
  const memo = (source as { [MEMO]?: ScopeMemo })[MEMO];
  const target = derived as { [MEMO]?: ScopeMemo };
  if (!memo || target[MEMO]) {
    return derived;
  }
  Object.defineProperty(target, MEMO, {
    value: memo, enumerable: false, writable: false, configurable: true,
  });
  return derived;
}

/**
 * Resolve `permission.scope` for one model and operation, once per request.
 *
 * Returns `undefined` when nothing is imposed, `false` when the principal may
 * reach no rows at all, and otherwise the filter (and, for writes, the values)
 * to apply.
 */
export function scopeFor(
  permission: Permission | undefined,
  defName: string,
  operation: ScopeOperation,
  context: RequestContext,
): Promise<ResolvedScope> {
  if (typeof permission?.scope !== "function") {
    return Promise.resolve(undefined);
  }
  if (resolvingScope()) {
    // A query the predicate itself issues runs unscoped — the system context
    // every permission layer needs to answer "who is this principal" without
    // first knowing the answer.
    //
    // Ahead of the memo, and that placement is the whole guard: the memo holds
    // the *promise*, so a predicate whose lookup re-enters here for the same
    // triple would await the promise it is itself producing. Not a slow request,
    // a permanently hung one. §13 names this the re-entrancy risk; this is where
    // it is answered, and the hooks in `./scope-hooks` only mirror it so they can
    // stand aside before doing any adapter work.
    return Promise.resolve(undefined);
  }
  const memo = memoFor(context);
  if (!memo) {
    return RESOLVING.run(true, () => resolveScope(permission, defName, operation, context));
  }
  // NUL-separated: a principal id may contain anything, and a separator it
  // could itself contain would let two different triples collapse onto one
  // memoised *permission decision*. Spelled as an escape rather than written
  // raw, so the byte survives a copy-paste and shows up in a grep.
  const key = `${principalKey(context)}\u0000${defName}\u0000${operation}`;
  const cached = memo.get(key);
  if (cached) {
    return cached;
  }
  // The *promise* is memoised, not the value: two sibling resolvers reaching
  // this concurrently must share one predicate call, not race to start two.
  const pending = RESOLVING.run(true, () => resolveScope(permission, defName, operation, context));
  memo.set(key, pending);
  return pending;
}

/**
 * Fold a resolved scope's filter into a caller's, in the portable vocabulary.
 *
 * `false` never reaches here: a denied scope has no filter to merge, and every
 * call site short-circuits instead (see {@link scopeMiss}). Passing it would
 * need a portable "match nothing", which §9.4 of the design rejects — some
 * adapters cannot express one, and the ones that can turn it into a filter that
 * reads like a bug.
 */
export function applyScopeWhere(
  userWhere: PortableWhere | undefined,
  resolved: ResolvedScope,
): PortableWhere | undefined {
  if (!resolved) {
    return userWhere;
  }
  return mergeScopeWhere(userWhere, resolved.where);
}

/**
 * Fold each model's read scope into the eager-include plan.
 *
 * A relationship selected alongside its parent is loaded by the *parent's*
 * query, so the per-relationship resolver never sees it — `resolveManyRelationship`
 * finds the rows already on the instance and hands them straight back. The only
 * place a scope can reach them is the include descriptor, while its `where` is
 * still in the caller's vocabulary.
 *
 * Returns a new plan rather than mutating: the caller's descriptors are built
 * once per request from the selection set and are not this function's to own.
 */
export async function scopeIncludePlan(
  include: IncludeMap[] | undefined,
  readScopeFor: (defName: string) => Promise<ResolvedScope>,
): Promise<IncludeMap[] | undefined> {
  if (!include || include.length === 0) {
    return include;
  }
  const out: IncludeMap[] = [];
  for (const level of include) {
    const mapped: IncludeMap = {};
    for (const relName of Object.keys(level)) {
      const inc = level[relName];
      const resolved = await readScopeFor(inc.target);
      if (resolved === false) {
        // Denied outright, and an include has no portable way to say "no rows".
        // Dropping it is not a hole: it stops the *eager* load, which hands the
        // relationship back to `resolveManyRelationship` /
        // `resolveSingleRelationship`, and those answer a denied scope with an
        // empty page and a `null`.
        continue;
      }
      const scoped: IncludeMap[string] = Object.assign({}, inc);
      scoped.include = await scopeIncludePlan(inc.include, readScopeFor);
      if (resolved?.where) {
        scoped.where = mergeScopeWhere(inc.where, resolved.where);
        if (inc.required === undefined) {
          // Decision 6, and not merely a preference: an adapter that infers
          // requiredness from the presence of a `where` — Sequelize does — would
          // read the injected filter as "INNER JOIN" and drop every parent whose
          // children are all out of scope. A scope on a child must never become
          // a filter on the parent.
          scoped.required = false;
        }
      }
      mapped[relName] = scoped;
    }
    out.push(mapped);
  }
  return out;
}

/**
 * What to return — or throw — when a scope denies outright.
 *
 * Reads always take the quiet path: an empty page is what a caller with no
 * matching rows already sees, so it leaks nothing. Writes follow the
 * deployment's `onScopeMiss`.
 */
export function scopeMiss(
  defName: string, operation: ScopeOperation, behaviour: ScopeMissBehaviour | undefined,
): void {
  if (operation !== "read" && behaviour === "throw") {
    throw new ScopeDeniedError(defName, operation);
  }
}
