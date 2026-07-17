import { fromGlobalId } from "graphql-relay";

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function tryDecode(node: string): string | null {
  try {
    const { type, id } = fromGlobalId(node);
    if (type && id) return id;
  } catch { /* not a global id */ }
  return null;
}

function decodeLeaf(v: any): any {
  if (typeof v === "string" && B64.test(v)) {
    const d = tryDecode(v);
    return d !== null ? d : v;
  }
  return v;
}

function decodeDeep(v: any): any {
  if (Array.isArray(v)) return v.map(decodeDeep);
  if (v && typeof v === "object") {
    const o: any = {};
    for (const k of Object.keys(v)) o[k] = decodeDeep(v[k]);
    return o;
  }
  return decodeLeaf(v);
}

/**
 * Decode Relay global ids into raw ids anywhere they appear under a "global key"
 * field (primary/foreign key) in a where tree. Values that merely look like
 * base64 but don't decode to a `Type:id` are left untouched.
 */
export default function replaceIdDeep(obj: any, globalKeys: string[]): any {
  if (Array.isArray(obj)) return obj.map((o) => replaceIdDeep(o, globalKeys));
  if (obj && typeof obj === "object") {
    const out: any = {};
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (globalKeys.includes(k)) {
        out[k] = decodeDeep(v);
      } else if (v && typeof v === "object") {
        out[k] = replaceIdDeep(v, globalKeys);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return obj;
}
