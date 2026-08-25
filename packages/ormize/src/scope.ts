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

import {
  mergeScopeWhere, resolveScope,
  type Permission, type PortableWhere, type ResolvedScope, type ScopeOperation,
} from "@azerothian/utilize/gate";
import type { RequestContext, ScopeMissBehaviour } from "@azerothian/utilize/types/index";

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
  const memo = memoFor(context);
  if (!memo) {
    return resolveScope(permission, defName, operation, context);
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
  const pending = resolveScope(permission, defName, operation, context);
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
