import { GraphQLError } from "graphql";
import { defaultIdCodec } from "../codecs/id";
import type { IdCodec } from "../types";

/**
 * Decode one opaque id against the type the field it sits on points at.
 *
 * The cross-type check lives here rather than inside each codec for two reasons.
 * A codec's `null` means "not one of mine" and callers must leave such a value
 * alone — folding "mine, but minted for another model" into the same `null` made
 * the two indistinguishable, so the only thing a caller could do with a forged id
 * was compare it literally and match nothing. And only this layer knows the model
 * and field being decoded, which is the difference between an empty result set
 * and an error that names `RoleUser.userId`. An out-of-tree codec gets the check
 * for free as a side effect.
 *
 * A codec that cannot carry a type (`carriesType: false`) is exempt: there is
 * nothing in its ids to disagree with the expectation.
 *
 * @returns the raw key, or `null` when the value is not one of the codec's ids —
 *          a raw primary key typed straight into a filter or a mutation input,
 *          which must survive untouched.
 * @throws  {GraphQLError} when the value *is* one of the codec's ids but names a
 *          different type than the field expects.
 */
export function decodeGlobalId(
  value: string,
  ctx: {type?: string; defName?: string; fieldName?: string},
  codec: IdCodec = defaultIdCodec,
): string | null {
  const {type, defName, fieldName} = ctx;
  const decoded = codec.decode({value, type, defName, fieldName});
  if (!decoded) {
    return null;
  }
  // Nothing to compare against when the format does not carry a type: a codec
  // declaring `carriesType: false` (and any codec that answers with an empty one)
  // is telling us the id names no model, not that it names the wrong one.
  if (type && decoded.type && codec.carriesType !== false && decoded.type !== type) {
    const field = [defName, fieldName].filter(Boolean).join(".");
    throw new GraphQLError(
      `gqlize: ${field ? `"${field}"` : "this field"} expects a "${type}" id, ` +
        `but the id given is a "${decoded.type}" id`,
      {extensions: {
        code: "GLOBAL_ID_TYPE_MISMATCH",
        field: field || undefined,
        expected: type,
        received: decoded.type,
      }},
    );
  }
  return decoded.id;
}
