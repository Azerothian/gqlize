import { createHmac, timingSafeEqual } from "node:crypto";
import { base64, unbase64 } from "../graphql/utils/base64";
import type { CursorCodec } from "../types";

/**
 * The shipped {@link CursorCodec}s.
 *
 * A cursor carries a connection name and an absolute row index. Both halves are
 * load-bearing: the index is arithmetic (`OFFSET`, and the `hasNextPage` /
 * `hasPreviousPage` derivation compares it against the total), and the name is
 * what rejects a cursor minted by a different connection, whose index would mean
 * something else entirely here.
 *
 * None of them throws. One caller turns a `null` into `GraphQLError("Invalid
 * cursor")` and another — the nested-relation offset planner — swallows it and
 * plans no offset; a codec should not have to know which one it is inside.
 */

/** Shared shape check, so every codec agrees on what an index is. */
function asIndex(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const index = parseInt(value, 10);
  return Number.isInteger(index) ? index : null;
}

/**
 * base64 `["Connection", index]` — the default, and what every previous version
 * emitted.
 */
export function relayCursorCodec(): CursorCodec {
  return {
    encode: ({connection, index}) => base64(JSON.stringify([connection, index])),
    decode: ({value}) => {
      if (typeof value !== "string") {
        return null;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(unbase64(value));
      } catch {
        return null;
      }
      if (!Array.isArray(decoded)) {
        return null;
      }
      const [connection, rawIndex] = decoded as [unknown, unknown];
      const index = asIndex(rawIndex);
      if (typeof connection !== "string" || index === null) {
        return null;
      }
      return {connection, index};
    },
  };
}

/**
 * `Connection:index` — the same information with no encoding, so cursors are
 * readable in logs and editable by hand in a playground.
 *
 * Split on the *last* colon: connection names are built from model and
 * relationship names and never contain one, but reading from the right costs
 * nothing and cannot be surprised.
 */
export function plainCursorCodec(): CursorCodec {
  return {
    encode: ({connection, index}) => `${connection}:${index}`,
    decode: ({value}) => {
      if (typeof value !== "string") {
        return null;
      }
      const split = value.lastIndexOf(":");
      if (split <= 0) {
        return null;
      }
      const index = asIndex(value.slice(split + 1));
      if (index === null || !/^-?\d+$/.test(value.slice(split + 1))) {
        return null;
      }
      return {connection: value.slice(0, split), index};
    },
  };
}

export interface SignedCursorCodecOptions {
  /** HMAC key. Treat it as a secret: anyone holding it can mint cursors. */
  secret: string;
  /** digest, default `sha256` */
  algorithm?: string;
  /** how many hex characters of the digest to keep, default 16 (64 bits) */
  length?: number;
}

/**
 * `Connection:index.<hmac>` — a plain cursor with its integrity closed.
 *
 * Cursors are otherwise trivially forgeable: the index is an absolute offset, so
 * a client that mints one for a connection it can see can page from anywhere in
 * that connection's result set. The connection-name check bounds *which*
 * connection; this bounds the index too.
 */
export function signedCursorCodec(options: SignedCursorCodecOptions): CursorCodec {
  const {secret, algorithm = "sha256", length = 16} = options;
  if (!secret) {
    throw new Error("gqlize: signedCursorCodec requires a secret — an unsigned signature signs nothing.");
  }
  const sign = (payload: string) =>
    createHmac(algorithm, secret).update(payload).digest("hex").slice(0, length);
  return {
    encode: ({connection, index}) => {
      const payload = `${connection}:${index}`;
      return `${payload}.${sign(payload)}`;
    },
    decode: ({value}) => {
      if (typeof value !== "string") {
        return null;
      }
      const split = value.lastIndexOf(".");
      if (split <= 0) {
        return null;
      }
      const payload = value.slice(0, split);
      const supplied = Buffer.from(value.slice(split + 1), "utf8");
      const expected = Buffer.from(sign(payload), "utf8");
      // Length has to match before `timingSafeEqual`, which throws on unequal
      // buffers rather than returning false.
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return null;
      }
      const at = payload.lastIndexOf(":");
      if (at <= 0) {
        return null;
      }
      const index = asIndex(payload.slice(at + 1));
      if (index === null) {
        return null;
      }
      return {connection: payload.slice(0, at), index};
    },
  };
}

/**
 * Mint with `next`, accept anything `next` or any of `previous` minted.
 *
 * Cursors are in-flight state in a way ids are not: a client paging through a
 * connection across a rolling deploy is holding cursors in the format the *old*
 * process minted. Swapping `options.cursor` in one step invalidates them all
 * mid-pagination. Deploy this instead, then drop the trailing codecs a
 * pagination-lifetime later.
 */
export function fallbackCursorCodec(next: CursorCodec, ...previous: CursorCodec[]): CursorCodec {
  return {
    encode: (ctx) => next.encode(ctx),
    decode: (ctx) => {
      for (const codec of [next, ...previous]) {
        const decoded = codec.decode(ctx);
        if (decoded) {
          return decoded;
        }
      }
      return null;
    },
  };
}

/** The codec used when `options.cursor` is absent. */
export const defaultCursorCodec: CursorCodec = relayCursorCodec();
