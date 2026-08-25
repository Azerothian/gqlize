import { fromGlobalId, toGlobalId } from "graphql-relay";
import type { IdCodec } from "../types";

/**
 * The shipped {@link IdCodec}s.
 *
 * Everything gqlize hands a client as an `ID` goes through one of these, and
 * everything it reads back comes through the same one. The seam is the point:
 * before it existed, `toGlobalId`/`fromGlobalId` were called directly at four
 * sites and the format was not a choice anyone could make.
 */

/**
 * Cheap pre-filter: anything that is not base64-shaped cannot be a relay global
 * id. Private to this codec — it is a fact about *this* format, and it used to
 * live in `replaceIdDeep` where every other format had to step around it.
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * base64 `Type:id` — the relay global id, and the default.
 *
 * `decode` is deliberately fussy. `fromGlobalId` base64-decodes and splits on the
 * first colon, and it does not fail on input that merely happens to decode to
 * bytes: `"deadbeef"` is valid base64, so it yields binary garbage rather than an
 * error, and `"42"` yields `{type: "", id: ""}`. A value that does not produce a
 * non-empty type *and* id is not one of ours, and the caller must leave it alone.
 */
export function relayIdCodec(): IdCodec {
  return {
    carriesType: true,
    // `toGlobalId` stringifies whatever it is handed via `GraphQLID.serialize`;
    // the value is a primary or foreign key, so it is a string or a number in
    // every backend here.
    encode: ({type, id}) => toGlobalId(type, id),
    decode: ({value, type}) => {
      if (typeof value !== "string" || !BASE64.test(value)) {
        return null;
      }
      try {
        const decoded = fromGlobalId(value);
        if (!decoded.type || !decoded.id) {
          return null;
        }
        // An id minted for another model is not this key's id. Decoding it
        // anyway would filter a `Post` foreign key on a `Task`'s primary key —
        // a value that matches whatever unrelated row happens to share it.
        if (type && decoded.type !== type) {
          return null;
        }
        return {type: decoded.type, id: decoded.id};
      } catch {
        return null;
      }
    },
  };
}

export interface PrefixIdCodecOptions {
  /** model name -> the literal prefix its ids carry, e.g. `{Asset: "AST"}` */
  prefixes: {[typeName: string]: string};
  /**
   * Zero-pad the key to this width, so ids sort lexicographically and have a
   * fixed length. Padding is stripped back off on decode when what remains is
   * all digits — a key that is genuinely `"007"` is not something padding can be
   * distinguished from, so do not pad string keys you intend to round-trip.
   */
  pad?: number;
}

/**
 * Readable prefixed ids — `AST0000000001` for `Asset` row 1.
 *
 * The prefix *is* the type, so ids stay self-describing and `node(id:)` keeps
 * working. A value whose prefix is not in the map is not one of ours and decodes
 * to `null`, which is what leaves a raw key in a filter untouched.
 */
export function prefixIdCodec(options: PrefixIdCodecOptions): IdCodec {
  const {prefixes, pad = 0} = options;
  // Longest first: `TSK` and `TSKI` would otherwise resolve by map order.
  const byPrefix = Object.keys(prefixes)
    .map((typeName) => ({typeName, prefix: prefixes[typeName]}))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return {
    carriesType: true,
    encode: ({type, id}) => {
      const prefix = prefixes[type];
      if (prefix === undefined) {
        throw new Error(
          `gqlize: prefixIdCodec has no prefix for type "${type}". Every model whose ` +
            "primary or foreign keys are exposed needs one, or its ids cannot be minted.",
        );
      }
      const raw = `${id}`;
      return `${prefix}${pad > 0 ? raw.padStart(pad, "0") : raw}`;
    },
    decode: ({value, type}) => {
      if (typeof value !== "string") {
        return null;
      }
      const match = byPrefix.find((p) => p.prefix.length > 0 && value.startsWith(p.prefix));
      if (!match) {
        return null;
      }
      if (type && match.typeName !== type) {
        return null;
      }
      let id = value.slice(match.prefix.length);
      if (id.length === 0) {
        return null;
      }
      if (pad > 0 && /^\d+$/.test(id)) {
        id = id.replace(/^0+(?=\d)/, "");
      }
      return {type: match.typeName, id};
    },
  };
}

/**
 * No encoding at all: the client sees the raw primary key.
 *
 * `carriesType: false`, so `createSchema` omits the relay `node` field rather
 * than shipping one that cannot tell a `Task` id from a `Post` id and returns
 * null for every lookup. Everything else — filters, mutation inputs, nested
 * relationship keys — round-trips, because the identity function round-trips.
 */
export function rawIdCodec(): IdCodec {
  return {
    carriesType: false,
    encode: ({id}) => `${id}`,
    // Every string is a raw id, including one that used to be a global id — there
    // is nothing here to recognise, which is exactly what `carriesType` reports.
    decode: ({value, type}) => (typeof value === "string" ? {type: type || "", id: value} : null),
  };
}

/** The codec used when `options.id` is absent. */
export const defaultIdCodec: IdCodec = relayIdCodec();
