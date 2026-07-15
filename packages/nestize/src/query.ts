// Translate a REST query string into the arg shape the ormize resolution engine
// expects. GraphQL-free: `where` is the filter DSL, `orderBy` is an array of
// `[field, "ASC"|"DESC"]` tuples, and REST `offset` is mapped onto the engine's
// cursor model (`after.index = offset - 1`).

export type ParsedListArgs = {
  where?: any;
  orderBy?: [string, "ASC" | "DESC"][];
  first?: number;
  last?: number;
  after?: { index: number };
  before?: { index: number };
  include?: any;
};

export type ParsedQuery = {
  args: ParsedListArgs;
  limit?: number;
  offset?: number;
  /** `undefined` = normal list, `true`/`"only"` = count-only projection. */
  count?: boolean;
};

function parseFilter(raw: any): any {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw === "object") {
    return raw;
  }
  try {
    return JSON.parse(String(raw));
  } catch (e: any) {
    throw new Error(`Invalid 'filter' query parameter (expected JSON): ${e?.message || e}`);
  }
}

// `?order=name,-createdAt` or `?order=nameASC,fooDESC` → tuples.
function parseOrder(raw: any): [string, "ASC" | "DESC"][] | undefined {
  if (!raw) {
    return undefined;
  }
  const parts = String(raw)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.map((part) => {
    let dir: "ASC" | "DESC" = "ASC";
    let field = part;
    if (part.startsWith("-")) {
      dir = "DESC";
      field = part.slice(1);
    } else if (/DESC$/i.test(part)) {
      dir = "DESC";
      field = part.replace(/DESC$/i, "");
    } else if (/ASC$/i.test(part)) {
      dir = "ASC";
      field = part.replace(/ASC$/i, "");
    }
    return [field.trim(), dir] as [string, "ASC" | "DESC"];
  });
}

function toInt(raw: any): number | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a REST list query (`filter`, `order`, `limit`, `offset`, `count`) into the
 * engine arg shape. `offset` is translated to the engine's cursor form:
 * `args.after = { index: offset - 1 }` when `offset > 0`, and `limit` → `args.first`.
 */
export function parseListQuery(query: any = {}): ParsedQuery {
  const where = parseFilter(query.filter);
  const orderBy = parseOrder(query.order);
  const limit = toInt(query.limit);
  const offset = toInt(query.offset);

  const args: ParsedListArgs = {};
  if (where !== undefined) {
    args.where = where;
  }
  if (orderBy) {
    args.orderBy = orderBy;
  }
  if (limit !== undefined) {
    args.first = limit;
  }
  if (offset !== undefined && offset > 0) {
    args.after = { index: offset - 1 };
  }

  let count: boolean | undefined;
  const c = query.count;
  if (c === "only" || c === "true" || c === true) {
    count = true;
  }

  return { args, limit, offset, count };
}

/** Parse just the filter object from `?filter=<json>` (used by update/delete). */
export function parseWhere(query: any = {}): any {
  return parseFilter(query.filter);
}
