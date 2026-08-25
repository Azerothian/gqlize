// Shared permission-gating helpers, extracted from gqlize's inline schema-build
// checks so both `@azerothian/gqlize` and `@azerothian/ormize-zod4` apply identical
// rules. GraphQL-free.
//
// Conventions (matching gqlize's `if (options.permission?.X)` guards and the
// synchronous `createRoleBasedPermissions` predicates):
//  - an absent permission object, or an absent predicate, means ALLOW.
//  - predicates are called synchronously and coerced to boolean (as gqlize's
//    field gate already does); a helper can still be `await`ed at call sites that
//    do so today — awaiting a boolean is a no-op.
//  - `options` from the permission object is passed as the trailing predicate arg
//    (role/user context), mirroring gqlize call sites.

import type { RequestContext } from "./types/index";

// Same channel, and the same reasoning, as `permissions.ts`: the `debug`-backed
// logger is silent unless DEBUG is set, and a scope that quietly became a deny
// is exactly the event that must not be invisible.
const log = {
  warn: (message: string) => console.warn(message), // eslint-disable-line no-console
};

/**
 * Caller-defined role/user context. Threaded to every predicate as the trailing
 * argument and never inspected here, so `any` is deliberate: its shape belongs
 * to whoever built the bag.
 */
export type PermissionContext = any;

/**
 * The predicate bag passed as `options.permission` (e.g. the object from
 * `createRoleBasedPermissions`).
 *
 * Deliberately **closed** — no index signature. An absent predicate means ALLOW
 * (`isAllowed` below), so a misspelled key does not fail closed; it silently
 * produces a schema more permissive than its author intended. The
 * excess-property check on an object literal is what turns that into a compile
 * error, and an index signature would defeat it. `unknownPermissionKeys` covers
 * the same mistake at runtime, for JS callers and bags built programmatically.
 *
 * `PERMISSION_KEYS` below is the machine-readable copy of these keys; the two
 * cannot drift apart (see `_NoDrift`).
 */
export type Permission = {
  options?: PermissionContext;
  model?: (defName: string, options?: PermissionContext) => boolean;
  query?: (defName: string, options?: PermissionContext) => boolean;
  mutation?: (defName: string, options?: PermissionContext) => boolean;
  mutationCreate?: (defName: string, options?: PermissionContext) => boolean;
  mutationUpdate?: (defName: string, options?: PermissionContext) => boolean;
  mutationDelete?: (defName: string, options?: PermissionContext) => boolean;
  mutationCreateInput?: (defName: string, fieldName: string, options?: PermissionContext) => boolean;
  mutationUpdateInput?: (defName: string, fieldName: string, options?: PermissionContext) => boolean;
  field?: (defName: string, fieldName: string, options?: PermissionContext) => boolean;
  relationship?: (defName: string, relName: string, targetName: string, options?: PermissionContext) => boolean;
  queryClassMethods?: (defName: string, methodName: string, options?: PermissionContext) => boolean;
  mutationClassMethods?: (defName: string, methodName: string, options?: PermissionContext) => boolean;
  queryInstanceMethods?: (defName: string, methodName: string, options?: PermissionContext) => boolean;
  /**
   * Gates `expose.instanceMethods.mutations` — the pre-commit transforms
   * surfaced as the `apply` argument on a model's mutation field.
   */
  mutationInstanceMethods?: (defName: string, methodName: string, options?: PermissionContext) => boolean;
  /** First argument is the `options.extend.query` field key, not a model name. */
  queryExtension?: (fieldName: string, options?: PermissionContext) => boolean;
  /** First argument is the `options.extend.mutation` field key, not a model name. */
  mutationExtension?: (fieldName: string, options?: PermissionContext) => boolean;
  /**
   * Row-level scope. The one key that does not answer "does this surface
   * exist" with a boolean — it rewrites the query instead, for reads and writes
   * alike. Resolved through {@link resolveScope}, never {@link isAllowed}.
   */
  scope?: ScopePredicate;
};

