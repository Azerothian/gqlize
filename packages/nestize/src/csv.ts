// CSV uploads over REST (`POST /:resource/_csv/:operation`): reading the body
// off the request, converting a row's cells against the model's zod schemas,
// and answering a refused upload with the right status.
//
// The service owns the gates; ormize's `processCsv` owns the file and the
// all-or-nothing writes. This module is only the REST surface's half of the
// `CsvRequest`, the counterpart of gqlize's `graphql/resolvers/csv.ts` — which
// converts against GraphQL input types where this converts against column
// descriptors, because the zod schemas want a `number` and a `Date`, not text.

import { BadRequestException, HttpException, HttpStatus } from "@nestjs/common";
import {
  CSV_LIST_OPERATORS, CSV_WHERE, CsvUploadError, csvCellValue, csvList, isCsvRefHeader, isCsvWhereHeader, parseCsvHeader,
} from "@azerothian/ormize";
import type { CsvCells, CsvOperation, CsvRequest, CsvRowCells, Ormize } from "@azerothian/ormize";
import type { z } from "zod";
import type { RestQuery, RestRequest } from "./types";

export const CSV_OPERATIONS: readonly CsvOperation[] = ["create", "update", "delete"];

export function isCsvOperation(value: string): value is CsvOperation {
  return (CSV_OPERATIONS as readonly string[]).includes(value);
}

type RequestShapes = {
  body?: unknown;
  /** Fastify's request wraps the Node stream. */
  raw?: unknown;
  /** multer's `FileInterceptor`, memory or stream storage. */
  file?: { buffer?: unknown; stream?: unknown };
};

/**
 * The CSV a request carries, in the order a host might have put it there:
 *
 * 1. a file a multipart interceptor (multer) already read;
 * 2. a body a parser already read as text or bytes (`express.text`, `raw`);
 * 3. otherwise the request stream itself — a `text/csv` body is one Nest's
 *    default JSON/urlencoded parsers leave unread, so no parser is needed.
 */
export function csvUploadOf(req: RestRequest): unknown {
  const r = (req || {}) as RequestShapes;
  if (r.file && (r.file.buffer !== undefined || r.file.stream !== undefined)) {
    return r.file.buffer ?? r.file.stream;
  }
  if (typeof r.body === "string" || r.body instanceof Uint8Array) {
    return r.body;
  }
  return r.raw ?? req;
}

function queryList(value: unknown): string[] | undefined {
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return parts.length > 0 ? parts : undefined;
}

export type CsvSchemas = {
  /** The zod schema a row's input is held to: `create` or `update`. */
  input?: z.ZodObject<z.ZodRawShape>;
  /** Refuse a filter on a field the caller may not filter by (throws an HttpException). */
  assertFilterAllowed: (where: unknown) => void;
};

/**
 * The field and operator a key column matches with. A plain column is `eq`;
 * a `where.<field>[op]` column names its own. REST's filter is flat, so the
 * path stops at one field: no `or`/`and`, no relationship.
 */
function keyFilter(column: string): { field: string; op: string } {
  if (!isCsvWhereHeader(column)) {
    return { field: column, op: "eq" };
  }
  const { segments, op } = parseCsvHeader(column.slice(CSV_WHERE.length + 1));
  if (segments.length !== 1 || segments[0].index !== undefined) {
    throw new CsvUploadError("CSV_HEADER", `"${column}": over REST a filter column names one field, as where.<field>[op]`, { column });
  }
  return { field: segments[0].name, op: op ?? "eq" };
}

/**
 * The column a `<field>.@ref` header fills. REST has no nested relationship
 * input, so a reference here is a foreign-key column the input schema takes:
 * the referenced row's key is written into it.
 */
function refField(column: string, shape: { [field: string]: unknown }, allowed: boolean | undefined): string {
  if (!allowed) {
    throw new CsvUploadError("CSV_HEADER", `"${column}" names labelled rows, which only a multi-file import (POST /_csv) has`, { column });
  }
  const { segments } = parseCsvHeader(column);
  const field = segments[0].name;
  if (segments.length !== 2 || segments[0].index !== undefined || !(field in shape)) {
    throw new CsvUploadError("CSV_HEADER", `"${column}": over REST a reference fills one writable foreign-key column, as <field>.@ref`, { column });
  }
  return field;
}

/** Pin a column-less conversion error on `column`. */
function inColumn<T>(column: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CsvUploadError && e.column === undefined) {
      throw new CsvUploadError(e.code, `"${column}": ${e.message}`, { column });
    }
    throw e;
  }
}

/**
 * The REST half of an ormize `CsvRequest` for one model: `?keys=a,b` and
 * `?delimiter=;` off the query string, header checks, and per-row conversion.
 *
 * Relationship columns (`author.set.name`) are the GraphQL upload's: the REST
 * create/update bodies are validated by zod schemas that hold columns only,
 * so there is no nested input here for such a column to fill.
 */
