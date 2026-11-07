/**
 * JSON that keeps the column types JSON can't carry. A cached `createdAt` has to
 * come back as a `Date`, or a resolver that calls `.toISOString()` on it breaks
 * on the second request and not the first. Same for `Buffer` (BLOB/BYTEA) and
 * `bigint` (which `JSON.stringify` refuses outright).
 *
 * Tagged objects use a key no column is likely to have. A row that really has
 * an `$ormize` field would be mis-decoded, and that is the price of not
 * escaping every object on the way through.
 *
 * One explicit walk each way, then plain `JSON.stringify`/`JSON.parse`. A
 * replacer or reviver does the same job, but it costs a function call per key,
 * and on a page of eager-loaded rows that made encoding about 3x and decoding
 * about 4x slower (see `gqlize/__tests__/bench/read-cache.bench.ts`).
 */
const TAG = "$ormize";

type Tagged = {[TAG]: "date" | "buffer" | "bigint", v: string | null};

function tag(value: unknown): unknown {
  if (typeof value === "bigint") {
    return {[TAG]: "bigint", v: value.toString()};
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return {[TAG]: "date", v: Number.isNaN(value.getTime()) ? null : value.toISOString()};
  }
  if (Buffer.isBuffer(value)) {
    return {[TAG]: "buffer", v: value.toString("base64")};
  }
  if (Array.isArray(value)) {
    return value.map(tag);
  }
  // What `JSON.stringify` would have done with it (a decimal type, say), and
  // then walked, in case that hands back a Date of its own.
  const toJSON = (value as {toJSON?: () => unknown}).toJSON;
  if (typeof toJSON === "function") {
    return tag(toJSON.call(value));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = tag((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** In place: a freshly parsed tree belongs to nobody else. */
function untag(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = untag(value[i]);
    }
    return value;
  }
  if (TAG in value) {
    const {[TAG]: type, v} = value as Tagged;
    switch (type) {
      case "date":
        return v === null ? new Date(NaN) : new Date(v);
      case "buffer":
        return Buffer.from(v as string, "base64");
      case "bigint":
        return BigInt(v as string);
    }
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    record[key] = untag(record[key]);
  }
  return record;
}

export function encode(value: unknown): string {
  return JSON.stringify(tag(value));
}

export function decode(text: string): unknown {
  return untag(JSON.parse(text));
}
