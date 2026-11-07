import { createHash } from "node:crypto";

/**
 * Keys on the options bag that say nothing about *which* rows a read returns,
 * left out of its fingerprint. `getGraphQLArgs` closes over the request, so
 * keeping it would make every key unique. `transaction` never gets this far,
 * because a read inside one is not cached (see `ReadCache.read`).
 */
const IGNORED_KEYS = new Set(["getGraphQLArgs", "logging", "benchmark", "transaction"]);

/** Thrown inside {@link fingerprint} for a value it can't describe faithfully. */
class Unfingerprintable extends Error {}

function isClass(fn: Function): boolean { // eslint-disable-line @typescript-eslint/no-unsafe-function-type -- any callable reaches here; only its source text is read
  return /^class[\s{]/.test(Function.prototype.toString.call(fn));
}

/**
 * A canonical string for an adapter-native options bag. Two bags that would run
 * the same query get the same string. Returns `undefined` when the bag holds
 * something that can't be described, and the read then goes uncached.
 *
 * It has to handle more than JSON can. Sequelize keys its operators by symbol
 * (`{[Op.in]: [...]}`), which `JSON.stringify` drops without a word, and that
 * would make `id in (1)` and `id in (2)` the same key. It puts `literal()`/`fn()`
 * objects in `attributes` and `order`, and model *classes* in `include`. Classes
 * are named. A plain function isn't: two closures with one name can filter
 * differently, so a bag holding one isn't cached at all.
 */
export function fingerprint(value: unknown): string | undefined {
  try {
    return canonical(value, new Set());
  } catch (e) {
    if (e instanceof Unfingerprintable) {
      return undefined;
    }
    throw e;
  }
}

function canonical(value: unknown, seen: Set<object>): string {
  switch (typeof value) {
    case "undefined":
      return "u";
    case "boolean":
    case "number":
      return String(value);
    case "bigint":
      return `n${value}`;
    case "string":
      return JSON.stringify(value);
    case "symbol":
      return `@${value.description ?? ""}`;
    case "function":
      if (isClass(value)) {
        return `class:${value.name}`;
      }
      throw new Unfingerprintable();
  }
  if (value === null) {
    return "null";
  }
  const obj = value as object;
  if (obj instanceof Date) {
    return `date:${obj.toISOString()}`;
  }
  if (obj instanceof Uint8Array) {
    return `bytes:${Buffer.from(obj).toString("hex")}`;
  }
  // A cycle means a live object graph (an association, a connection) rather
  // than a description of a query.
  if (seen.has(obj)) {
    throw new Unfingerprintable();
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((v) => canonical(v, seen)).join(",")}]`;
    }
    const record = obj as Record<string | symbol, unknown>;
    const parts = Object.keys(record).filter((k) => !IGNORED_KEYS.has(k) && record[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k], seen)}`);
    const symbols = Object.getOwnPropertySymbols(record)
      .map((s) => `@${s.description ?? ""}:${canonical(record[s], seen)}`).sort();
    // The constructor tells `literal("x")` apart from `col("x")`, which have the same fields.
    const proto = Object.getPrototypeOf(obj) as {constructor?: {name?: string}} | null;
    const tag = proto && proto !== Object.prototype ? proto.constructor?.name ?? "?" : "";
    return `${tag}{${[...parts, ...symbols].join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

export function hash(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}
