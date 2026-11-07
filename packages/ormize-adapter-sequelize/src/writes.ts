// Write operations: create, update, delete, and restore functions. The adapter
// class in `index.ts` delegates here.

import type { Sequelize } from "sequelize";
import type {
  AdapterCreateFunction,
  AdapterDeleteFunction,
  AdapterQueryOptions,
  AdapterRestoreFunction,
  AdapterRow,
  AdapterUpdateFunction,
  AdapterWhere,
  WhereOperators,
} from "@azerothian/utilize/types/index";
import type { SequelizeRow } from "./types/query";
import { deletedOverlay } from "./query-options";
import type { QueryOptionsHost } from "./query-options";

/**
 * What the write functions reach into.
 */
export interface WriteHost extends QueryOptionsHost {
  processFilterArgument(
    where: AdapterWhere | undefined,
    whereOperators: WhereOperators | undefined,
    options: AdapterQueryOptions,
  ): Promise<AdapterWhere>;
}

export function getCreateFunctionImpl(
  sequelize: Sequelize,
  defName: string,
): AdapterCreateFunction {
  const Model = sequelize.models[defName];
  return (input, options) => {
    return Model.create(input, options);
  };
}

export function getUpdateFunctionImpl(
  host: WriteHost,
  sequelize: Sequelize,
  defName: string,
  whereOperators: WhereOperators | undefined,
): AdapterUpdateFunction {
  const Model = sequelize.models[defName];
  return async (where, processInput, options) => {
    const items = await Model.findAll({
      where: await host.processFilterArgument(where, whereOperators, options),
      ...options,
    });
    return Promise.all(
      items.map(async (i) => {
        const input = await processInput(i);
        if (Object.keys(input).length > 0) {
          return i.update(input, options);
        }
        return i;
      })
    );
  };
}

/**
 * The shared body of {@link getDeleteFunctionImpl} and
 * {@link getRestoreFunctionImpl}: find the matching rows, then run one
 * Sequelize instance verb over each.
 *
 * Serially, and awaited — this is the load-bearing part, and the reason the two
 * were worth merging rather than left as near-copies carrying the same warning
 * twice. Returning the array of un-awaited promises previously let callers (and
 * subsequent queries) run before the writes had landed, which was both a
 * correctness bug and a flake.
 *
 * `buildFind` is a callback rather than an options overlay because the two
 * verbs compose their find options in a different *order* — delete puts the
 * caller's `options` last, restore puts them first — and quietly normalising
 * that would change which side wins a key present in both.
 */
function rowVerbFunction(
  host: WriteHost,
  sequelize: Sequelize,
  defName: string,
  whereOperators: WhereOperators | undefined,
  verb: "destroy" | "restore",
  buildFind: (nativeWhere: AdapterWhere, options: AdapterQueryOptions) => AdapterQueryOptions,
) {
  const Model = sequelize.models[defName];
  return async (
    where: AdapterWhere,
    options: AdapterQueryOptions,
    before: (row: AdapterRow) => Promise<AdapterRow> | AdapterRow,
    after: (row: AdapterRow) => Promise<AdapterRow> | AdapterRow,
  ): Promise<AdapterRow[]> => {
    const native = await host.processFilterArgument(where, whereOperators, options);
    const items = await Model.findAll(buildFind(native, options) as object);
    const results: AdapterRow[] = [];
    for (const item of items) {
      // `before`/`after` are declared over the contract's opaque
      // {@link AdapterRow}, not this adapter's row: they are arrow-syntax
      // aliases, so a narrowed *return* would not survive the variance flip.
      // What comes back is still the row that went in.
      const row = (await before(item)) as SequelizeRow;
      await row[verb](options);
      results.push(await after(row));
    }
    return results;
  };
}

export function getDeleteFunctionImpl(
  host: WriteHost,
  sequelize: Sequelize,
  defName: string,
  whereOperators: WhereOperators | undefined,
): AdapterDeleteFunction {
  return rowVerbFunction(host, sequelize, defName, whereOperators, "destroy",
    (native, options) => ({ where: native, ...options }));
}

/**
 * The mirror of {@link getDeleteFunctionImpl} for a paranoid model.
 *
 * The find runs with `paranoid: false` — otherwise it could not see the rows
 * it is meant to bring back — and is narrowed to rows that are actually soft
 * deleted, so restoring an already-live row is a no-op rather than a touch.
 * That is the same narrowing the relationship-level `restore` sub-mutation
 * already does.
 */
export function getRestoreFunctionImpl(
  host: WriteHost,
  sequelize: Sequelize,
  defName: string,
  whereOperators: WhereOperators | undefined,
): AdapterRestoreFunction {
  const column = host.deletedAtColumn(defName);
  const run = rowVerbFunction(host, sequelize, defName, whereOperators, "restore", (native, options) => ({
    ...options,
    // `deletedOverlay(..., "ONLY", ...)` is exactly this narrowing, and is
    // already what every read path uses — reusing it keeps one spelling of a
    // security-adjacent filter rather than a second hand-rolled `Op.and`.
    ...deletedOverlay(host, defName, "ONLY", native),
  }));
  return (async (where, options, before, after) => {
    if (!column) {
      throw new Error(`restore is not available for ${defName}: the model does not soft delete`);
    }
    return run(where, options, before, after);
  });
}
