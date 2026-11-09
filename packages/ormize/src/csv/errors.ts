// The one error a CSV upload raises. Graphql-free like the rest of ormize, so
// each surface translates it: gqlize into a `GraphQLError` carrying `code`,
// `row` and `column` as extensions, nestize into a 400.

/** Why an upload was refused. Stable strings: clients branch on them. */
export type CsvUploadErrorCode =
  /** The model has no CSV support, or the upload is not a readable file. */
  | "CSV_UNSUPPORTED"
  /** More bytes than `maxBytes`. */
  | "CSV_TOO_LARGE"
  /** More data rows than `maxRows`. */
  | "CSV_TOO_MANY_ROWS"
  /** Malformed CSV — an unclosed quote, a row with the wrong number of cells. */
  | "CSV_PARSE"
  /** The header is missing, has a blank or repeated name, or names a column the operation cannot take. */
  | "CSV_HEADER"
  /** A cell that does not convert to its column's type, or a row the input type rejects. */
  | "CSV_ROW_INVALID"
  /** An update or delete row whose key columns matched no row. */
  | "CSV_ROW_NO_MATCH"
  /** The write for a row failed; `cause` is what the engine threw. */
  | "CSV_ROW_FAILED";

export class CsvUploadError extends Error {
  readonly code: CsvUploadErrorCode;
  /**
   * 1-based data row, the header not counted — the number a spreadsheet shows
   * minus one. Absent for an error about the file as a whole.
   */
  readonly row?: number;
  /** The header name of the offending column, when there is one. */
  readonly column?: string;

  constructor(code: CsvUploadErrorCode, message: string, at: { row?: number; column?: string; cause?: unknown } = {}) {
    super(message, at.cause === undefined ? undefined : { cause: at.cause });
    this.name = "CsvUploadError";
    this.code = code;
    this.row = at.row;
    this.column = at.column;
  }
}
