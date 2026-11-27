// Global filters (RFC §5): static model-level filters AND-ed into every
// chokepoint alongside the row-level scope.
//
// A global filter is the same for every caller, cannot reference the principal,
// and applies to `read`/`update`/`delete` (never `create`). The built-in
// `deleted` filter (soft delete) routes through the same machinery, controlled
// by the existing `deleted` argument rather than `withoutFilters`.

import { AsyncLocalStorage } from "node:async_hooks";
import type { PortableWhere, ScopeOperation, GlobalFilterDeclaration, GlobalFilterOperation } from "@azerothian/utilize/gate";
import { ScopeConfigurationError, mergeScopeWhere } from "@azerothian/utilize/gate";
import type { Definition } from "../types";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Operations a user may list; `create` is never valid. */
const VALID_OPERATIONS = new Set<string>(["read", "update", "delete"]);

/**
 * Validate every global filter on a definition.  Called from `initialise`.
 *
 * Throws `ScopeConfigurationError` for:
 *  - `create` in the `operations` list
 *  - an empty `where`
 *  - a function in `where` (would need the principal, which global filters forbid)
 */
export function validateFilters(defName: string, filters: { [name: string]: GlobalFilterDeclaration }): void {
  for (const [filterName, decl] of Object.entries(filters)) {
    if (!decl || typeof decl !== "object") {
      throw new ScopeConfigurationError(
        `Global filter '${filterName}' on '${defName}' must be an object with a 'where' key.`,
      );
    }
    if (!decl.where || typeof decl.where !== "object" || Object.keys(decl.where).length === 0) {
      throw new ScopeConfigurationError(
        `Global filter '${filterName}' on '${defName}' has an empty or missing 'where'.`,
      );
    }
    if (typeof decl.where === "function") {
      throw new ScopeConfigurationError(
        `Global filter '${filterName}' on '${defName}' has a function as 'where'. ` +
        "Global filters are static; anything caller-dependent belongs in scope.",
      );
    }
    if (decl.operations) {
      for (const op of decl.operations) {
        if (!VALID_OPERATIONS.has(op)) {
          throw new ScopeConfigurationError(
            `Global filter '${filterName}' on '${defName}' lists operation '${op}'. ` +
            "Only 'read', 'update' and 'delete' are valid; 'create' has no rows to filter.",
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage for `withoutFilters`
// ---------------------------------------------------------------------------

/** The set of global filter names currently bypassed in this async context. */
const bypassStore = new AsyncLocalStorage<Set<string>>();

/**
 * Run `fn` with the named global filters lifted.  Nested calls union their
 * names: a `withoutFilters(["a"])` around a `withoutFilters(["b"])` lifts both.
 * Scope is never lifted.
 */
export function withoutFilters<T>(names: string[], fn: () => T | Promise<T>): T | Promise<T> {
  const current = bypassStore.getStore();
  const merged = new Set(current);
  for (const n of names) {
    merged.add(n);
  }
  return bypassStore.run(merged, fn);
}

/** The filter names currently bypassed, or an empty set. */
export function bypassedFilterNames(): ReadonlySet<string> {
  return bypassStore.getStore() || EMPTY_SET;
}
const EMPTY_SET: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Default operations when none are declared: all three. */
const ALL_OPS: GlobalFilterOperation[] = ["read", "update", "delete"];

/**
 * Resolve the merged `PortableWhere` for every applicable global filter on a
 * model, for one operation.  `undefined` when no filter applies.
 *
 * The `deleted` built-in filter is NOT handled here — it is wired separately
 * through the adapter's `deletedOverlay` / `paranoid` mechanism, and optionally
 * lifted by the `deleted` argument.
 */
export function resolveGlobalFilters(
  def: Definition | undefined,
  operation: ScopeOperation,
): PortableWhere | undefined {
  if (!def?.options?.filters || operation === "create") {
    return undefined;
  }
  const bypassed = bypassedFilterNames();
  let merged: PortableWhere | undefined;
  const filters = def.options.filters;
  for (const [filterName, decl] of Object.entries(filters)) {
    if (bypassed.has(filterName)) {
      continue;
    }
    const ops = decl.operations || ALL_OPS;
    if (!(ops as readonly string[]).includes(operation)) {
      continue;
    }
    merged = mergeScopeWhere(merged, decl.where);
  }
  return merged;
}

/**
 * A stable cache-key suffix that encodes which filters are currently bypassed
 * for a model.  Empty string when none are bypassed.
 */
export function filterBypassCacheKey(def: Definition | undefined): string {
  if (!def?.options?.filters) {
    return "";
  }
  const bypassed = bypassedFilterNames();
  if (bypassed.size === 0) {
    return "";
  }
  const filterNames = Object.keys(def.options.filters);
  const active = filterNames.filter((n) => bypassed.has(n)).sort();
  return active.length > 0 ? `~gf:${active.join(",")}` : "";
}
