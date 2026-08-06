import { ApplicationFailure } from "@temporalio/common";
import { isAllowed, isFieldAllowed, isModelAllowed, isMutationAllowed } from "@azerothian/utilize";
import type { Permission } from "@azerothian/utilize";
import { ErrorType } from "./workflow-types";
import type { SchemaSet } from "./registry";

/**
 * Every guard failure here is a *caller* error — a bad model name, a denied
 * field, an unscoped bulk delete. Raising these as retryable would make Temporal
 * re-run a permanently-failing activity until the retry policy gives up, so they
 * are always non-retryable. Adapter/DB errors are deliberately not wrapped: they
 * propagate untouched so the configured retry policy applies to them.
 */
export function fail(type: string, message: string): never {
  throw ApplicationFailure.nonRetryable(message, type);
}

/**
 * The opaque per-call context. temporalize does not prescribe its shape, but it
 * must be present and be an object — it is the carrier for the caller's identity
 * and role, and `resolvePermission` derives the whole permission gate from it.
 */
export function requireContext(req: any): any {
  if (!req || typeof req !== "object") {
    fail(ErrorType.ContextMissing, "temporalize: activity input must be an object carrying a 'context'");
  }
  const context = req.context;
  if (context === undefined || context === null || typeof context !== "object") {
    fail(
      ErrorType.ContextMissing,
      "temporalize: every activity call requires a 'context' object identifying the caller (e.g. { userId, role })"
    );
  }
  // `Ormize.withTransaction` honours an explicit `context.transaction` as-is,
  // bypassing its own coordinator. The context arrives as JSON from workflow
  // input, so allowing that key would let a caller opt out of transaction
  // management — and a transaction handle cannot survive serialization anyway.
  if ("transaction" in context) {
    fail(ErrorType.Validation, "temporalize: 'context.transaction' is not allowed");
  }
  return context;
}

/** Reject nonsensical pagination before it reaches the driver as raw SQL. */
export function assertPagination(limit: any, offset: any): void {
  if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)) {
    fail(ErrorType.Validation, "temporalize: 'limit' must be a positive integer");
  }
  if (offset !== undefined && (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0)) {
    fail(ErrorType.Validation, "temporalize: 'offset' must be a non-negative integer");
  }
}

/** Resolve a model name from untrusted input, honoring `isModelAllowed`. */
export function mustResolveModel(registry: { resolve(m: unknown): string | undefined }, model: unknown, permission?: Permission): string {
  const name = registry.resolve(model);
  if (!name || !isModelAllowed(permission, name)) {
    fail(ErrorType.UnknownModel, `temporalize: unknown or not permitted model '${String(model)}'`);
  }
  return name;
}

export function assertWritable(readOnly?: boolean): void {
  if (readOnly) {
    fail(ErrorType.Forbidden, "temporalize: worker is read-only");
  }
}

export function assertMutationAllowed(permission: Permission | undefined, name: string, kind: "create" | "update" | "delete"): void {
  // `isMutationAllowed` only consults the per-kind predicates
  // (`mutationCreate`/`mutationUpdate`/`mutationDelete`). The umbrella
  // `permission.mutation` gate is honoured by gqlize at schema-build time — it
  // omits the mutation root entirely — but there is no schema to shape here, so
  // check it explicitly. Without this, a role configured with
  // `{ mutation: "deny" }` would keep full write access through Temporal.
  if (!isAllowed(permission?.mutation, name, permission?.options)) {
    fail(ErrorType.Forbidden, `temporalize: mutations not allowed for ${name}`);
  }
  if (!isMutationAllowed(permission, name, kind)) {
    fail(ErrorType.Forbidden, `temporalize: ${kind} not allowed for ${name}`);
  }
}

/**
 * Guard against unscoped bulk mutations. An empty `where` on an update/delete
 * would match — and mutate/destroy — every row in the table, so a non-empty
 * filter is required unless the caller explicitly opts in via `all: true`.
 */
