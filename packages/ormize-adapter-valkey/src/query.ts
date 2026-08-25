import { Keys } from "./keys";
import { ValkeyModel } from "./model";
import { Executor } from "./transaction";
import { deserialize } from "./serialize";
import { removeFromIndexes } from "./indexes";
import type { AdapterQueryOptions, AdapterWhere, WhereOperators } from "@azerothian/utilize/types/index";
import type { ValkeyRow } from "./index";

/**
 * Apply definition-level custom `whereOperators` then return the (still abstract)
 * where tree. Unlike a SQL adapter there is no operator-symbol translation — the
 * query executor interprets the string operators directly.
 */
export async function processFilterArgument(
  where: AdapterWhere | undefined,
  whereOperators: WhereOperators | undefined,
  options: AdapterQueryOptions,
): Promise<AdapterWhere> {
  if (!where || typeof where !== "object") {
    return where || {};
  }
  if (whereOperators && Object.keys(whereOperators).length) {
    let memo: AdapterWhere = { ...where };
    for (const key of Object.keys(where)) {
      const op = whereOperators[key];
      if (typeof op === "function") {
        const fragment = await op(memo, options, where[key]);
        delete memo[key];
        memo = { ...memo, ...(fragment || {}) };
      }
    }
    return memo;
  }
  return where;
}

// ---- in-memory predicate matching (for non-indexed refinement) ----

function likeToRegExp(pattern: string, flags: string): RegExp {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, flags);
}

/**
 * Compares a stored field value against a filter operator's target. Both sides
 * are genuinely arbitrary (whatever a field holds vs. whatever a caller filtered
 * by) and the relational operators (`gt`/`gte`/`lt`/`lte`) require operands
 * TypeScript will accept comparisons on — `unknown` rejects `<`/`>`/etc.
 * entirely, so there is no narrower type that still supports every branch here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc comment above; unknown cannot support the relational operators below
function matchOp(value: any, op: string, target: any): boolean {
  switch (op) {
    case "eq": return value === target;
    case "ne": case "not": return value !== target;
    case "gt": return value > target;
    case "gte": return value >= target;
    case "lt": return value < target;
    case "lte": return value <= target;
    case "in": return Array.isArray(target) && target.includes(value);
    case "notIn": return Array.isArray(target) && !target.includes(value);
    case "is": return value === target; // typically null
    case "like": return likeToRegExp(target, "").test(String(value));
    case "iLike": return likeToRegExp(target, "i").test(String(value));
    case "notLike": return !likeToRegExp(target, "").test(String(value));
    case "startsWith": return String(value).startsWith(String(target));
    case "endsWith": return String(value).endsWith(String(target));
    case "substring": return String(value).includes(String(target));
    default: return false;
  }
}

/** Does an object satisfy a single field condition (scalar eq or ops object)? */
function matchField(obj: ValkeyRow, field: string, cond: unknown): boolean {
  const value = obj[field];
  if (cond === null || typeof cond !== "object") {
    return value === cond;
  }
  // An ops object (`{gt: 5}`) is itself a where-fragment keyed by operator name.
  const condObj = cond as AdapterWhere;
  return Object.keys(condObj).every((op) => matchOp(value, op, condObj[op]));
}

/** Does an object satisfy the whole where tree (used for in-memory refinement)? */
export function matchWhere(obj: ValkeyRow, where: AdapterWhere | undefined): boolean {
  if (!where || typeof where !== "object") {
    return true;
  }
  return Object.keys(where).every((key) => {
    const lk = key.toLowerCase();
    if (lk === "and") return ((where[key] || []) as AdapterWhere[]).every((w) => matchWhere(obj, w));
    if (lk === "or") return ((where[key] || []) as AdapterWhere[]).some((w) => matchWhere(obj, w));
    if (lk === "not") return !matchWhere(obj, where[key]);
    return matchField(obj, key, where[key]);
  });
}

// ---- index-only candidate resolution ----

/**
 * `residual` is a **list** of independent clauses, all of which must hold (AND).
 * It must not be collapsed into a single object: two AND-ed branches can constrain
 * the same non-indexed field, and merging them would silently drop all but the last.
 */
type Resolved = { set: Set<string> | "ALL"; residual: AdapterWhere[] };

function scalarOf(cond: unknown): { eq?: unknown; in?: unknown[]; hasOther: boolean } {
  if (cond === null || typeof cond !== "object") {
    return { eq: cond, hasOther: false };
  }
  const condObj = cond as AdapterWhere;
  const keys = Object.keys(condObj);
  const eq = "eq" in condObj ? condObj.eq : undefined;
  const inv = Array.isArray(condObj.in) ? condObj.in : undefined;
  const hasOther = keys.some((k) => k !== "eq" && k !== "in");
  return { eq, in: inv, hasOther };
}