export function restCsvRequest(
  orm: Ormize, name: string, operation: CsvOperation, upload: unknown, query: RestQuery, schemas: CsvSchemas,
  options: { refs?: boolean } = {},
): CsvRequest {
  const fields = orm.getFields(name) || {};
  const descriptor = (column: string) => {
    const meta = fields[column];
    return meta?.type === undefined ? undefined : orm.mapDataType(meta.type, orm.defsAdapters[name]);
  };
  const convert = (cells: CsvCells) => {
    const out: { [column: string]: unknown } = {};
    for (const column of Object.keys(cells)) {
      out[column] = inColumn(column, () => csvCellValue(cells[column], descriptor(column)));
    }
    return out;
  };
  const buildWhere = (cells: CsvCells) => {
    const where: { [field: string]: { [op: string]: unknown } } = {};
    for (const column of Object.keys(cells)) {
      const { field, op } = keyFilter(column);
      const raw = cells[column];
      const value = inColumn(column, () => (CSV_LIST_OPERATORS.has(op) && raw !== null
        ? csvList(raw).map((item) => (typeof item === "string" ? csvCellValue(item, descriptor(field)) : item))
        : csvCellValue(raw, descriptor(field))));
      where[field] = { ...where[field], [op]: value };
    }
    return where;
  };
  const delimiter = typeof query?.delimiter === "string" ? query.delimiter : undefined;
  return {
    upload,
    keys: queryList(query?.keys),
    delimiter,
    checkColumns: ({ input, keys }) => {
      const shape = schemas.input?.shape || {};
      for (const column of input) {
        if (isCsvRefHeader(column)) {
          refField(column, shape, options.refs);
          continue;
        }
        if (/[.?[]/.test(column)) {
          throw new CsvUploadError("CSV_HEADER", `"${column}": relationship columns are only taken by the GraphQL upload`, { column });
        }
        if (!(column in shape)) {
          throw new CsvUploadError("CSV_HEADER", `"${column}" is not a field this ${operation} can write`, { column });
        }
      }
      const filter: { [field: string]: { [op: string]: null } } = {};
      for (const column of keys) {
        const { field, op } = keyFilter(column);
        if (!fields[field]) {
          throw new CsvUploadError("CSV_HEADER", `"${column}" is not a field rows can be matched on`, { column });
        }
        filter[field] = { ...filter[field], [op]: null };
      }
      // The same rule a `?filter=` is held to: matching on a field is reading it.
      if (keys.length > 0) {
        schemas.assertFilterAllowed(filter);
      }
    },
    toArgs: ({ input, keys }: CsvRowCells) => {
      const where = buildWhere(keys);
      if (operation === "delete") {
        return { where };
      }
      // A reference cell holds a placeholder until the row it names is
      // written, so it is set aside from conversion and validation and put
      // back after; the engine swaps in the key before this row is written.
      const refs: { [field: string]: unknown } = {};
      const plain: CsvCells = {};
      for (const column of Object.keys(input)) {
        if (isCsvRefHeader(column)) {
          refs[refField(column, schemas.input?.shape || {}, options.refs)] = input[column];
        } else {
          plain[column] = input[column];
        }
      }
      const values = convert(plain);
      const schema = schemas.input && Object.keys(refs).length > 0
        ? schemas.input.omit(Object.fromEntries(Object.keys(refs).map((f) => [f, true])))
        : schemas.input;
      const parsed = schema ? schema.safeParse(values) : { success: true as const, data: values };
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const column = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
        throw new CsvUploadError("CSV_ROW_INVALID", column ? `"${column}": ${issue.message}` : issue?.message || "Validation failed", { column });
      }
      return { input: { ...parsed.data, ...refs }, where: operation === "update" ? where : undefined };
    },
  };
}

/** A refused upload as the HTTP error a client gets: 413 for size, row or file count, 400 for everything else. */
export function csvHttpError(e: CsvUploadError): HttpException {
  const body: { [key: string]: unknown } = { message: e.message, code: e.code };
  if (e.file !== undefined) {
    body.file = e.file;
  }
  if (e.row !== undefined) {
    body.row = e.row;
  }
  if (e.column !== undefined) {
    body.column = e.column;
  }
  if (e.code === "CSV_TOO_LARGE" || e.code === "CSV_TOO_MANY_ROWS" || e.code === "CSV_TOO_MANY_FILES") {
    return new HttpException({ statusCode: HttpStatus.PAYLOAD_TOO_LARGE, ...body }, HttpStatus.PAYLOAD_TOO_LARGE);
  }
  return new BadRequestException({ statusCode: HttpStatus.BAD_REQUEST, ...body });
}