/** Mutation kinds that map to `mutationCreate` / `mutationUpdate` / `mutationDelete`. */
export type MutationKind = "create" | "update" | "delete";

/**
 * Call a permission predicate; an absent (non-function) predicate is allow
 * (`true`).
 *
 * The dev-only shape check exists because of `scope`. Every gate here coerces
 * with `!!`, and a *filter* coerces to `true` — so a scope routed through this
 * helper by mistake would not fail closed or even fail loudly: it would
 * evaporate into an unrestricted query. A promise coerces the same way, which
 * catches the other half of the mistake (an async predicate on a build-time
 * gate). Both are configuration errors, so they throw rather than being
 * silently accepted, and only outside production, where a schema build is a
 * developer sitting in front of the error.
 */
export function isAllowed(fn: unknown, ...args: unknown[]): boolean {
  if (typeof fn !== "function") {
    return true;
  }
  const result = fn(...args);
  if (process.env.NODE_ENV !== "production"
      && result !== undefined && result !== null && typeof result !== "boolean") {
    const kind = result && typeof (result as { then?: unknown }).then === "function"
      ? "a promise — build-time permission gates are synchronous"
      : `a ${Array.isArray(result) ? "array" : typeof result}`;
    throw new TypeError(
      `A permission predicate returned ${kind}. Build-time gates must return a boolean; ` +
      "returning anything else coerces to true and silently widens access. " +
      "Row-level filtering belongs in `permission.scope`.",
    );
  }
  return !!result;
}

/** Whether a model is exposed at all (`permission.model`). */
export function isModelAllowed(permission: Permission | undefined, model: string): boolean {
  return isAllowed(permission?.model, model, permission?.options);
}

/**
 * Whether an output/entity field is exposed (`permission.field`). The `id` field
 * is always allowed, matching gqlize's `create-basic-fields` behavior.
 */
export function isFieldAllowed(permission: Permission | undefined, model: string, field: string): boolean {
  if (field === "id") {
    return true;
  }
  return isAllowed(permission?.field, model, field, permission?.options);
}

/**
 * Whether a relationship is exposed (`permission.relationship`). `target` (the
 * related model name) is passed to the predicate as an extra arg, matching
 * gqlize's `relationship(model, rel, target, options)` call.
 */
export function isRelationshipAllowed(permission: Permission | undefined, model: string, relationship: string, target?: string): boolean {
  return isAllowed(permission?.relationship, model, relationship, target, permission?.options);
}

/**
 * Whether an exposed *query* instance method is reachable
 * (`permission.queryInstanceMethods`).
 *
 * A denied method contributes no output field — and, because sortability and
 * filterability are each another way to leak a value, no `orderBy` enum member
 * and no `where` field either. This is the helper form of the check
 * `create-complex-fields` used to make inline.
 */
export function isQueryInstanceMethodAllowed(permission: Permission | undefined, model: string, method: string): boolean {
  return isAllowed(permission?.queryInstanceMethods, model, method, permission?.options);
}

/**
 * Whether an exposed *mutation* instance method (a pre-commit transform) is
 * reachable (`permission.mutationInstanceMethods`). A denied transform is
 * absent from the generated `apply` input, so it cannot be requested at all.
 */
export function isMutationInstanceMethodAllowed(permission: Permission | undefined, model: string, method: string): boolean {
  return isAllowed(permission?.mutationInstanceMethods, model, method, permission?.options);
}

/** Whether an exposed class method is reachable, on either target. */
export function isClassMethodAllowed(
  permission: Permission | undefined, model: string, method: string, target: "query" | "mutations",
): boolean {
  const fn = target === "query" ? permission?.queryClassMethods : permission?.mutationClassMethods;
  return isAllowed(fn, model, method, permission?.options);
}

function mutationPredicate(permission: Permission | undefined, kind: MutationKind): any {
  switch (kind) {
    case "create":
      return permission?.mutationCreate;
    case "update":
      return permission?.mutationUpdate;
    case "delete":
      return permission?.mutationDelete;
    default:
      return undefined;
  }
}

