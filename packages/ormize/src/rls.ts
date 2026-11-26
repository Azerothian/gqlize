// The `@azerothian/ormize/rls` entry point: helpers for declaring Postgres
// row-level security policies in model definitions.
//
// `rls.setting(name, type)` produces a marker the policy compiler translates
// into `(SELECT nullif(current_setting('<name>', true), '')::<type>)`.
// `sql` is a tagged template for raw SQL fragments in policy declarations.

// Re-export the marker types from utilize so callers that import from here get
// the same types that the definition schema uses.
export type { RlsSetting, RlsSqlFragment as SqlFragment } from "@azerothian/utilize/types/definitions";
export { isRlsSetting, isRlsSqlFragment as isSqlFragment } from "@azerothian/utilize/types/definitions";
export type { RlsOptions, RlsPolicyDeclaration, RlsPolicyCommand } from "@azerothian/utilize/types/definitions";

import type { RlsSetting } from "@azerothian/utilize/types/definitions";
import type { RlsSqlFragment } from "@azerothian/utilize/types/definitions";

/**
 * Allowed Postgres types for `rls.setting()`. Kept deliberately narrow: each
 * type is cast inside `current_setting(…)`, so an unsupported type would
 * produce a runtime cast error on every query. Array forms use
 * `string_to_array(…, ',')` before the cast.
 */
export const ALLOWED_SETTING_TYPES = new Set([
  "text", "uuid", "integer", "int", "bigint", "boolean",
  "text[]", "uuid[]", "integer[]", "int[]", "bigint[]",
]);

/**
 * Strict pattern for Postgres custom setting names. Postgres custom settings
 * use a dotted `category.name` form (`app.user_id`). We allow identifier-like
 * segments separated by dots.
 */
const SETTING_NAME_PATTERN = /^[a-z_][a-z0-9_.]*$/i;

/**
 * Reference a Postgres session setting for use inside an RLS policy.
 *
 * @param name  The setting name, e.g. `"app.user_id"`. Must match the
 *              identifier pattern `[a-z_][a-z0-9_.]*`.
 * @param type  The Postgres type to cast to. Array types (e.g. `"uuid[]"`)
 *              use `string_to_array(…, ',')` before the cast.
 */
function setting(name: string, type: string): RlsSetting {
  if (!SETTING_NAME_PATTERN.test(name)) {
    throw new Error(
      `rls.setting: invalid setting name '${name}'. ` +
      `Names must match [a-z_][a-z0-9_.]* (e.g. 'app.user_id').`,
    );
  }
  const normalised = type.toLowerCase().replace(/\s+/g, "");
  if (!ALLOWED_SETTING_TYPES.has(normalised)) {
    throw new Error(
      `rls.setting: unsupported type '${type}'. ` +
      `Allowed types: ${Array.from(ALLOWED_SETTING_TYPES).join(", ")}.`,
    );
  }
  return { __rlsSetting: true, name, type: normalised };
}

/**
 * Tagged template for raw SQL fragments inside a policy declaration.
 *
 * Usage: `sql\`true\`` or `sql\`"tenantId" = current_setting('app.tenant_id')\``.
 *
 * No interpolation is supported on purpose — policies are DDL and anything
 * dynamic must go through `rls.setting()`.
 */
export function sql(strings: TemplateStringsArray, ...values: never[]): RlsSqlFragment {
  void values;
  return { __sqlFragment: true, text: strings.join("") };
}

/** The `rls` namespace for use in model definitions. */
export const rls = { setting } as const;

export default rls;
