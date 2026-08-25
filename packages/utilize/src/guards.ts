import { isFieldAllowed } from "./gate";
import type { Permission } from "./types/index";

/**
 * The request guards shared by every graphql-free front end.
 *
 * `nestize` and `temporalize` sit in front of the same resolution engine and
 * need the same six checks, but they cannot share an exception type: nestize's
 * failures are HTTP responses (the status code is the contract) and
 * temporalize's must be non-retryable `ApplicationFailure`s (retrying a denied
 * field would re-run a permanently-failing activity until the policy gives up).
 *
 * So the guards take the throw as a parameter. Each host supplies a `Fail` that
 * maps a `GuardFailure` kind onto its own exception; the guard logic — which is
 * the part that must not drift, because it is what stops a caller reading a
 * denied column through a row count — lives here once.
 */

/**
 * Why a guard rejected the call. Deliberately transport-neutral, and split
 * finely enough that a host can give each one its own status: nestize answers
 * `read-only` with 405 and the other two with 400, while temporalize marks
 * `read-only` and `denied-field` as `Forbidden` and `unscoped-mutation` as
 * `UnscopedMutation`. A coarser vocabulary would force one of them to change
 * what it reports.
 */
export type GuardFailure = "read-only" | "denied-field" | "unscoped-mutation";

/** A host's thrower. Must not return — every guard treats it as terminal. */
export type Fail = (kind: GuardFailure, message: string) => never;

/** Reject a write against a read-only host. */
export function assertWritable(readOnly: boolean | undefined, fail: Fail): void {
  if (readOnly) {
    fail("read-only", "Writes are disabled (read-only)");
  }
}

/**
 * Guard against unscoped bulk mutations. An empty `where` on a collection
 * update/delete would match — and mutate/destroy — every row in the table, so a
 * non-empty filter is required unless the caller explicitly opts in.
 *
 * `optInHint` is how *this* host spells the opt-in (`?all=true` over HTTP,
 * `all: true` in an activity input), so the message can tell the caller what to
 * actually type.
 */
export function assertScopedMutation(where: unknown, optIn: boolean | undefined, optInHint: string, fail: Fail): void {
  const hasFilter = where && typeof where === "object" && Object.keys(where).length > 0;
  if (!hasFilter && !optIn) {
    fail(
      "unscoped-mutation",
      `A filter is required for a bulk update/delete. Pass ${optInHint} to intentionally affect every row.`
    );
  }
}

/**
 * Validate that every field referenced by a filter is permitted for the model.
 *
 * Without this a caller could filter on a permission-denied field (e.g. a
 * password hash) and use the returned row count as a boolean oracle to read its
 * value, even though the field never appears in a response.
 *
 * **Invariant: this runs on caller input only, before any `permission.scope`
 * has been merged in.** A scope is entitled to filter on a field the caller may
 * not see — `{ownerId: {eq: me}}` on a model whose `field` gate denies
 * `ownerId` is the *normal* case, not an edge one — because the engine wrote it
 * and the caller cannot influence it. Validating the merged filter would reject
 * exactly the scopes worth writing; validating only the caller's half is what
 * keeps the oracle closed without doing so.
 *
 * The ordering that makes this true lives in `@azerothian/ormize`, which does
 * not import this file, so nothing here can enforce it. It is pinned by a
 * regression test instead.
 */
export function assertFilterAllowed(
  permission: Permission | undefined, name: string, where: unknown, fail: Fail,
): void {
  if (!where || typeof where !== "object") {
    return;
  }
  const clause = where as { [key: string]: unknown };
  for (const key of Object.keys(clause)) {
    if (LOGICAL_OPERATORS.has(key.toLowerCase())) {
      const branch = clause[key];
      if (Array.isArray(branch)) {
        branch.forEach((c) => assertFilterAllowed(permission, name, c, fail));
      } else {
        assertFilterAllowed(permission, name, branch, fail);
      }
      continue;
    }
    if (!isFieldAllowed(permission, name, key)) {
      fail("denied-field", `Unknown or not permitted filter field '${key}'`);
    }
  }
}

/** Combinators whose values are nested clauses, not field names. */
const LOGICAL_OPERATORS = new Set(["and", "or", "not"]);

/** Validate that every `orderBy` field is permitted for the model. */
export function assertOrderAllowed(
  permission: Permission | undefined, name: string, orderBy: unknown, fail: Fail,
): void {
  if (!Array.isArray(orderBy)) {
    return;
  }
  for (const entry of orderBy) {
    const field = Array.isArray(entry) ? entry[0] : entry;
    if (typeof field === "string" && field && !isFieldAllowed(permission, name, field)) {
      fail("denied-field", `Unknown or not permitted order field '${field}'`);
    }
  }
}

/**
 * Flatten an ORM instance (or list of them) to plain JSON. Instances carry
 * adapter internals and circular references, so neither an HTTP response body
 * nor a Temporal activity result can serialize one safely.
 */
export function toPlain(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map((x) => toPlain(x));
  }
  // Duck-typed rather than instance-checked: the instance type belongs to the
  // adapter, and this layer only knows that one of these two escape hatches
  // yields plain JSON.
  const instance = v as { toJSON?: () => unknown; get?: (options: { plain: boolean }) => unknown };
  if (v && typeof instance.toJSON === "function") {
    return instance.toJSON();
  }
  if (v && typeof instance.get === "function") {
    return instance.get({ plain: true });
  }
  return v;
}

/**
 * Strip everything not in `allowed` from an output value.
 *
 * Callers pass the key set of the model's generated `entity` schema, which only
 * contains fields/relationships that pass `isFieldAllowed`/
 * `isRelationshipAllowed` — so it is exactly the output allow-list. This closes
 * the leak where a denied column (e.g. a password hash) or an adapter-internal
 * attribute (e.g. `full_count`) would otherwise be serialized straight off the
 * raw instance. `undefined` means "nothing gated this model": the value is
 * returned unchanged.
 */
export function project(v: unknown, allowed: ReadonlySet<string> | undefined): unknown {
  if (Array.isArray(v)) {
    return v.map((x) => project(x, allowed));
  }
  if (!v || typeof v !== "object" || !allowed) {
    return v;
  }
  const row = v as { [key: string]: unknown };
  const out: { [key: string]: unknown } = {};
  for (const key of Object.keys(row)) {
    if (allowed.has(key)) {
      out[key] = row[key];
    }
  }
  return out;
}

/** `project(toPlain(v))` — the standard result path for both hosts. */
export function present(v: unknown, allowed: ReadonlySet<string> | undefined): unknown {
  return project(toPlain(v), allowed);
}
