// Streaming a CSV upload into header + records, under the configured limits.
//
// Parsing is csv-parse's (RFC 4180: quoted fields, embedded newlines, CRLF, a
// leading BOM). This module owns what the parser does not: the byte and row
// limits, enforced as the chunks arrive, and the header rules. Turning the
// string cells into typed mutation arguments belongs to each surface (gqlize
// reads its input types, nestize the column descriptors), which is why a record
// leaves here as strings.

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import type { ResolvedCsvLimits } from "@azerothian/utilize/types/index";

import { CsvUploadError } from "./errors";
import { csvChunks, type CsvChunks, type CsvUpload } from "./source";

/**
 * The cell that means SQL `NULL`. An empty cell cannot: on an update it has to
 * mean "leave this column alone", or a sparse sheet would null every column it
 * does not mention. `\N` is what `COPY` and `mysqldump` already write.
 */
export const CSV_NULL = "\\N";

/**
 * One row's cells by header name. An empty cell is left out entirely, and
 * {@link CSV_NULL} becomes `null`.
 */
export type CsvCells = { [column: string]: string | null };

/** A data row and its 1-based position, the header not counted. */
export type CsvRecord = { row: number; cells: CsvCells };

export type CsvTable = { header: string[]; records: CsvRecord[] };

export type ReadCsvOptions = {
  /** The field separator. Default `,`. */
  delimiter?: string;
};

function toBuffer(chunk: unknown): Buffer {
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  // The `GQLTUpload` scalar passes any JSON variable through, so an array of
  // numbers is as reachable as an array of strings.
  throw new CsvUploadError("CSV_UNSUPPORTED", "The upload is not a readable file");
}

async function* metered(chunks: CsvChunks, maxBytes: number): AsyncGenerator<Buffer> {
  let bytes = 0;
  for await (const chunk of chunks) {
    const piece = toBuffer(chunk);
    bytes += piece.byteLength;
    if (bytes > maxBytes) {
      throw new CsvUploadError("CSV_TOO_LARGE", `The CSV is larger than the ${maxBytes}-byte limit`);
    }
    yield piece;
  }
}

function checkDelimiter(delimiter: string): string {
  // Client-supplied (it is an argument on the GraphQL field), so a value that
  // would let one cell's content be read as structure is refused rather than
  // handed to the parser.
  if (delimiter.length !== 1 || delimiter === "\"" || delimiter === "\r" || delimiter === "\n") {
    throw new CsvUploadError("CSV_PARSE", `Unsupported delimiter ${JSON.stringify(delimiter)}: use a single character other than a quote or a newline`);
  }
  return delimiter;
}

function checkHeader(fields: string[]): string[] {
  const header = fields.map((name) => name.trim());
  const seen = new Set<string>();
  header.forEach((name, index) => {
    if (name === "") {
      throw new CsvUploadError("CSV_HEADER", `Header column ${index + 1} is blank`);
    }
    if (seen.has(name)) {
      throw new CsvUploadError("CSV_HEADER", `Header column "${name}" appears more than once`, { column: name });
    }
    seen.add(name);
  });
  return header;
}

function toCells(header: string[], fields: string[]): CsvCells {
  const cells: CsvCells = {};
  header.forEach((name, index) => {
    const raw = fields[index];
    if (raw === undefined || raw === "") {
      return;
    }
    cells[name] = raw === CSV_NULL ? null : raw;
  });
  return cells;
}

/** csv-parse's own errors carry a `CSV_*` code and the line they stopped on. */
function translate(e: unknown): unknown {
  if (e instanceof CsvUploadError) {
    return e;
  }
  const parseError = e as { code?: unknown; lines?: unknown; message?: string } | undefined;
  if (parseError && typeof parseError.code === "string" && parseError.code.startsWith("CSV_")) {
    const at = typeof parseError.lines === "number" ? ` (line ${parseError.lines})` : "";
    return new CsvUploadError("CSV_PARSE", `Malformed CSV${at}: ${parseError.message}`, { cause: e });
  }
  return e;
}

/**
 * Read an upload into its header and records.
 *
 * Every record is held, which is bounded by `maxRows`/`maxBytes`, and is what
 * lets the caller convert and check every row before the first write — a cell
 * that will not convert should fail the upload before it opens a transaction.
 */
export async function readCsv(upload: CsvUpload, limits: ResolvedCsvLimits, options: ReadCsvOptions = {}): Promise<CsvTable> {
  const delimiter = checkDelimiter(options.delimiter ?? ",");
  const chunks = await csvChunks(upload);
  const parser = parse({ bom: true, delimiter, skip_empty_lines: true });
  const pumping = pipeline(Readable.from(metered(chunks, limits.maxBytes)), parser);
  // Handled now and awaited below: stopping early (too many rows) destroys the
  // parser, and the rejection that produces must not surface as unhandled
  // before the `await` is reached.
  pumping.catch(() => undefined);

  let header: string[] | undefined;
  const records: CsvRecord[] = [];
  try {
    for await (const fields of parser as AsyncIterable<string[]>) {
      if (!header) {
        header = checkHeader(fields);
        continue;
      }
      if (records.length >= limits.maxRows) {
        throw new CsvUploadError("CSV_TOO_MANY_ROWS", `The CSV has more than the ${limits.maxRows}-row limit`);
      }
      records.push({ row: records.length + 1, cells: toCells(header, fields) });
    }
    await pumping;
  } catch (e) {
    throw translate(e);
  }
  if (!header) {
    throw new CsvUploadError("CSV_HEADER", "The CSV has no header row");
  }
  return { header, records };
}
