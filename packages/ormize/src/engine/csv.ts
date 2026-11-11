// CSV mutation uploads: one file of rows, applied as one create, update or
// delete per row, all-or-nothing.
//
// This is a transport, not a write path. Every row goes through the same
// `processCreate` / `processUpdate` / `processDelete` a JSON argument does, so
// the mass-assignment allow-list, `override.input`, row scope, hooks, `apply`
// transforms and read-cache invalidation all hold without being restated here.
// What is CSV-specific is the order of work: the whole file is read and every
// row converted before the first write, and the writes then run inside one
// coordinated transaction, so a bad row in the middle leaves nothing behind.

import type {
  AdapterRow, OrmAdapter, RequestContext, ResolvedCsvLimits, Selection,
} from "@azerothian/utilize/types/index";
import type { MutationApply, MutationFilter, MutationInputTree } from "../types/engine";

import { CsvUploadError } from "../csv/errors";
import { readCsv, type CsvCells } from "../csv/read";
import { isCsvWhereHeader } from "../csv/header";
import type { CsvUpload } from "../csv/source";

/** The three operations a CSV can carry. Restore and select stay JSON-only. */
export type CsvOperation = "create" | "update" | "delete";

/**
 * A row's cells split by role: `keys` are the columns that find the row to
 * update or delete, `input` everything else. A create has no keys.
 */
export type CsvRowCells = { input: CsvCells; keys: CsvCells };

/** What a converted row hands the engine: the `input` and/or `where` of one write. */
export type CsvRowArgs = { input?: MutationInputTree; where?: MutationFilter };

export type CsvRequest = {
  upload: CsvUpload;
  /**
   * The columns an update or delete row is matched on, alongside any
   * `where.…` columns in the header. Default, when there are neither: the
   * model's primary key. Ignored on a create.
   */
  keys?: string[];
  /** The field separator. Default `,`. */
  delimiter?: string;
  /** Instance-method transforms, applied to every created/updated row as on the JSON path. */
  apply?: MutationApply;
  /**
   * Refuse a column the surface will not take, before any row is converted.
   * Throw a `CSV_HEADER` {@link CsvUploadError}.
   */
  checkColumns?: (columns: { input: string[]; keys: string[] }) => void;
  /**
   * Convert one row's string cells into the arguments of its write — the
   * surface's half of the work, since only it knows the typed input a JSON
   * caller would have sent. A {@link CsvUploadError} thrown without a row gets
   * this one's; anything else is reported as an invalid row.
   */
  toArgs: (cells: CsvRowCells, row: number) => CsvRowArgs | Promise<CsvRowArgs>;
  /**
   * Multi-file imports only: the model a `….@ref` column's labels must name,
   * when the surface knows it. A label of any other model is refused before
   * anything is written. Without this, a foreign-key reference would write the
   * other row's key into the column as is, linking to whatever row of the
   * right model happens to share it.
   */
  refTarget?: (column: string) => string | undefined;
};

/** The narrow slice of the manager this module needs. */
export interface CsvHost {
  csvLimits(defName: string): ResolvedCsvLimits | undefined;
  getModelAdapter(defName: string): OrmAdapter;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  processCreate(defName: string, source: AdapterRow, args: { input: MutationInputTree; apply?: MutationApply }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]>;
  processUpdate(defName: string, source: AdapterRow, args: { input: MutationInputTree; where: MutationFilter; apply?: MutationApply }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]>;
  processDelete(defName: string, source: AdapterRow, args: MutationFilter, context: RequestContext, selection?: Selection): Promise<AdapterRow[]>;
}

/** Give a row-less error the row it came from, keeping its code and column. */
export function atRow(e: unknown, row: number, fallbackCode: "CSV_ROW_INVALID" | "CSV_ROW_FAILED"): CsvUploadError {
  if (e instanceof CsvUploadError) {
    return e.row !== undefined ? e : new CsvUploadError(e.code, `Row ${row}: ${e.message}`, { row, column: e.column, file: e.file, cause: e.cause });
  }
  const message = e instanceof Error ? e.message : String(e);
  return new CsvUploadError(fallbackCode, `Row ${row}: ${message}`, { row, cause: e });
}

