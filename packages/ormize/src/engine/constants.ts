// Constants, hook lists, and lightweight types shared across the engine modules.
//
// Extracted from `manager.ts` so the file's 2300 lines could be read in
// cohesive pieces. Nothing here is new — every symbol existed inside the class
// or at module scope, and the split is a pure move.

import waterfall from "@azerothian/utilize/utils/waterfall";
import type { OrmAdapter } from "@azerothian/utilize/types/index";
import { RelationshipType as RelType } from "@azerothian/utilize/types/index";
import type { Relationship } from "../types";

/** The relationship types ormize knows how to wire; `Relationship.type` is a widened string. */
export const relationshipTypes: string[] = Object.values(RelType);

/**
 * The relationship types whose read accessor names one row rather than many —
 * `getAuthor`, not `getAuthors`. Everything else pluralises.
 */
export const SINGULAR_ACCESSOR = new Set<string>([RelType.BelongsTo, RelType.HasOne]);

/**
 * Model hooks that fire after an adapter wrote rows. Each one invalidates the
 * read cache for the model it fired on. This catches writes that never go
 * through a `process*` entry point: userland calling `db.models.X.create`, or
 * a Sequelize association writing its join table.
 */
export const WRITE_HOOKS = new Set([
  "afterCreate", "afterDestroy", "afterRestore", "afterUpdate", "afterSave", "afterUpsert",
  "afterBulkCreate", "afterBulkDestroy", "afterBulkRestore", "afterBulkUpdate",
]);

/**
 * Hooks that run inside the adapter call a cached read stands in for. On a hit
 * they don't run, so a model with any of them isn't cached by default (see
 * `CacheOptions.hooks`). `afterCount` and an included model's `afterFind` are
 * not here, because ormize fires those itself after the read returns, hit or
 * miss.
 */
export const OPAQUE_READ_HOOKS: Record<string, string[]> = {
  findAll: ["beforeFind", "beforeFindAfterExpandIncludeAll", "beforeFindAfterOptions", "afterFind"],
  count: ["beforeCount"],
};

export const hookList = [
  "beforeValidate",
  "afterValidate",
  "validationFailed",
  "beforeCreate",
  "afterCreate",
  "beforeDestroy",
  "afterDestroy",
  "beforeRestore",
  "afterRestore",
  "beforeUpdate",
  "afterUpdate",
  "beforeSave",
  "afterSave",
  "beforeUpsert",
  "afterUpsert",
  "beforeBulkCreate",
  "afterBulkCreate",
  "beforeBulkDestroy",
  "afterBulkDestroy",
  "beforeBulkRestore",
  "afterBulkRestore",
  "beforeBulkUpdate",
  "afterBulkUpdate",
  "beforeFind",
  "beforeFindAfterExpandIncludeAll",
  "beforeFindAfterOptions",
  "afterFind",
  "beforeCount",
  "beforeAssociate",
  "afterAssociate",
  "beforeSync",
  "afterSync",
];

/**
 * Sequelize-*instance* hooks. `runHooks` concatenates a model's hooks with the
 * Sequelize instance's, so hooks propagate Model → Sequelize and never the
 * reverse (sequelize/lib/hooks.js). Six of these are flagged `noModel`, and the
 * other four are fired off the instance — either way `sequelize.define` accepts
 * them without complaint and files them where nothing will ever call them.
 *
 * They are therefore global-only: there is no model to scope them to, so a
 * per-definition `def.hooks.beforeQuery` is refused with a warning rather than
 * silently registered. Unlike the model hooks above they are handed Sequelize's
 * own arguments unchanged instead of the `(defName, value, ...args)` shape, and
 * what they return is discarded — Sequelize discards it too, so these hooks
 * work by mutating the options object they are given.
 */
export const sequelizeHookList = [
  "beforeDefine",
  "afterDefine",
  "beforeInit",
  "afterInit",
  "beforeConnect",
  "afterConnect",
  "beforeBulkSync",
  "afterBulkSync",
  "beforeQuery",
  "afterQuery",
];

export const sequelizeHookSet = new Set(sequelizeHookList);

// gqlize-level hooks that Sequelize has no notion of — they are composed into the
// per-definition hook map (so `runHook` can fire them) but are NOT registered on
// the Sequelize model (passing an unknown hook name to `sequelize.define` throws).
export const gqlizeHookList = [
  "afterCount",
];

/**
 * A lifecycle hook: it receives the value flowing through the operation plus
 * whatever the emitting site passes along, and returns the value to carry on
 * with. `any` on the tail is the variadic pass-through case — the extra
 * arguments differ per hook and ormize only relays them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- exported (part of the v6 public surface): a hook takes/returns whatever shape flows through the operation it's attached to, and the extra args are relayed verbatim, never inspected
export type HookFunction = (value: any, ...args: any[]) => any;

/**
 * Run a hook entry — a single function or an array of them — through a
 * waterfall. `makeArgs(waterfallValue)` builds the argument list for each call,
 * so the same helper serves both definition hooks `(value, ...args)` and global
 * hooks `(defName, value, ...args)`.
 *
 * May return a promise or a plain value (a lone hook's own return); callers
 * always `await` it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- relays the `any` contract of `HookFunction` above
export function runHookEntry(entry: HookFunction | HookFunction[] | undefined, value: any, makeArgs: (v: any) => [any, ...any[]]) {
  if (!entry) {
    return value;
  }
  if (Array.isArray(entry)) {
    return entry.length > 0
      ? waterfall(entry, (hook: HookFunction, f: unknown) => hook(...makeArgs(f)), value)
      : value;
  }
  return entry(...makeArgs(value));
}

/**
 * A relationship after ormize has wired it, as stored in {@link Ormize.relationships}.
 *
 * `internal` says whether the source and target share an adapter — a `true`
 * relationship was handed to the adapter to create natively, and the keys below
 * it are the adapter's business. `false` means ormize resolves it itself, and
 * everything from `funcName` down is what it needs to do that.
 */
export type WiredRelationship = {
  sourceAdapter: OrmAdapter;
  targetAdapter: OrmAdapter;
  type: Relationship["type"];
  model: string;
  name: string;
  options: Relationship["options"];
  internal?: boolean;
  /** Cross-adapter only: the accessor installed on the source model (`getFiles`). */
  funcName?: string;
  foreignKey?: string;
  sourceKey?: string;
  targetKey?: string;
  /** `belongsToMany` only — see {@link Association.through}. */
  through?: string;
  otherKey?: string;
};
