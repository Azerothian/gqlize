import { createHash } from "node:crypto";

// Values longer than this are hashed into the key rather than embedded literally,
// keeping keys bounded while short/simple values stay human-readable.
const MAX_LITERAL = 64;

/**
 * A primary-key value as this adapter ever produces or accepts one: a
 * sequence integer, a generated UUID string, or whatever scalar a caller
 * supplied under a "provided" pk strategy (see `model.ts`).
 */
export type KeyId = string | number | bigint;

/**
 * Encode a field value into a key-safe segment. Redis keys are opaque byte
 * strings and we never parse them back (membership sets track which keys an id
 * belongs to), so the only requirement is that distinct values map to distinct
 * segments. Short simple values stay literal; anything longer/whitespaced is
 * SHA-1 hashed.
 */
export function encodeValue(value: unknown): string {
  // An indexed/unique field's value is a scalar by construction. Anything else is
  // malformed input, and still needs a stable (if opaque) segment rather than a
  // throw — which is why the scalar and non-scalar arms this replaces both read
  // `String(value)` and could simply be one.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- see comment above
  const s = value == null ? " null" : String(value);
  if (s.length <= MAX_LITERAL && !/\s/.test(s)) {
    return s;
  }
  return "#" + createHash("sha1").update(s).digest("hex");
}

/** Builds the Valkey keyspace for a given prefix. See README for the schema. */
export class Keys {
  constructor(public readonly prefix: string) {}

  /** The object hash/string: `{p}:{model}:o:{id}`. */
  obj(model: string, id: KeyId): string {
    return `${this.prefix}:${model}:o:${id}`;
  }
  /** ZSET of all ids for a model (score = expiry epoch-ms or +inf). */
  ids(model: string): string {
    return `${this.prefix}:${model}:ids`;
  }
  /** ZSET of ids where `field == value`. */
  index(model: string, field: string, value: unknown): string {
    return `${this.prefix}:${model}:i:${field}:${encodeValue(value)}`;
  }
  /** Unique-index key holding a single id (uniqueness enforcement). */
  unique(model: string, field: string, value: unknown): string {
    return `${this.prefix}:${model}:u:${field}:${encodeValue(value)}`;
  }
  /** SET of every index/unique key an id currently belongs to (cleanup). */
  membership(model: string, id: KeyId): string {
    return `${this.prefix}:${model}:m:${id}`;
  }
  /** INCR counter for integer primary keys. */
  seq(model: string): string {
    return `${this.prefix}:${model}:seq`;
  }
}
