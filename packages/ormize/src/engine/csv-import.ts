// Multi-file CSV imports: several uploads, each a create or an update on its
// own model, applied as one all-or-nothing unit, with rows in one file
// pointing at rows another file writes.
//
// Each file is read, split and converted exactly as a one-file upload is
// (`./csv`). What this adds is labels. A file's `@ref` column names its rows,
// a `….@ref` column in any file names them back, and the files run in the
// order those references need. A reference has no id until the row it names
// is written, so a row is converted with a placeholder token in its place,
// and the token is swapped for the written row's id just before that row is
// written. Conversion still finishes, for every file, before the first write.

import type { AdapterRow, RequestContext, Selection } from "@azerothian/utilize/types/index";

import { CsvUploadError } from "../csv/errors";
import { csvList } from "../csv/cells";
import { CSV_REF, isCsvRefHeader } from "../csv/header";
import { readCsv, type CsvRecord } from "../csv/read";
import {
  atRow, columnsFor, planRow, write,
  type CsvHost, type CsvOperation, type CsvRequest, type CsvRowArgs,
} from "./csv";

/** A multi-file import writes; deletes stay on the one-file upload. */
export type CsvImportOperation = Extract<CsvOperation, "create" | "update">;

export type CsvImportFile = {
  /** How errors and results name this file. Unique within the import. */
  name: string;
  defName: string;
  operation: CsvImportOperation;
  request: CsvRequest;
};

export type CsvImportRequest = {
  files: CsvImportFile[];
  /**
   * What a reference becomes once the row it names is written: that row's id
   * in the form the surface's inputs and filters take (a global id in gqlize,
   * the raw key in nestize).
   */
  refValue: (defName: string, row: AdapterRow) => unknown;
  /**
   * The selection each model's writes run with. gqlize's carries the
   * `translateFilter` that decodes the global ids in a row, references
   * included, so without it an id would reach the adapter still encoded.
   */
  selection?: (defName: string) => Selection | undefined;
};

export type CsvImportFileResult = { name: string; defName: string; operation: CsvImportOperation; rows: AdapterRow[] };

export type CsvImportResult = {
  /** One entry per file, in the order the files were given. */
  files: CsvImportFileResult[];
  /** Every labelled row, by label. */
  refs: { [label: string]: { defName: string; row: AdapterRow } };
};

/** {@link CsvHost} plus the one instance-wide limit an import has. */
export interface CsvImportHost extends CsvHost {
  /** Files allowed in one import, or `undefined` when CSV is off. */
  csvMaxFiles(): number | undefined;
}

/**
 * A NUL can come from neither a CSV cell nor a graphql string a parser has
 * not already refused to take as a key, so a cell holding this prefix after
 * the swap is one of ours.
 */
const TOKEN = "\u0000csv-ref:";
const token = (label: string) => `${TOKEN}${label}`;

type Loaded = {
  index: number;
  file: CsvImportFile;
  records: CsvRecord[];
  columns: { keys: string[]; input: string[] };
  /** Whether the file has an `@ref` column naming its rows. */
  labelled: boolean;
  /** Its `….@ref` columns, which name rows of this or another file. */
  refColumns: string[];
};

type Planned = { row: number; args: CsvRowArgs; label?: string };

/** Put the file's name on an error that does not have one yet. */
function withFile(e: unknown, name: string): unknown {
  if (!(e instanceof CsvUploadError) || e.file !== undefined) {
    return e;
  }
  return new CsvUploadError(e.code, `${name}: ${e.message}`, { row: e.row, column: e.column, file: name, cause: e.cause });
}

async function inFile<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw withFile(e, name);
  }
}

function invalid(message: string, at: { row?: number; column?: string; file?: string }): CsvUploadError {
  return new CsvUploadError("CSV_ROW_INVALID", message, at);
}

