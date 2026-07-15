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
