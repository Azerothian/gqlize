// Opt-in soft delete.
//
// MikroORM has no soft delete of its own, but `OrmAdapter.softDeletes` and
// `getRestoreFunction` are how the `deleted` argument and the `restore` mutation
// come to exist at all — an adapter that omits them simply has neither. So it is
// implemented here as a column overlay, opted into per entity through the same
// definition key the SQL adapter reads:
//
// ```ts
// new MikroAdapter(mikro, {
//   definitions: { Article: { options: { paranoid: true, deletedAt: "deletedAt" } } },
// })
// ```
//
// A MikroORM global filter would be the more idiomatic mechanism, but a filter
// registered on the instance would apply to the host application's own queries
// too. An adapter must leave the instance it was handed alone.

import type { AdapterWhere, DeletedFilter } from "@azerothian/utilize/types/index";
import { andWhere } from "./query";
import type { MikroModel } from "./model";

/** The default column name, when `paranoid: true` names none. */
const DEFAULT_COLUMN = "deletedAt";

/**
 * The soft-delete column for a model, or `undefined` when it does not soft
 * delete.
 *
 * Both halves matter: the definition has to have asked, *and* the column has to
 * exist. A `paranoid: true` on an entity with no timestamp column would
 * otherwise generate a `deleted` argument that filters on nothing and a
 * `restore` mutation that cannot restore.
 */
export function softDeleteColumn(model: MikroModel): string | undefined {
  const options = model.definition.options;
  if (!options?.paranoid) {
    return undefined;
  }
  const column = typeof options.deletedAt === "string" ? options.deletedAt : DEFAULT_COLUMN;
  return model.fields[column] ? column : undefined;
}

/**
 * Fold the `deleted` argument into a condition.
 *
 * `EXCLUDE` is the default and is what the other backends do unasked, so it is
 * applied whenever the model soft-deletes and nothing said otherwise — a read
 * that forgets the argument must not return rows the model considers gone.
 */
export function deletedOverlay(
  model: MikroModel, deleted: DeletedFilter | undefined, where: AdapterWhere | undefined,
): AdapterWhere | undefined {
  const column = model.softDeleteColumn;
  if (!column || deleted === "INCLUDE") {
    return where;
  }
  return andWhere(where, { [column]: deleted === "ONLY" ? { $ne: null } : null });
}