async function load(host: CsvHost, file: CsvImportFile, index: number): Promise<Loaded> {
  if (file.operation !== "create" && file.operation !== "update") {
    throw new CsvUploadError("CSV_UNSUPPORTED", `A multi-file import creates or updates; "${String(file.operation)}" is neither`);
  }
  const limits = host.csvLimits(file.defName);
  if (!limits) {
    throw new CsvUploadError("CSV_UNSUPPORTED", `${file.defName} does not accept CSV uploads`);
  }
  const { header, records } = await readCsv(file.request.upload, limits, { delimiter: file.request.delimiter });
  const body = header.filter((column) => column !== CSV_REF);
  const columns = columnsFor(host, file.defName, file.operation, body, file.request.keys);
  const refColumns = body.filter(isCsvRefHeader);
  for (const column of refColumns) {
    if (columns.keys.includes(column)) {
      throw new CsvUploadError("CSV_HEADER", `"${column}": a reference cannot be a match column`, { column });
    }
  }
  file.request.checkColumns?.(columns);
  return { index, file, records, columns, labelled: body.length !== header.length, refColumns };
}

/** The labels a reference cell names: `a1`, `a1|a2`, or a JSON array of them. */
function refLabels(raw: string): string[] {
  return csvList(raw).map((label) => String(label).trim()).filter((label) => label !== "");
}

/**
 * The files in an order that writes every referenced file before the files
 * that reference it, keeping the given order where references leave it free.
 */
function writeOrder(loaded: Loaded[], dependsOn: Set<number>[]): number[] {
  const order: number[] = [];
  const done = new Set<number>();
  while (order.length < loaded.length) {
    const next = loaded.find((l) => !done.has(l.index) && [...dependsOn[l.index]].every((d) => done.has(d)));
    if (!next) {
      const stuck = loaded.filter((l) => !done.has(l.index)).map((l) => l.file.name);
      throw new CsvUploadError(
        "CSV_HEADER",
        `Files ${stuck.map((n) => `"${n}"`).join(", ")} refer to each other in a cycle, so none can be written first`,
        { file: stuck[0] },
      );
    }
    order.push(next.index);
    done.add(next.index);
  }
  return order;
}

/**
 * Swap every reference token in a converted row for the id of the row it
 * names. A token run together with another (`a1|a2` in a field that takes one
 * id) is refused rather than written as text.
 */
function resolveTokens(value: unknown, lookup: (label: string) => unknown): unknown {
  if (typeof value === "string") {
    if (!value.includes(TOKEN)) {
      return value;
    }
    const label = value.slice(TOKEN.length);
    if (!value.startsWith(TOKEN) || label.includes(TOKEN)) {
      throw new CsvUploadError("CSV_ROW_INVALID", "That field takes one reference, not a list of them");
    }
    return lookup(label);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTokens(item, lookup));
  }
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as object | null;
    // Only the plain objects an input tree is built from: a Date or a Buffer
    // holds no token and is passed through untouched.
    if (proto === Object.prototype || proto === null) {
      const out = Object.create(proto) as { [key: string]: unknown };
      for (const [key, item] of Object.entries(value)) {
        out[key] = resolveTokens(item, lookup);
      }
      return out;
    }
  }
  return value;
}

/**
 * Apply a multi-file import and return what each file wrote.
 *
 * Throws a {@link CsvUploadError}, with `file` set, for anything wrong with a
 * file, a row or a reference, having written nothing.
 */