/** Whether a create/update/delete mutation is exposed for a model. */
export function isMutationAllowed(permission: Permission | undefined, model: string, kind: MutationKind): boolean {
  return isAllowed(mutationPredicate(permission, kind), model, permission?.options);
}

/**
 * Whether an input field is exposed for a create/update mutation
 * (`permission.mutationCreateInput` / `permission.mutationUpdateInput`). These
 * predicates are optional — when absent, the field is allowed.
 */
export function isInputFieldAllowed(permission: Permission | undefined, model: string, field: string, kind: "create" | "update"): boolean {
  const fn = kind === "create" ? permission?.mutationCreateInput : permission?.mutationUpdateInput;
  return isAllowed(fn, model, field, permission?.options);
}

/** Minimal field-meta shape used by the write-safety checks below. */
export type WritableFieldMeta = {
  primaryKey?: boolean;
  foreignKey?: boolean;
  autoPopulated?: boolean;
  writable?: boolean;
};

/**
 * Structural mass-assignment guard, independent of any permission predicate.
 *
 * By default a client may NOT write primary keys or foreign keys — otherwise a
 * caller could forge a record's id (collision) or reassign its owner/tenant via
 * the FK (IDOR). A field opts back in with `writable: true` in its definition.
 *
 * NOTE: this deliberately does NOT exclude `autoPopulated` fields. In this
 * codebase `autoPopulated` also covers any column with a `defaultValue` (e.g. a
 * boolean flag defaulting to false), which is perfectly valid client input —
 * excluding it would silently drop those fields from mutations. Auto-increment
 * primary keys are already covered by the primaryKey check. When no meta is
 * available the field is allowed (nothing to gate on).
 */
export function isStructurallyWritable(meta: WritableFieldMeta | undefined): boolean {
  if (!meta) {
    return true;
  }
  if (meta.writable === true) {
    return true;
  }
  return !(meta.primaryKey || meta.foreignKey);
}

/**
 * Combined check for schema-generation layers: a field is writable as input only
 * if it passes both the structural mass-assignment guard and the configured
 * `isInputFieldAllowed` permission predicate.
 */
export function isInputFieldWritable(
  permission: Permission | undefined,
  model: string,
  field: string,
  kind: "create" | "update",
  meta: WritableFieldMeta | undefined,
): boolean {
  return isStructurallyWritable(meta) && isInputFieldAllowed(permission, model, field, kind);
}

/**
 * Every key any consumer reads off an `options.permission` bag — the union
 * across gqlize, nestize, temporalize and ormize-zod4, mirroring
 * `GqlizeOptions.permission` in `./types/index`.
 *
 * The siblings each read a strict subset (they reach permissions only through
 * the `is*Allowed` helpers above), so this union is the right list for all of
 * them: a key that is merely unused by one consumer is still valid.
 */
export const BUILD_TIME_PERMISSION_KEYS = [
  "options",
  "model",
  "query",
  "mutation",
  "mutationCreate",
  "mutationUpdate",
  "mutationDelete",
  "mutationCreateInput",
  "mutationUpdateInput",
  "field",
  "relationship",
  "queryClassMethods",
  "mutationClassMethods",
  "queryInstanceMethods",
  "mutationInstanceMethods",
  "queryExtension",
  "mutationExtension",
] as const;

/**
 * Keys consulted **per request**, never during a schema build.
 *
 * The split is structural rather than conventional on purpose. `scope` may be
 * async, and that is safe only for as long as nothing under
 * `packages/gqlize/src/graphql/*` calls it — a schema builder cannot await, so
 * a resolution-time key reached from there would resolve to a pending promise
 * and coerce to `true`. Enumerating the two sets separately is what lets that
 * rule be asserted instead of left as a comment for someone to violate.
 */
export const RESOLUTION_TIME_PERMISSION_KEYS = [
  "scope",
] as const;