async function activeMembers(ex: Executor, keys: Keys, model: ValkeyModel, zkey: string, now: number): Promise<Set<string>> {
  const members = await ex.zMembers(zkey);
  const alive = new Set<string>();
  const expired: string[] = [];
  for (const [id, score] of members) {
    if (score > now) alive.add(id);
    else expired.push(id);
  }
  // Lazy GC of expired ids — only outside a transaction so we don't taint its buffer.
  if (expired.length && !ex.buffered) {
    for (const id of expired) {
      await removeFromIndexes(ex, keys, model, id);
      ex.delObj(keys.obj(model.name, id));
    }
  }
  return alive;
}

async function equalitySet(ex: Executor, keys: Keys, model: ValkeyModel, field: string, value: unknown, now: number): Promise<Set<string>> {
  if (field === model.primaryKey) {
    // A primary-key value is always a `KeyId` (string/number/bigint) by
    // construction — see `keys.ts`. A cast would be flagged as unnecessary
    // (`String`'s parameter is `any`), so the invariant is documented instead.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- see comment above
    return new Set([String(value)]); // direct lookup; existence verified at fetch
  }
  if (model.uniques.has(field)) {
    const id = await ex.getStr(keys.unique(model.name, field, value));
    return new Set(id ? [id] : []);
  }
  return activeMembers(ex, keys, model, keys.index(model.name, field, value), now);
}

function intersect(sets: Set<string>[]): Set<string> {
  if (!sets.length) return new Set();
  sets.sort((a, b) => a.size - b.size);
  const [first, ...rest] = sets;
  const out = new Set<string>();
  for (const id of first) {
    if (rest.every((s) => s.has(id))) out.add(id);
  }
  return out;
}

/** Resolve a where tree to a candidate id-set using ONLY indexes (never a scan). */
async function resolveWhere(ex: Executor, keys: Keys, model: ValkeyModel, where: AdapterWhere | undefined, now: number): Promise<Resolved> {
  if (!where || Object.keys(where).length === 0) {
    return { set: "ALL", residual: [] };
  }
  const conjuncts: Set<string>[] = [];
  const residual: AdapterWhere[] = [];
  let hadIndexable = false;

  for (const key of Object.keys(where)) {
    const lk = key.toLowerCase();
    if (lk === "and") {
      for (const sub of where[key] || []) {
        const r = await resolveWhere(ex, keys, model, sub, now);
        if (r.set !== "ALL") { conjuncts.push(r.set); hadIndexable = true; }
        residual.push(...r.residual);
      }
      continue;
    }
    if (lk === "or") {
      const branches: Set<string>[] = [];
      for (const sub of where[key] || []) {
        const r = await resolveWhere(ex, keys, model, sub, now);
        if (r.set === "ALL" || r.residual.length) {
          throw new Error("Valkey adapter: every branch of an `or` must be fully index-resolvable");
        }
        branches.push(r.set);
      }
      const union = new Set<string>();
      branches.forEach((s) => s.forEach((id) => union.add(id)));
      conjuncts.push(union);
      hadIndexable = true;
      continue;
    }
    if (lk === "not") {
      residual.push({ [key]: where[key] });
      continue;
    }
    // Field condition.
    const { eq, in: inv, hasOther } = scalarOf(where[key]);
    if (model.isSearchable(key) && eq !== undefined) {
      conjuncts.push(await equalitySet(ex, keys, model, key, eq, now));
      hadIndexable = true;
      if (hasOther) residual.push({ [key]: where[key] });
    } else if (model.isSearchable(key) && inv) {
      const union = new Set<string>();
      for (const v of inv) {
        (await equalitySet(ex, keys, model, key, v, now)).forEach((id) => union.add(id));
      }
      conjuncts.push(union);
      hadIndexable = true;
      if (hasOther) residual.push({ [key]: where[key] });
    } else {
      residual.push({ [key]: where[key] }); // non-indexed field / range operator → refine in memory
    }
  }

  if (!hadIndexable) {
    throw new Error(
      "Valkey adapter: a `where` must reference at least one indexed field (no keyspace scans). " +
      `Fields queried: ${Object.keys(where).join(", ")}`,
    );
  }
  return { set: intersect(conjuncts), residual };
}

/**
 * Execute an index-only query and return the matching **deserialized objects**
 * (unordered, unpaginated — the adapter applies order/offset/limit). An empty
 * where lists all live ids via the `ids` ZSET.
 */
export async function executeQuery(ex: Executor, keys: Keys, model: ValkeyModel, where: AdapterWhere, now: number): Promise<ValkeyRow[]> {
  const resolved = await resolveWhere(ex, keys, model, where, now);
  const ids = resolved.set === "ALL"
    ? [...(await activeMembers(ex, keys, model, keys.ids(model.name), now))]
    : [...resolved.set];
  if (!ids.length) return [];

  const raw = await ex.mgetObj(ids.map((id) => keys.obj(model.name, id)));
  const out: ValkeyRow[] = [];
  for (let i = 0; i < ids.length; i++) {
    const json = raw[i];
    if (json == null) continue; // expired / missing
    const obj = deserialize(model.fields, json);
    if (resolved.residual.every((clause) => matchWhere(obj, clause))) {
      out.push(obj);
    }
  }
  return out;
}
