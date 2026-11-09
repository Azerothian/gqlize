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
   * The columns an update or delete row is matched on. Default: the model's
   * primary key. Ignored on a create.
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
function atRow(e: unknown, row: number, fallbackCode: "CSV_ROW_INVALID" | "CSV_ROW_FAILED"): CsvUploadError {
  if (e instanceof CsvUploadError) {
    return e.row !== undefined ? e : new CsvUploadError(e.code, `Row ${row}: ${e.message}`, { row, column: e.column, cause: e.cause });
  }
  const message = e instanceof Error ? e.message : String(e);
  return new CsvUploadError(fallbackCode, `Row ${row}: ${message}`, { row, cause: e });
}

/** Split the header into key and input columns, refusing what the operation cannot take. */
function columnsFor(host: CsvHost, defName: string, operation: CsvOperation, header: string[], requested: string[] | undefined) {
  if (operation === "create") {
    return { keys: [], input: header };
  }
  const keys = requested && requested.length > 0
    ? requested
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
  if (operation === "update" && input.length === 0) {
    throw new CsvUploadError("CSV_HEADER", "An update needs at least one column besides the key columns");
  }
  return { keys, input };
}

function pick(cells: CsvCells, columns: string[]): CsvCells {
  const out: CsvCells = {};
  for (const column of columns) {
    if (column in cells) {
      out[column] = cells[column];
    }
  }
  return out;
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
  const columns = columnsFor(host, defName, operation, header, request.keys);
  request.checkColumns?.(columns);

  const planned: { row: number; args: CsvRowArgs }[] = [];
  for (const { row, cells } of records) {
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
    planned.push({ row, args });
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

function write(
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