/** Every key any consumer reads off a permission bag, whenever it reads it. */
export const PERMISSION_KEYS = [
  ...BUILD_TIME_PERMISSION_KEYS,
  ...RESOLUTION_TIME_PERMISSION_KEYS,
] as const;

/**
 * Compile-time proof that `PERMISSION_KEYS` and `Permission` describe the same
 * key set. Adding a predicate to one and forgetting the other used to mean either
 * a valid key warned as unknown, or an unread key passing validation — and the
 * second of those fails open. Costs nothing at runtime.
 */
type _NoDrift =
  [Exclude<keyof Permission, typeof PERMISSION_KEYS[number]>] extends [never]
    ? [Exclude<typeof PERMISSION_KEYS[number], keyof Permission>] extends [never]
      ? true
      : never
    : never;
const _noDrift: _NoDrift = true;
void _noDrift;

/**
 * Compile-time proof that the build-time / resolution-time split covers every
 * key exactly once. An overlap would let a schema builder legitimately reach an
 * async predicate; a gap would leave a key gated by neither list, which is the
 * failure mode `_NoDrift` above already exists to prevent.
 */
type _NoOverlap =
  [Extract<typeof BUILD_TIME_PERMISSION_KEYS[number], typeof RESOLUTION_TIME_PERMISSION_KEYS[number]>] extends [never]
    ? true
    : never;
const _noOverlap: _NoOverlap = true;
void _noOverlap;

/**
 * Keys present on a permission bag that nothing will ever read.
 *
 * Worth reporting rather than ignoring: `isAllowed` treats an absent predicate
 * as ALLOW, so a misspelled key does not fail closed — it silently produces a
 * schema more permissive than its author intended, with no error and (for JS
 * callers, or a bag built programmatically) no type error either.
 */
export function unknownPermissionKeys(permission: Permission | undefined): string[] {
  if (!permission) {
    return [];
  }
  return Object.keys(permission).filter((key) => !(PERMISSION_KEYS as readonly string[]).includes(key));
}

/**
 * The caller-vocabulary filter — the shape gqlize exposes as a `where`
 * argument, and the input `adapter.processFilterArgument` translates into an
 * {@link AdapterWhere}.
 *
 * It is deliberately *not* `AdapterWhere`, which is documented as belonging to
 * the backend. Nothing named the portable half before `scope` arrived, and
 * ormize's `MutationFilter` was aliased to the adapter-native type — the exact
 * opposite of what a caller-supplied filter is. `scope` is the first key that
 * has to tell the two apart, because it returns a filter that must be merged
 * *before* translation.
 *
 * Field conditions (`{ownerId: {eq: "u1"}}`) sit alongside the logical
 * combinators `and` / `or` / `not`, which `guards.ts` matches lowercased.
 *
 * The leaves are `unknown` rather than `AdapterWhere`'s `any`: this is the side
 * the engine *builds* filters on, so a leaf reached without a narrowing should
 * be a compile error rather than a silent one.
 */
export type PortableWhere = { [key: string]: unknown };

/** Which operation a scope is being resolved for. */
export type ScopeOperation = "read" | "create" | "update" | "delete";

/**
 * What a {@link ScopePredicate} may return.
 *
 * The two falsy-looking members mean opposite things and that is the whole
 * hazard of this key: `undefined` is "no opinion", which imposes **no**
 * restriction (matching every other key in the bag, where an absent predicate
 * allows), while `false` is an outright **deny**. A filter object sits between
 * them, and `!!filter` is `true` — which is why a scope must never travel
 * through {@link isAllowed}.
 *
 * The object form carries `where` (AND-ed into the operation's filter), `set`
 * (forced field values, the create/update case — there is no `where` to merge
 * into on a create), and `native` (an adapter-native escape hatch, merged at
 * the adapter-native site instead and adapter-locking by construction).
 */
