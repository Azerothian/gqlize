// Turning whatever a host hands over as "the uploaded file" into a stream of
// chunks for `./read`.
//
// ormize parses no multipart itself — that belongs to the host (graphql-upload,
// multer, a raw `text/csv` body) — so this accepts the shapes those produce
// rather than one of them.

import { CsvUploadError } from "./errors";

/** A chunk of CSV text, as either a string or bytes. */
export type CsvChunk = string | Uint8Array;

/**
 * What a CSV upload may be:
 *
 * - CSV text, or its bytes;
 * - an iterable of chunks, sync or async — a Node `Readable`, a web
 *   `ReadableStream`, an array of strings;
 * - graphql-upload's `FileUpload` (`createReadStream()`), or its `Upload`
 *   wrapper (`promise` resolving to one);
 * - a web `File`/`Blob` (`stream()`), or anything else carrying a `stream`;
 * - a promise of any of the above, which is what the `GQLTUpload` scalar hands
 *   a resolver.
 */
export type CsvUpload = unknown;

type Carrier = {
  promise?: unknown;
  createReadStream?: () => unknown;
  stream?: unknown;
};

/** What `for await` can walk: either kind of iterable. */
export type CsvChunks = AsyncIterable<CsvChunk> | Iterable<CsvChunk>;

function isIterable(v: unknown): v is CsvChunks {
  const o = v as { [Symbol.asyncIterator]?: unknown; [Symbol.iterator]?: unknown } | null | undefined;
  return !!o && (typeof o[Symbol.asyncIterator] === "function" || typeof o[Symbol.iterator] === "function");
}

/**
 * Resolve an upload to the chunks of its content.
 *
 * Unwrapping is bounded: a `promise` that resolves to another carrier is
 * followed, but only a few levels deep, so a self-referencing object cannot
 * spin this forever.
 */
export async function csvChunks(upload: CsvUpload): Promise<CsvChunks> {
  let value: unknown = await Promise.resolve(upload);
  for (let depth = 0; depth < 4; depth++) {
    // Before the iterable test: a string iterates by character and a
    // Uint8Array by byte, and either is one chunk, not many.
    if (typeof value === "string" || value instanceof Uint8Array) {
      return [value];
    }
    if (isIterable(value)) {
      return value;
    }
    if (!value || typeof value !== "object") {
      break;
    }
    const carrier = value as Carrier;
    if (typeof carrier.createReadStream === "function") {
      value = carrier.createReadStream();
    } else if (typeof carrier.stream === "function") {
      value = (carrier.stream as () => unknown).call(carrier);
    } else if (carrier.stream !== undefined) {
      value = carrier.stream;
    } else if (carrier.promise !== undefined) {
      value = await Promise.resolve(carrier.promise);
    } else {
      break;
    }
  }
  throw new CsvUploadError("CSV_UNSUPPORTED", "The upload is not a readable file");
}
