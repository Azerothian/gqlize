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
import { CsvUploadError, csvCellValue } from "@azerothian/ormize";
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
 * The REST half of an ormize `CsvRequest` for one model: `?keys=a,b` and
 * `?delimiter=;` off the query string, header checks, and per-row conversion.
 */
export function restCsvRequest(
  orm: Ormize, name: string, operation: CsvOperation, req: RestRequest, query: RestQuery, schemas: CsvSchemas,
): CsvRequest {
  const fields = orm.getFields(name) || {};
  const descriptor = (column: string) => {
    const meta = fields[column];
    return meta?.type === undefined ? undefined : orm.mapDataType(meta.type, orm.defsAdapters[name]);
  };
  const convert = (cells: CsvCells) => {
    const out: { [column: string]: unknown } = {};
    for (const column of Object.keys(cells)) {
      try {
        out[column] = csvCellValue(cells[column], descriptor(column));
      } catch (e) {
        if (e instanceof CsvUploadError) {
          throw new CsvUploadError(e.code, `"${column}": ${e.message}`, { column });
        }
        throw e;
      }
    }
    return out;
  };
  const delimiter = typeof query?.delimiter === "string" ? query.delimiter : undefined;
  return {
    upload: csvUploadOf(req),
    keys: queryList(query?.keys),
    delimiter,
    checkColumns: ({ input, keys }) => {
      const shape = schemas.input?.shape || {};
      for (const column of input) {
        if (!(column in shape)) {
          throw new CsvUploadError("CSV_HEADER", `"${column}" is not a field this ${operation} can write`, { column });
        }
      }
      for (const column of keys) {
        if (!fields[column]) {
          throw new CsvUploadError("CSV_HEADER", `"${column}" is not a field rows can be matched on`, { column });
        }
      }
      // The same rule a `?filter=` is held to: matching on a field is reading it.
      if (keys.length > 0) {
        schemas.assertFilterAllowed(Object.fromEntries(keys.map((k) => [k, { eq: null }])));
      }
    },
    toArgs: ({ input, keys }: CsvRowCells) => {
      const where = Object.fromEntries(Object.entries(convert(keys)).map(([k, v]) => [k, { eq: v }]));
      if (operation === "delete") {
        return { where };
      }
      const values = convert(input);
      const parsed = schemas.input ? schemas.input.safeParse(values) : { success: true as const, data: values };
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const column = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
        throw new CsvUploadError("CSV_ROW_INVALID", column ? `"${column}": ${issue.message}` : issue?.message || "Validation failed", { column });
      }
      return { input: parsed.data, where: operation === "update" ? where : undefined };
    },
  };
}

/** A refused upload as the HTTP error a client gets: 413 for size, 400 for everything else. */
export function csvHttpError(e: CsvUploadError): HttpException {
  const body: { [key: string]: unknown } = { message: e.message, code: e.code };
  if (e.row !== undefined) {
    body.row = e.row;
  }
  if (e.column !== undefined) {
    body.column = e.column;
  }
  if (e.code === "CSV_TOO_LARGE" || e.code === "CSV_TOO_MANY_ROWS") {
    return new HttpException({ statusCode: HttpStatus.PAYLOAD_TOO_LARGE, ...body }, HttpStatus.PAYLOAD_TOO_LARGE);
  }
  return new BadRequestException({ statusCode: HttpStatus.BAD_REQUEST, ...body });
}