export function assertScopedMutation(where: any, optIn?: boolean): void {
  const hasFilter = where && typeof where === "object" && Object.keys(where).length > 0;
  if (!hasFilter && !optIn) {
    fail(
      ErrorType.UnscopedMutation,
      "temporalize: a 'where' filter is required for a bulk update/delete. Pass all: true to intentionally affect every row."
    );
  }
}

/**
 * Validate that every field referenced by a filter is permitted for the model.
 * Without this a caller could filter on a permission-denied field (e.g. a
 * password hash) and use the returned row count as a boolean oracle to read its
 * value, even though the field never appears in an activity result.
 */
export function assertFilterAllowed(permission: Permission | undefined, name: string, where: any): void {
  if (!where || typeof where !== "object") {
    return;
  }
  const logical = new Set(["and", "or", "not"]);
  for (const key of Object.keys(where)) {
    if (logical.has(key.toLowerCase())) {
      const branch = where[key];
      if (Array.isArray(branch)) {
        branch.forEach((c) => assertFilterAllowed(permission, name, c));
      } else {
        assertFilterAllowed(permission, name, branch);
      }
      continue;
    }
    if (!isFieldAllowed(permission, name, key)) {
      fail(ErrorType.Forbidden, `temporalize: unknown or not permitted filter field '${key}'`);
    }
  }
}

/** Validate that every `orderBy` field is permitted for the model. */
export function assertOrderAllowed(permission: Permission | undefined, name: string, orderBy: any): void {
  if (!Array.isArray(orderBy)) {
    return;
  }
  for (const entry of orderBy) {
    const field = Array.isArray(entry) ? entry[0] : entry;
    if (typeof field === "string" && field && !isFieldAllowed(permission, name, field)) {
      fail(ErrorType.Forbidden, `temporalize: unknown or not permitted order field '${field}'`);
    }
  }
}

/** Parse `input` through the model's create/update schema, if one exists. */
export function validateInput(schemas: SchemaSet, name: string, kind: "create" | "update", input: any): any {
  const schema = kind === "create" ? schemas.create[name] : schemas.update[name];
  if (!schema) {
    return input;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    fail(ErrorType.Validation, `temporalize: invalid ${kind} input for ${name}: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

/**
 * ORM instances are not safely serializable into a Temporal activity result —
 * they carry adapter internals and circular references — so every result is
 * flattened to plain JSON before it leaves the activity.
 */
export function toPlain(v: any): any {
  if (Array.isArray(v)) {
    return v.map((x) => toPlain(x));
  }
  if (v && typeof v.toJSON === "function") {
    return v.toJSON();
  }
  if (v && typeof v.get === "function") {
    return v.get({ plain: true });
  }
  return v;
}

/**
 * Strip permission-denied fields from an output value for model `name`.
 *
 * The generated `entity` schema only contains fields/relationships that pass
 * `isFieldAllowed`/`isRelationshipAllowed`, so its shape keys are exactly the
 * output allow-list. This closes the leak where a denied column (e.g. a password
 * hash) or an adapter-internal attribute (e.g. `full_count`) would otherwise be
 * serialized straight from the raw ORM instance. When no schema exists for the
 * model, the value is returned unchanged.
 */
export function project(schemas: SchemaSet, name: string, v: any): any {
  if (Array.isArray(v)) {
    return v.map((x) => project(schemas, name, x));
  }
  if (!v || typeof v !== "object") {
    return v;
  }
  const schema = schemas.entity[name];
  if (!schema) {
    return v;
  }
  const allowed = new Set(Object.keys(schema.shape));
  const out: any = {};
  for (const key of Object.keys(v)) {
    if (allowed.has(key)) {
      out[key] = v[key];
    }
  }
  return out;
}

/** `project(toPlain(v))` — the standard activity result path. */
export function present(schemas: SchemaSet, name: string, v: any): any {
  return project(schemas, name, toPlain(v));
}
