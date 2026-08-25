import GqlizeBinding from "./manager";
import { createSchema as buildSchema } from "./graphql/index";
import type { AnyOrmize, GqlizeOptions } from "./types";

/**
 * `options` is typed rather than `any` on purpose: `permission` is a closed
 * shape, so TypeScript's excess-property check on an object literal catches a
 * misspelled predicate here. That matters more than usual because an absent
 * predicate means ALLOW — a typo fails *open*, silently. `unknownPermissionKeys`
 * covers the same mistake at runtime for JS callers.
 */
export function createSchema(orm: AnyOrmize, options?: GqlizeOptions) {
  return buildSchema(new GqlizeBinding(orm, options), options);
}

/**
 * The shipped id and cursor codecs. `options.id` / `options.cursor` default to
 * `relayIdCodec()` / `relayCursorCodec()`, which are what every previous version
 * emitted; the rest are swap-ins.
 */
export {relayIdCodec, prefixIdCodec, rawIdCodec, defaultIdCodec, type PrefixIdCodecOptions} from "./codecs/id";
export {
  relayCursorCodec,
  plainCursorCodec,
  signedCursorCodec,
  fallbackCursorCodec,
  defaultCursorCodec,
  type SignedCursorCodecOptions,
} from "./codecs/cursor";
export type {IdCodec, CursorCodec, GqlizeOptions} from "./types";