export type ScopeResult =
  | undefined
  | false
  | PortableWhere
  | { where?: PortableWhere; set?: { [field: string]: unknown }; native?: unknown };

/**
 * The row-level scope predicate (`permission.scope`).
 *
 * Unlike every other key in the bag it runs **per request**, not at schema
 * build, which is what earns it the fourth argument: `options` is the
 * build-time role bag, fixed for the life of the schema, and `context` is who
 * is asking. Without the second there is no way to scope per user short of a
 * schema per user.
 *
 * Running at resolution time is also what makes `Promise` legal here —
 * resolving group membership is a lookup. Nothing under
 * `packages/gqlize/src/graphql/*` may call it; see
 * {@link RESOLUTION_TIME_PERMISSION_KEYS}.
 */
export type ScopePredicate = (
  defName: string,
  operation: ScopeOperation,
  options: PermissionContext | undefined,
  context: RequestContext,
) => ScopeResult | Promise<ScopeResult>;

/** What a scope resolved to, normalised. `false` is a deny; `undefined` is unscoped. */
export type ResolvedScope =
  | undefined
  | false
  | { where?: PortableWhere; set?: { [field: string]: unknown }; native?: unknown };

/**
 * A scope that cannot be *expressed*, as opposed to a scope that decided to
 * deny.
 *
 * The distinction is the whole point of the class. A predicate that throws has
 * made a bad decision in userland and is treated as a deny — anything else lets
 * a 500 escape to an edge that may retry the request unauthenticated. But a
 * scope the adapter cannot represent (valkey refuses an `or` unless every
 * branch is index-resolvable) is a *configuration* error, and denying it hands
 * the deployment empty result sets where it should get a stack trace. An
 * availability failure wearing a permission decision's clothes is the worst
 * thing in this feature to debug, so this one is rethrown.
 */
export class ScopeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeConfigurationError";
  }
}

/**
 * What a surface the engine cannot scope has declared about itself (§12).
 *
 * A class method, an instance method or an `extend` resolver runs userland code
 * holding the model directly. There is no filter for the engine to merge into
 * and no hook underneath it that knows a request is happening, so a scope
 * configured for that model simply does not apply there — quietly, which is the
 * problem. The three answers are: route the work back through the engine (best,
 * and requires nothing here), claim the filter and apply it yourself
 * ({@link scopeAware}), or admit the surface is unscoped ({@link unscoped}).
 *
 * `"conflict"` is both markers at once, which is a contradiction rather than a
 * disposition and is reported as one.
 */
export type ScopeDisposition = "aware" | "unscoped" | "conflict" | undefined;

function mark<T extends object>(value: T, property: string): T {
  // Non-enumerable: these ride on the method itself so the admission sits in the
  // diff next to the code it excuses, and a marker that showed up in
  // `Object.keys` would leak into anything that serialises a definition.
  Object.defineProperty(value, property, {
    value: true, enumerable: false, writable: false, configurable: true,
  });
  return value;
}

/**
 * Declare that a method resolves the scope itself.
 *
 * The engine hands it the resolved filter and cannot verify it was applied —
 * which is exactly why the claim has to be explicit and greppable rather than
 * inferred. See {@link ScopeDisposition}.
 */
export function scopeAware<T extends object>(value: T): T {
  return mark(value, "scopeAware");
}

/**
 * Declare that a method deliberately runs unscoped.
 *
 * An admission, not a suppression: it is the same one line as
 * {@link scopeAware}, so the cheap answer is not the silent one.
 */
export function unscoped<T extends object>(value: T): T {
  return mark(value, "unscoped");
}

/**
 * Read a surface's disposition, from the wrappers above or from plain
 * properties.
 *
 * Plain properties are read too because the SQL class-method form is a
 * descriptor object a deployment authors as a literal — `{query, args,
 * unscoped: true}` is the natural spelling there, and demanding a wrapper call
 * around an object literal would buy nothing.
 */
