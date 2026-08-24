import { fromGlobalId } from "graphql-relay";
import { OKind, objVisit } from "@vostro/object-visit";

/**
 * Rewrite Relay global ids into raw ids inside a `where` tree.
 *
 * This is the single implementation shared by every adapter: the GraphQL layer
 * hands adapters a filter whose id-typed values are still opaque global ids, and
 * each adapter needs them decoded before the filter reaches the datastore.
 * Keeping one copy is not just tidiness — the guard below was fixed twice and
 * missed once, which is exactly the failure a shared module prevents.
 */

/** Cheap pre-filter: anything that is not base64-shaped cannot be a global id. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decode a value as a Relay global id, but ONLY when it actually is one.
 *
 * `fromGlobalId` base64-decodes and splits `Type:id`, and it does not fail on
 * input that merely decodes to bytes. Testing the base64 *charset* alone is
 * therefore not enough: a legitimate ID-typed filter value like "ABCD1234" or
 * "deadbeef" is valid base64, so it was silently decoded into binary garbage and
 * the filter matched nothing — no error, no log, just missing rows. A genuine
 * global id yields a non-empty type AND id; anything else is left untouched.
 */
function tryDecodeGlobalId(node: string): string | null {
  try {
    const { type, id } = fromGlobalId(node);
    if (type && id) {
      return id;
    }
  } catch {
    // not a decodable global id — fall through
  }
  return null;
}

/**
 * @param obj            the where tree, or a function producing one from `variableValues`
 * @param globalKeys     field names whose values are global ids (primary/foreign keys)
 * @param variableValues GraphQL variables. Opaque here — this function never reads
 *                       them, it only forwards them to a function-valued `obj`, and
 *                       typing them concretely would pin the signature to one of the
 *                       several shapes callers hold (`GraphQLResolveInfo`'s readonly
 *                       record, an adapter's plain object).
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
): W {
  if (obj instanceof Function) {
    obj = obj(variableValues) as W;
  }
  // A single flag rather than a stack: `globalKeys` hold scalars and operator
  // wrappers, never another global key, so the regions cannot nest.
  let tagged = false;
  const enter = (node: unknown, key: string | number | undefined) => {
    if (key !== undefined && !tagged && globalKeys.indexOf(`${key}`) > -1) {
      tagged = true;
    }
    return node;
  };
  const leave = (node: unknown, key: string | number | undefined) => {
    if (tagged && globalKeys.indexOf(`${key}`) > -1) {
      tagged = false;
    }
    return node;
  };
  return objVisit(obj, {
    [OKind.ARRAY]: { enter, leave },
    [OKind.OBJECT]: { enter, leave },
    [OKind.FIELD]: {
      enter(node: unknown, key: string | number | undefined) {
        enter(node, key);
        if (tagged && typeof node === "string" && BASE64.test(node)) {
          const decoded = tryDecodeGlobalId(node);
          if (decoded !== null) {
            return decoded;
          }
        }
        return node;
      },
      leave,
    },
  }) as W;
}
