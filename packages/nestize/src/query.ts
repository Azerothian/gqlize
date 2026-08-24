// Translate a REST query string into the arg shape the ormize resolution engine
// expects. GraphQL-free: `where` is the filter DSL, `orderBy` is an array of
// `[field, "ASC"|"DESC"]` tuples, and REST `offset` is mapped onto the engine's
// cursor model (`after.index = offset - 1`).
import { BadRequestException } from "@nestjs/common";
import type { AdapterWhere } from "@azerothian/utilize";
import type { RestQuery } from "./types";

export type ParsedListArgs = {
  where?: AdapterWhere;
  orderBy?: [string, "ASC" | "DESC"][];
  first?: number;
  last?: number;
  after?: { index: number };
  before?: { index: number };
  /** Eager-include plan. Never set by `parseListQuery`; the engine fills it in. */
  include?: unknown;
};

export type ParsedQuery = {
  args: ParsedListArgs;
  limit?: number;
  offset?: number;
  /** `undefined` = normal list, `true`/`"only"` = count-only projection. */
  count?: boolean;
};

function parseFilter(raw: unknown): AdapterWhere | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw === "object") {
    return raw;
  }
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new BadRequestException(`Invalid 'filter' query parameter (expected JSON): ${detail}`);
  }
}

// `?order=name,-createdAt` or `?order=nameASC,fooDESC` → tuples.
function parseOrder(raw: unknown): [string, "ASC" | "DESC"][] | undefined {
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
    } else if (part.startsWith("+")) {
      dir = "ASC";
      field = part.slice(1);
    } else {
      // Explicit direction requires a separator (space, `:` or `.`) — e.g.
      // `name:desc` or `name desc`. A bare trailing "asc"/"desc" is NOT treated
      // as a direction, so a column literally named `desc` (or any field ending
      // in those letters) is preserved intact instead of being silently mangled
      // into an empty/truncated field name. Use `-field` for descending.
      const m = /^(.+?)[\s:.](asc|desc)$/i.exec(part);
      if (m) {
        field = m[1];
        dir = m[2].toUpperCase() as "ASC" | "DESC";
      }
    }
    return [field.trim(), dir] as [string, "ASC" | "DESC"];
  });
}

function toInt(raw: unknown): number | undefined {
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
export function parseListQuery(query: RestQuery = {}): ParsedQuery {
  const where = parseFilter(query.filter);
  const orderBy = parseOrder(query.order);
  const limit = toInt(query.limit);
  const offset = toInt(query.offset);

  // Reject nonsensical pagination up front (a negative `LIMIT`/`OFFSET` otherwise
  // reaches the driver as raw SQL and surfaces as an opaque 500). The upper bound
  // / default cap is enforced centrally in the adapter's list-arg builder.
  if (limit !== undefined && limit <= 0) {
    throw new BadRequestException("'limit' must be a positive integer");
  }
  if (offset !== undefined && offset < 0) {
    throw new BadRequestException("'offset' must be a non-negative integer");
  }

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
export function parseWhere(query: RestQuery = {}): AdapterWhere | undefined {
  return parseFilter(query.filter);
}