export async function processCsvImport(
  host: CsvImportHost,
  request: CsvImportRequest,
  context: RequestContext,
): Promise<CsvImportResult> {
  const maxFiles = host.csvMaxFiles();
  if (maxFiles === undefined) {
    throw new CsvUploadError("CSV_UNSUPPORTED", "CSV uploads are not enabled");
  }
  const { files } = request;
  if (files.length === 0) {
    throw new CsvUploadError("CSV_UNSUPPORTED", "The import has no files");
  }
  if (files.length > maxFiles) {
    throw new CsvUploadError("CSV_TOO_MANY_FILES", `The import has ${files.length} files; the limit is ${maxFiles}`);
  }
  const names = new Set<string>();
  for (const file of files) {
    if (names.has(file.name)) {
      throw new CsvUploadError("CSV_HEADER", `Two files are named "${file.name}"`, { file: file.name });
    }
    names.add(file.name);
  }

  const loaded: Loaded[] = [];
  for (const [index, file] of files.entries()) {
    loaded.push(await inFile(file.name, () => load(host, file, index)));
  }

  // Labels are unique across the whole import, so a reference needs no file name.
  const owners = new Map<string, { file: number; row: number }>();
  for (const l of loaded) {
    if (!l.labelled) {
      continue;
    }
    for (const { row, cells } of l.records) {
      const label = cells[CSV_REF]?.trim();
      if (!label) {
        continue;
      }
      const taken = owners.get(label);
      if (taken) {
        throw invalid(
          `Row ${row}: the label "${label}" is already used by row ${taken.row} of "${loaded[taken.file].file.name}"`,
          { row, column: CSV_REF, file: l.file.name },
        );
      }
      owners.set(label, { file: l.index, row });
    }
  }

  const dependsOn = loaded.map(() => new Set<number>());
  for (const l of loaded) {
    for (const { row, cells } of l.records) {
      for (const column of l.refColumns) {
        const raw = cells[column];
        if (raw === undefined || raw === null) {
          continue;
        }
        for (const label of await inFile(l.file.name, () => refLabels(raw))) {
          const owner = owners.get(label);
          const at = { row, column, file: l.file.name };
          if (!owner) {
            throw invalid(`Row ${row}: "${column}": no row is labelled "${label}"`, at);
          }
          if (owner.file !== l.index) {
            dependsOn[l.index].add(owner.file);
          } else if (owner.row >= row) {
            // Within a file the rows run top to bottom; a row can only name one written before it.
            throw invalid(`Row ${row}: "${column}": "${label}" is row ${owner.row} of the same file, which is not written before this one`, at);
          }
        }
      }
    }
  }
  const order = writeOrder(loaded, dependsOn);

  const planned: Planned[][] = loaded.map(() => []);
  for (const index of order) {
    const l = loaded[index];
    for (const { row, cells } of l.records) {
      const swapped = { ...cells };
      delete swapped[CSV_REF];
      for (const column of l.refColumns) {
        const raw = swapped[column];
        if (raw !== undefined && raw !== null) {
          swapped[column] = refLabels(raw).map(token).join("|");
        }
      }
      const args = await inFile(l.file.name, () => planRow(l.file.request, l.file.operation, l.columns, row, swapped));
      planned[index].push({ row, args, label: l.labelled ? cells[CSV_REF]?.trim() || undefined : undefined });
    }
  }

  return host.transaction(async() => {
    const refs: CsvImportResult["refs"] = {};
    const results: CsvImportFileResult[] = files.map((file) => ({
      name: file.name, defName: file.defName, operation: file.operation, rows: [],
    }));
    const lookup = (label: string) => {
      const ref = refs[label];
      return request.refValue(ref.defName, ref.row);
    };
    for (const index of order) {
      const { file } = loaded[index];
      for (const { row, args, label } of planned[index]) {
        await inFile(file.name, async() => {
          let written: AdapterRow[];
          try {
            const resolved = resolveTokens(args, lookup) as CsvRowArgs;
            written = await write(host, file.defName, file.operation, resolved, file.request.apply, context, request.selection?.(file.defName));
          } catch (e) {
            throw atRow(e, row, "CSV_ROW_FAILED");
          }
          if (file.operation === "update" && written.length === 0) {
            throw new CsvUploadError("CSV_ROW_NO_MATCH", `Row ${row}: no ${file.defName} matched its key columns`, { row });
          }
          if (label) {
            if (written.length !== 1) {
              // A label names one row; which of several would a reference mean?
              throw invalid(`Row ${row}: the label "${label}" would name ${written.length} rows`, { row, column: CSV_REF });
            }
            refs[label] = { defName: file.defName, row: written[0] };
          }
          results[index].rows.push(...written);
        });
      }
    }
    return { files: results, refs };
  });
}
