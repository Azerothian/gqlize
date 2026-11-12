// Reading the files of a multi-file CSV import (`POST /_csv`) off a
// multipart/form-data request.
//
// A host that already parsed the body (multer's `AnyFilesInterceptor`, say)
// leaves the files on `req.files`, and they are taken from there. Otherwise
// the request stream is read here with busboy, the parser multer itself uses.
// Nest's default parsers leave a multipart body unread. Fastify needs a
// pass-through content-type parser for `multipart/form-data` for the same
// reason. Each file is held in memory, metered against its model's `maxBytes`
// as it arrives, and the file count against `maxFiles`, so neither is
// buffered past its limit.

import busboy from "busboy";
import type { IncomingHttpHeaders } from "http";
import type { Readable } from "stream";
import { CsvUploadError } from "@azerothian/ormize";
import type { RestRequest } from "./types";

export type CsvPart = { field: string; data: Buffer };

export type CsvParts = {
  /** The file parts, in the order they arrived. */
  files: CsvPart[];
  /** The text parts, by field name. */
  fields: { [field: string]: string };
};

export type CsvPartLimits = {
  maxFiles: number;
  /** A file part's byte limit, by its field name; `undefined` refuses the part. */
  maxBytes: (field: string) => number;
};

type RequestShapes = {
  headers?: IncomingHttpHeaders;
  raw?: { headers?: IncomingHttpHeaders } & Readable;
  body?: unknown;
  /** multer's `AnyFilesInterceptor` / `FilesInterceptor`, memory storage. */
  files?: unknown;
};

type MulterFile = { fieldname?: unknown; buffer?: unknown; size?: unknown };

function tooLarge(field: string, limit: number) {
  return new CsvUploadError("CSV_TOO_LARGE", `The CSV is larger than the ${limit}-byte limit`, { file: field });
}

function tooMany(limit: number) {
  return new CsvUploadError("CSV_TOO_MANY_FILES", `The import has more than ${limit} files`);
}

/** Files a multipart interceptor already read, or `undefined` when there are none. */
function parsedParts(r: RequestShapes, limits: CsvPartLimits): CsvParts | undefined {
  const list = Array.isArray(r.files)
    ? r.files as MulterFile[]
    // `FileFieldsInterceptor` groups them by field.
    : r.files && typeof r.files === "object" ? Object.values(r.files as { [field: string]: MulterFile[] }).flat() : undefined;
  if (!list || list.length === 0) {
    return undefined;
  }
  if (list.length > limits.maxFiles) {
    throw tooMany(limits.maxFiles);
  }
  const files = list.map((f) => {
    const field = String(f.fieldname);
    if (!(f.buffer instanceof Uint8Array)) {
      throw new CsvUploadError("CSV_UNSUPPORTED", "Use memory storage for the CSV files, so their bytes are on the request", { file: field });
    }
    const limit = limits.maxBytes(field);
    if (f.buffer.byteLength > limit) {
      throw tooLarge(field, limit);
    }
    return { field, data: Buffer.from(f.buffer) };
  });
  const fields: { [field: string]: string } = {};
  if (r.body && typeof r.body === "object") {
    for (const [key, value] of Object.entries(r.body)) {
      if (typeof value === "string") {
        fields[key] = value;
      }
    }
  }
  return { files, fields };
}

/** Read a multipart request's CSV files and text fields under the limits. */
export async function readCsvParts(req: RestRequest, limits: CsvPartLimits): Promise<CsvParts> {
  const r = (req || {}) as RequestShapes;
  const parsed = parsedParts(r, limits);
  if (parsed) {
    return parsed;
  }
  const stream = (r.raw ?? req) as Readable & { headers?: IncomingHttpHeaders };
  const headers = stream.headers ?? r.headers ?? {};
  if (!String(headers["content-type"] || "").toLowerCase().startsWith("multipart/form-data")) {
    throw new CsvUploadError("CSV_UNSUPPORTED", "Send the files as multipart/form-data, one file part per CSV");
  }
  return new Promise<CsvParts>((resolve, reject) => {
    const files: CsvPart[] = [];
    const fields: { [field: string]: string } = {};
    // Everything that fails a part is an Error: a CsvUploadError, or the
    // HttpException a gate throws for a part it refuses.
    let failure: Error | undefined;
    const fail = (e: unknown) => {
      failure = failure ?? (e instanceof Error ? e : new Error(String(e)));
    };
    let parser: busboy.Busboy;
    try {
      // One more than allowed, so going over is seen rather than silently cut.
      parser = busboy({ headers, limits: { files: limits.maxFiles + 1 } });
    } catch (e) {
      reject(new CsvUploadError("CSV_UNSUPPORTED", `Not a readable multipart body: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    parser.on("file", (field, file) => {
      if (failure !== undefined) {
        file.resume();
        return;
      }
      if (files.length >= limits.maxFiles) {
        fail(tooMany(limits.maxFiles));
        file.resume();
        return;
      }
      let limit: number;
      try {
        limit = limits.maxBytes(field);
      } catch (e) {
        fail(e);
        file.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      file.on("data", (chunk: Buffer) => {
        if (failure !== undefined) {
          return;
        }
        size += chunk.byteLength;
        if (size > limit) {
          fail(tooLarge(field, limit));
          return;
        }
        chunks.push(chunk);
      });
      file.on("end", () => {
        if (failure === undefined) {
          files.push({ field, data: Buffer.concat(chunks) });
        }
      });
    });
    parser.on("field", (name, value) => {
      fields[name] = value;
    });
    parser.on("filesLimit", () => fail(tooMany(limits.maxFiles)));
    parser.on("error", (e) => {
      fail(new CsvUploadError("CSV_UNSUPPORTED", `Not a readable multipart body: ${e instanceof Error ? e.message : String(e)}`));
      resolveOrReject();
    });
    parser.on("close", () => resolveOrReject());
    let settled = false;
    function resolveOrReject() {
      if (settled) {
        return;
      }
      settled = true;
      if (failure !== undefined) {
        reject(failure);
      } else {
        resolve({ files, fields });
      }
    }
    stream.pipe(parser);
  });
}
