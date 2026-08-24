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

/** Loose predicate-bag shape (e.g. the object from `createRoleBasedPermissions`). */
export type Permission = {
  options?: any;
  [key: string]: any;
};

/** Mutation kinds that map to `mutationCreate` / `mutationUpdate` / `mutationDelete`. */
export type MutationKind = "create" | "update" | "delete";

/** Call a permission predicate; an absent (non-function) predicate is allow (`true`). */
export function isAllowed(fn: any, ...args: any[]): boolean {
  if (typeof fn !== "function") {
    return true;
  }
  return !!fn(...args);
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
export const PERMISSION_KEYS = [
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
  "queryExtension",
  "mutationExtension",
] as const;

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
