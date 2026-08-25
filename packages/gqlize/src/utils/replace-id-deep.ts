import { OKind, objVisit } from "@vostro/object-visit";
import { defaultIdCodec } from "../codecs/id";
import type { IdTranslation } from "../types";

/**
 * Rewrite opaque ids into raw ids inside a `where` tree.
 *
 * This is the single implementation shared by every adapter: the GraphQL layer
 * hands adapters a filter whose id-typed values are still opaque, and each
 * adapter needs them decoded before the filter reaches the datastore. Keeping one
 * copy is not just tidiness — the "is this actually one of our ids" guard was
 * fixed twice and missed once, which is exactly the failure a shared module
 * prevents. It now lives inside the codec, where it belongs: only the codec knows
 * what its own format looks like.
 */

/**
 * @param obj            the where tree, or a function producing one from `variableValues`
 * @param globalKeys     field names whose values are opaque ids (primary/foreign keys)
 * @param variableValues GraphQL variables. Opaque here — this function never reads
 *                       them, it only forwards them to a function-valued `obj`, and
 *                       typing them concretely would pin the signature to one of the
 *                       several shapes callers hold (`GraphQLResolveInfo`'s readonly
 *                       record, an adapter's plain object).
 * @param translation    the id codec and its key targets. A trailing parameter
 *                       rather than a replacement for `variableValues`, so an
 *                       out-of-tree adapter that never learned about it keeps
 *                       working — on the default codec, which is the correct
 *                       fallback and the only one it could have been using.
 *
 * Generic in the tree type so it satisfies `Selection["translateFilter"]`: only leaf
 * string values change, so the shape the caller passed in is the shape it gets back.
 *
 * Everything beneath a `globalKeys` field is eligible for decoding, which is what
 * makes operator wrappers work: `{id: {in: [...]}}` decodes the array members.
 */
export default function replaceIdDeep<W>(
  obj: W,
  globalKeys: string[],
  variableValues?: unknown,
  translation?: IdTranslation,
): W {
  if (obj instanceof Function) {
    obj = obj(variableValues) as W;
  }
  const codec = translation?.codec || defaultIdCodec;
  const targets = translation?.targets;
  const defName = translation?.defName;
  // The key that opened the current region rather than a bare flag: the leaf
  // being decoded sits under an operator wrapper or an array index, so the field
  // name — and with it the type the id is supposed to name — is only knowable
  // from the boundary. `globalKeys` hold scalars and operator wrappers, never
  // another global key, so the regions cannot nest and one slot is enough.
  let tagged: string | null = null;
  const enter = (node: unknown, key: string | number | undefined) => {
    if (key !== undefined && tagged === null && globalKeys.indexOf(`${key}`) > -1) {
      tagged = `${key}`;
    }
    return node;
  };
  const leave = (node: unknown, key: string | number | undefined) => {
    if (tagged !== null && globalKeys.indexOf(`${key}`) > -1) {
      tagged = null;
    }
    return node;
  };
  return objVisit(obj, {
    [OKind.ARRAY]: { enter, leave },
    [OKind.OBJECT]: { enter, leave },
    [OKind.FIELD]: {
      enter(node: unknown, key: string | number | undefined) {
        enter(node, key);
        if (tagged !== null && typeof node === "string") {
          const fieldName = tagged;
          const decoded = codec.decode({
            value: node,
            type: targets?.[fieldName],
            defName,
            fieldName,
          });
          if (decoded) {
            return decoded.id;
          }
        }
        return node;
      },
      leave,
    },
  }) as W;
}