/** Split the header into key and input columns, refusing what the operation cannot take. */
export function columnsFor(
  host: CsvHost, defName: string, operation: CsvOperation, header: string[], requested: string[] | undefined, apply?: MutationApply,
) {
  // `where.<field>[op]` columns (see `csv/header.ts`) are match columns
  // wherever they appear; they stand in for the primary key default rather
  // than adding to it, since a file that spells out its filter means that one.
  const filters = header.filter(isCsvWhereHeader);
  if (operation === "create") {
    if (filters.length > 0) {
      throw new CsvUploadError("CSV_HEADER", `A create matches no rows; "${filters[0]}" has nothing to filter`, { column: filters[0] });
    }
    return { keys: [], input: header };
  }
  const named = requested && requested.length > 0 ? requested : [];
  const keys = named.length > 0 || filters.length > 0
    ? [...named.filter((k) => !filters.includes(k)), ...filters]
    : host.getModelAdapter(defName).getPrimaryKeyNameForModel(defName) || [];
  if (keys.length === 0) {
    throw new CsvUploadError("CSV_HEADER", `${defName} has no primary key; name the columns to match rows on`);
  }
  for (const key of keys) {
    if (!header.includes(key)) {
      throw new CsvUploadError("CSV_HEADER", `The CSV has no "${key}" column to match rows on`, { column: key });
    }
  }
  const input = header.filter((column) => !keys.includes(column));
  if (operation === "delete" && input.length > 0) {
    throw new CsvUploadError("CSV_HEADER", `A delete takes only its key columns (${keys.join(", ")}); "${input[0]}" is not one`, { column: input[0] });
  }
  // An update with nothing to write is a mistake, unless it runs a transform:
  // then the key columns alone pick the rows the transform runs on.
  if (operation === "update" && input.length === 0 && !runsTransform(apply)) {
    throw new CsvUploadError("CSV_HEADER", "An update needs at least one column besides the key columns, or an `apply` transform");
  }
  return { keys, input };
}

/** Whether `apply` asks for any transform: a falsy value names one without asking for it. */
function runsTransform(apply: MutationApply | undefined): boolean {
  return !!apply && Object.values(apply).some((v) => v !== false && v !== null && v !== undefined);
}

export function pick(cells: CsvCells, columns: string[]): CsvCells {
  const out: CsvCells = {};
  for (const column of columns) {
    if (column in cells) {
      out[column] = cells[column];
    }
  }
  return out;
}

/**
 * One row's cells as the arguments of its write: split by role, converted by
 * the surface, and refused when its match would be blank or empty.
 */
export async function planRow(
  request: CsvRequest, operation: CsvOperation, columns: { keys: string[]; input: string[] }, row: number, cells: CsvCells,
): Promise<CsvRowArgs> {
  const keys = pick(cells, columns.keys);
  for (const key of columns.keys) {
    // A blank key would be a `where` that matches on nothing — or, dropped,
    // on everything. Neither is what the row meant.
    if (keys[key] === undefined || keys[key] === null) {
      throw new CsvUploadError("CSV_ROW_INVALID", `Row ${row}: the "${key}" key cell is empty`, { row, column: key });
    }
  }
  let args: CsvRowArgs;
  try {
    args = await request.toArgs({ keys, input: pick(cells, columns.input) }, row);
  } catch (e) {
    throw atRow(e, row, "CSV_ROW_INVALID");
  }
  // Checked here rather than trusted to every surface's `toArgs`: an update
  // or delete handed an empty `where` acts on the whole table.
  if (operation !== "create" && (!args.where || Object.keys(args.where).length === 0)) {
    throw new CsvUploadError("CSV_ROW_INVALID", `Row ${row}: its key columns produced no filter`, { row });
  }
  return args;
}

/**
 * Apply a CSV upload to `defName` and return every row it wrote, in file order.
 *
 * Throws a {@link CsvUploadError} for anything wrong with the file or a row,
 * having written nothing: conversion finishes before the transaction opens,
 * and a write that fails inside it rolls the earlier rows back.
 */
export async function processCsv(
  host: CsvHost,
  defName: string,
  operation: CsvOperation,
  request: CsvRequest,
  context: RequestContext,
  selection?: Selection,
): Promise<AdapterRow[]> {
  const limits = host.csvLimits(defName);
  if (!limits) {
    throw new CsvUploadError("CSV_UNSUPPORTED", `${defName} does not accept CSV uploads`);
  }
  const { header, records } = await readCsv(request.upload, limits, { delimiter: request.delimiter });
  const columns = columnsFor(host, defName, operation, header, request.keys, request.apply);
  request.checkColumns?.(columns);

  const planned: { row: number; args: CsvRowArgs }[] = [];
  for (const { row, cells } of records) {
    planned.push({ row, args: await planRow(request, operation, columns, row, cells) });
  }

  return host.transaction(async() => {
    let results: AdapterRow[] = [];
    for (const { row, args } of planned) {
      let written: AdapterRow[];
      try {
        written = await write(host, defName, operation, args, request.apply, context, selection);
      } catch (e) {
        throw atRow(e, row, "CSV_ROW_FAILED");
      }
      if (operation !== "create" && written.length === 0) {
        // Reported the same way whether the row is missing or outside the
        // caller's scope, so it says nothing a JSON update's empty result
        // would not.
        throw new CsvUploadError("CSV_ROW_NO_MATCH", `Row ${row}: no ${defName} matched its key columns`, { row });
      }
      results = results.concat(written);
    }
    return results;
  });
}

export function write(
  host: CsvHost, defName: string, operation: CsvOperation, args: CsvRowArgs, apply: MutationApply | undefined,
  context: RequestContext, selection: Selection | undefined,
): Promise<AdapterRow[]> {
  switch (operation) {
    case "create":
      return host.processCreate(defName, null, { input: args.input || {}, apply }, context, selection);
    case "update":
      return host.processUpdate(defName, null, { input: args.input || {}, where: args.where || {}, apply }, context, selection);
    case "delete":
      return host.processDelete(defName, null, args.where || {}, context, selection);
  }
}
