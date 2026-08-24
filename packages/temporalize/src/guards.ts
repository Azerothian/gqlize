import { ApplicationFailure } from "@temporalio/common";
import { isAllowed, isMutationAllowed } from "@azerothian/utilize";
import * as shared from "@azerothian/utilize/guards";
import type { Fail, GuardFailure, Permission } from "@azerothian/utilize";
import { ErrorType } from "./workflow-types";
import type { CallerContext, PlainRow } from "./workflow-types";
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
 * The `Fail` the shared guards in `@azerothian/utilize/guards` are given: it
 * maps their transport-neutral failure kinds onto this package's `ErrorType`
 * vocabulary and namespaces the message, so a guard rejection is
 * indistinguishable from one raised here directly.
 */
const GUARD_ERROR_TYPE: {[K in GuardFailure]: string} = {
  "read-only": ErrorType.Forbidden,
  "denied-field": ErrorType.Forbidden,
  "unscoped-mutation": ErrorType.UnscopedMutation,
};
const guardFail: Fail = (kind, message) => fail(GUARD_ERROR_TYPE[kind], `temporalize: ${message}`);

/**
 * The opaque per-call context. temporalize does not prescribe its shape, but it
 * must be present and be an object — it is the carrier for the caller's identity
 * and role, and `resolvePermission` derives the whole permission gate from it.
 */
export function requireContext(req: unknown): CallerContext {
  if (!req || typeof req !== "object") {
    fail(ErrorType.ContextMissing, "temporalize: activity input must be an object carrying a 'context'");
  }
  const context = (req as { context?: unknown }).context;
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
export function assertPagination(limit: unknown, offset: unknown): void {
  if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)) {
    fail(ErrorType.Validation, "temporalize: 'limit' must be a positive integer");
  }
  if (offset !== undefined && (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0)) {
    fail(ErrorType.Validation, "temporalize: 'offset' must be a non-negative integer");
  }
}

export function assertWritable(readOnly?: boolean): void {
  shared.assertWritable(readOnly, guardFail);
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

/** Guard against unscoped bulk mutations — see `@azerothian/utilize/guards`. */
export function assertScopedMutation(where: unknown, optIn?: boolean): void {
  shared.assertScopedMutation(where, optIn, "all: true", guardFail);
}

/** Validate that every filter field is permitted — see `@azerothian/utilize/guards`. */
export function assertFilterAllowed(permission: Permission | undefined, name: string, where: unknown): void {
  shared.assertFilterAllowed(permission, name, where, guardFail);
}

/** Validate that every `orderBy` field is permitted for the model. */
export function assertOrderAllowed(permission: Permission | undefined, name: string, orderBy: unknown): void {
  shared.assertOrderAllowed(permission, name, orderBy, guardFail);
}

/** Parse `input` through the model's create/update schema, if one exists. */
export function validateInput(schemas: SchemaSet, name: string, kind: "create" | "update", input: PlainRow): PlainRow {
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
 * Flatten an ORM instance to plain JSON. Instances are not safely serializable
 * into a Temporal activity result — they carry adapter internals and circular
 * references — so every result goes through this before it leaves the activity.
 */
export const toPlain = shared.toPlain;

/**
 * Strip permission-denied fields from an output value for model `name`, using
 * the generated `entity` schema's shape as the allow-list. When no schema
 * exists for the model, the value is returned unchanged.
 */
export function project(schemas: SchemaSet, name: string, v: unknown): unknown {
  const schema = schemas.entity[name];
  return shared.project(v, schema && new Set(Object.keys(schema.shape)));
}

/** `project(toPlain(v))` — the standard activity result path. */
export function present(schemas: SchemaSet, name: string, v: unknown): unknown {
  return project(schemas, name, toPlain(v));
}
