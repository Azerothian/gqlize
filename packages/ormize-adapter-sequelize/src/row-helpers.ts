// Row-level helpers: snapshot/restore utilities, windowed-include marking,
// and the module-level functions that operate on Sequelize model instances and
// their eager-loaded include trees.

import { Model, Op } from "sequelize";
import type { AdapterWhere } from "@azerothian/utilize/types/index";
import type { SequelizeInclude, SequelizeRow } from "./types/query";

/**
 * A fetched row seen as the plain object it is at runtime. Relationship
 * accessors (`getTasks`, `countTasks`) and eager-loaded relationship values are
 * reached off an instance by name, and they exist only once Sequelize has wired
 * the association — so `Model` has no index signature describing them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- genuinely untyped ORM boundary: values reached off it are read as plain data (`dataValues`), called as Sequelize-generated accessors (`getTasks(...)`), or spread as eager-loaded rows/arrays, and none of those shapes is knowable from a name that only exists once Sequelize wires the association.
export function rowFields(row: SequelizeRow): Record<string, any> {
  return row;
}

/**
 * Marks a relation's rows that a `separate` include loaded with its own
 * `limit`/`offset`, so `resolveManyRelationship` knows the page is already cut.
 * Non-enumerable: it never reaches serialised output.
 */
const WINDOWED = Symbol("ormize-adapter-sequelize:windowed");

export function isWindowed(rows: unknown): boolean {
  return Array.isArray(rows) && Boolean((rows as unknown as {[WINDOWED]?: boolean})[WINDOWED]);
}

/**
 * Drop repeated rows from a windowed page, keeping the first of each key.
 *
 * Sequelize's grouped limit takes one `ORDER BY … LIMIT` subquery per parent
 * *key*, and when several loaded parents share a key — every root pointing at
 * the same belongsTo row — it repeats that key. Over `UNION ALL` (Postgres) the
 * page then came back with every row several times; SQLite's plain UNION
 * happened to collapse them. In place, because the instance holds this array.
 */
function dedupeInPlace(rows: SequelizeRow[], pk: string): void {
  const seen = new Set<unknown>();
  let write = 0;
  for (const row of rows) {
    const key = rowFields(row)[pk];
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows[write++] = row;
  }
  rows.length = write;
}

/** Walk the loaded rows alongside the include tree, marking each windowed `separate` result. */
export function markWindowedIncludes(rows: SequelizeRow[], includes: SequelizeInclude[] | undefined): void {
  if (!includes || includes.length === 0) {
    return;
  }
  for (const inc of includes) {
    const as = inc.as;
    if (!as) {
      continue;
    }
    const windowed = Boolean(inc.separate) && (inc.limit != null || inc.offset != null);
    const pk = (inc.model as {primaryKeyAttribute?: string} | undefined)?.primaryKeyAttribute;
    for (const row of rows) {
      const value = row ? rowFields(row)[as] : undefined;
      if (windowed && Array.isArray(value)) {
        Object.defineProperty(value, WINDOWED, { value: true, enumerable: false });
        if (pk) {
          dedupeInPlace(value as SequelizeRow[], pk);
        }
      }
      const children = Array.isArray(value) ? value : value ? [value] : [];
      markWindowedIncludes(children as SequelizeRow[], inc.include);
    }
  }
}

/** Recursively snapshot a Sequelize instance into a plain object. */
export function snapshotRow(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(snapshotRow);
  }
  if (value instanceof Model) {
    return Object.fromEntries(Object.entries(value.dataValues as Record<string, unknown>).map(([k, v]) => [k, snapshotRow(v)]));
  }
  return value;
}

/** True when a where object carries no own properties (string or symbol). */
export function isEmptyWhere(w: AdapterWhere): boolean {
  return Object.getOwnPropertyNames(w).length + Object.getOwnPropertySymbols(w).length === 0;
}

export function mergeFilterStatement(
  fieldName: string,
  value: unknown,
  match = true,
  originalWhere?: AdapterWhere
): AdapterWhere {
  const targetOp = Array.isArray(value)
    ? (match ? Op.in : Op.notIn)
    : (match ? Op.eq : Op.ne);
  const filter = {
    [fieldName]: {
      [targetOp]: value,
    },
  };
  if (originalWhere) {
    return {
      [Op.and]: [originalWhere, filter],
    };
  }
  return filter;
}