export function scopeDispositionOf(value: unknown): ScopeDisposition {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const marked = value as { scopeAware?: unknown; unscoped?: unknown };
  const aware = marked.scopeAware === true;
  const opted = marked.unscoped === true;
  if (aware && opted) {
    return "conflict";
  }
  return aware ? "aware" : (opted ? "unscoped" : undefined);
}

/** Logical combinators in the portable vocabulary, in the casing `guards.ts` matches. */
const PORTABLE_LOGICAL_OPERATORS = ["and", "or", "not"];

const LOGICAL_BY_LOWER: { [lower: string]: string } = PORTABLE_LOGICAL_OPERATORS
  .reduce((o: { [lower: string]: string }, op) => {
    o[op] = op;
    return o;
  }, {});

/**
 * Rewrite `AND` / `Or` / `NOT` to lowercase throughout a portable filter.
 *
 * `assertFilterAllowed` and `assertOrderAllowed` match combinators lowercased
 * (`guards.ts`), so a scope emitting `AND` would take a different path through
 * validation than one emitting `and` — and, worse, an adapter that dispatches
 * on the exact key would read it as a field name. Normalising on the way in
 * costs one walk and removes the whole class of problem.
 */
export function normaliseScopeWhere<T>(where: T): T {
  if (Array.isArray(where)) {
    return where.map((entry) => normaliseScopeWhere(entry)) as unknown as T;
  }
  if (!where || typeof where !== "object") {
    return where;
  }
  const clause = where as { [key: string]: unknown };
  const out: { [key: string]: unknown } = {};
  for (const key of Object.keys(clause)) {
    const canonical = LOGICAL_BY_LOWER[key.toLowerCase()];
    if (canonical) {
      out[canonical] = normaliseScopeWhere(clause[key]);
    } else {
      out[key] = clause[key];
    }
  }
  return out as unknown as T;
}

function isEmptyWhere(where: PortableWhere | undefined): boolean {
  return !where || typeof where !== "object" || Object.keys(where).length === 0;
}

/**
 * AND a scope's filter onto the caller's, without either being able to displace
 * the other.
 *
 * Two things this deliberately does **not** do. It does not spread
 * (`{...userWhere, ...scopeWhere}` clobbers on any shared key, in whichever
 * direction the author happened to write it), and it does not concatenate into
 * an `and` the caller already sent — that would let a crafted `and` shape
 * influence where the scope lands. The scope is always its own branch of a
 * fresh `and`.
 */
export function mergeScopeWhere(
  userWhere: PortableWhere | undefined,
  scopeWhere: PortableWhere | undefined,
): PortableWhere | undefined {
  const scoped = isEmptyWhere(scopeWhere) ? undefined : normaliseScopeWhere(scopeWhere);
  if (!scoped) {
    return userWhere;
  }
  if (isEmptyWhere(userWhere)) {
    return scoped;
  }
  return { and: [userWhere, scoped] };
}

function asResolvedScope(result: ScopeResult, defName: string, operation: ScopeOperation): ResolvedScope {
  if (result === undefined || result === null) {
    return undefined;
  }
  if (result === false) {
    return false;
  }
  if (typeof result !== "object" || Array.isArray(result)) {
    // `true` is the tempting mistake — "allowed" — and it would read as
    // unscoped, which is the same as no opinion but arrived at by accident.
    throw new ScopeConfigurationError(
      `permission.scope returned ${JSON.stringify(result)} for ${defName}/${operation}. ` +
      "Return a portable filter, {where, set}, false to deny, or undefined for no opinion.",
    );
  }
  const shaped = result as { where?: PortableWhere; set?: { [field: string]: unknown }; native?: unknown };
  const isEnvelope = "where" in shaped || "set" in shaped || "native" in shaped;
  if (!isEnvelope) {
    return { where: normaliseScopeWhere(result as PortableWhere) };
  }
  return {
    where: isEmptyWhere(shaped.where) ? undefined : normaliseScopeWhere(shaped.where),
    set: shaped.set,
    native: shaped.native,
  };
}

