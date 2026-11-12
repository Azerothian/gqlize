// Writing rows out as CSV: the read side of CSV, the inverse of `./read` and
// `./cells`.
//
// A file written here reads back through an upload unchanged, which is the
// point: export, edit in a spreadsheet, upload as an update. So it follows the
// upload's own conventions rather than a generic CSV writer's:
//
// - `null` is the `\N` cell (`CSV_NULL`), because an empty cell on an upload
//   means "leave this column alone", not "set it to NULL";
// - `undefined` (a value the row does not have) is the empty cell;
// - a date is ISO 8601, a boolean `true`/`false`, an object or array JSON —
//   exactly what `csvCellValue` and gqlize's input coercion read back.
//
// Quoting is RFC 4180: a field holding the delimiter, a quote, CR or LF, or
// leading/trailing space is quoted, and quotes inside it are doubled. That is
// what csv-parse expects on the way back in, so no writer dependency is needed.
//
// Rows are fetched by each surface (gqlize's connection, nestize's list route),
// which is where field permissions, row scope and output hooks are applied; this
// module only formats what they hand it.

import { CsvUploadError } from "./errors";
import { CSV_NULL } from "./read";

/** One cell's text: `null` → `\N`, `undefined` → empty, everything else as an upload reads it back. */
export function csvCellText(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return CSV_NULL;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
      }
      return JSON.stringify(value) ?? "";
  }
}

/**
 * Refuse a delimiter that cannot round-trip: anything but one character, or a
 * character that quoting itself relies on. Thrown as `CSV_UNSUPPORTED`, the
 * code an upload gives a bad option.
 */
export function assertCsvDelimiter(delimiter: string): void {
  if (delimiter.length !== 1 || delimiter === "\"" || delimiter === "\r" || delimiter === "\n") {
    throw new CsvUploadError("CSV_UNSUPPORTED", `The delimiter must be one character other than a quote or a line break; got ${JSON.stringify(delimiter)}`);
  }
}

function quote(text: string, delimiter: string): string {
  const needs = text.includes(delimiter) || /["\r\n]/.test(text) || text !== text.trim();
  return needs ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

export type WriteCsvOptions = {
  /** The field separator. Default `,`. */
  delimiter?: string;
  /** Write the header line. Default `true`. */
  header?: boolean;
};

/**
 * `columns` as the header and one line per row, each row's cells read by
 * column name. Lines end in CRLF (RFC 4180); an empty table with a header is
 * just the header line.
 */
export function writeCsv(columns: string[], rows: ReadonlyArray<{ [column: string]: unknown }>, options: WriteCsvOptions = {}): string {
  const delimiter = options.delimiter ?? ",";
  assertCsvDelimiter(delimiter);
  const lines: string[] = [];
  if (options.header !== false) {
    lines.push(columns.map((c) => quote(c, delimiter)).join(delimiter));
  }
  for (const row of rows) {
    lines.push(columns.map((c) => quote(csvCellText(row[c]), delimiter)).join(delimiter));
  }
  return lines.length > 0 ? `${lines.join("\r\n")}\r\n` : "";
}