/**
 * Resolve `permission.scope` for one (model, operation, principal).
 *
 * This is what `scope` gets *instead of* {@link isAllowed}, and it owns the
 * fail-closed asymmetry the rest of the bag does not have:
 *
 *  - an absent key, or a predicate with no opinion, imposes no restriction —
 *    backwards compatible, and consistent with the rest of the bag;
 *  - a predicate that **throws** denies. Propagating it would put a 500 in
 *    front of an edge that may well retry the request unauthenticated;
 *  - a {@link ScopeConfigurationError} is rethrown, because a scope that cannot
 *    be expressed is a deployment bug and must not masquerade as an empty page;
 *  - a return value that is neither a filter, an envelope, `false` nor
 *    `undefined` is a configuration error rather than something to coerce.
 */
export async function resolveScope(
  permission: Permission | undefined,
  defName: string,
  operation: ScopeOperation,
  context: RequestContext,
): Promise<ResolvedScope> {
  const predicate = permission?.scope;
  if (typeof predicate !== "function") {
    return undefined;
  }
  let result: ScopeResult;
  try {
    result = await predicate(defName, operation, permission?.options, context);
  } catch (error) {
    if (error instanceof ScopeConfigurationError) {
      throw error;
    }
    // Userland decided badly. Deny, and say so somewhere a deployment can see
    // it — a scope that silently became "deny everything" is otherwise
    // indistinguishable from an empty table.
    log.warn(
      `permission.scope threw resolving ${defName}/${operation}; denying. ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  return asResolvedScope(result, defName, operation);
}

/**
 * Compose several scope sources into one predicate.
 *
 * `false` from any source short-circuits — a deny cannot be widened by another
 * source's filter. `undefined` sources are skipped, and the surviving `where`s
 * become one `and`, so a caller adding a source can only ever narrow the
 * result. That is the property worth having: there are no precedence rules to
 * get subtly wrong.
 *
 * `set` is the exception, because two forced values for the same field are not
 * composable: two sources naming different owners is a contradiction, and
 * silently picking one is the worst available answer. It denies, symmetrically
 * with a client value conflicting with a forced one.
 */
export function andScopes(...sources: (ScopePredicate | undefined)[]): ScopePredicate {
  const predicates = sources.filter((source): source is ScopePredicate => typeof source === "function");
  return async(defName, operation, options, context) => {
    const wheres: PortableWhere[] = [];
    const set: { [field: string]: unknown } = {};
    let natives: unknown[] = [];
    let opinionated = false;
    for (const predicate of predicates) {
      const resolved = asResolvedScope(
        await predicate(defName, operation, options, context), defName, operation,
      );
      if (resolved === false) {
        return false;
      }
      if (!resolved) {
        continue;
      }
      opinionated = true;
      if (resolved.where) {
        wheres.push(resolved.where);
      }
      if (resolved.native !== undefined) {
        natives = natives.concat(resolved.native);
      }
      for (const field of Object.keys(resolved.set || {})) {
        const value = (resolved.set as { [field: string]: unknown })[field];
        if (field in set && set[field] !== value) {
          // Two sources forcing different owners. Denying is the only answer
          // that cannot be wrong; picking one would hide the contradiction.
          log.warn(
            `andScopes: sources disagree on the forced value of ${defName}.${field} ` +
            `for ${operation}; denying.`,
          );
          return false;
        }
        set[field] = value;
      }
    }
    if (!opinionated) {
      return undefined;
    }
    const combined: { where?: PortableWhere; set?: { [field: string]: unknown }; native?: unknown } = {};
    if (wheres.length === 1) {
      combined.where = wheres[0];
    } else if (wheres.length > 1) {
      combined.where = { and: wheres };
    }
    if (Object.keys(set).length > 0) {
      combined.set = set;
    }
    if (natives.length === 1) {
      combined.native = natives[0];
    } else if (natives.length > 1) {
      combined.native = natives;
    }
    return combined;
  };
}
