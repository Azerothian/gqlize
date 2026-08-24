import { Keys } from "./keys";
import { ValkeyModel } from "./model";
import { Executor } from "./transaction";
import { deserialize } from "./serialize";
import { removeFromIndexes } from "./indexes";


/**
 * Apply definition-level custom `whereOperators` then return the (still abstract)
 * where tree. Unlike a SQL adapter there is no operator-symbol translation — the
 * query executor interprets the string operators directly.
 */
export async function processFilterArgument(where: any, whereOperators: any, options: any): Promise<any> {
  if (!where || typeof where !== "object") {
    return where || {};
  }
  if (whereOperators && Object.keys(whereOperators).length) {
    let memo = { ...where };
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
function matchField(obj: any, field: string, cond: any): boolean {
  const value = obj[field];
  if (cond === null || typeof cond !== "object") {
    return value === cond;
  }
  return Object.keys(cond).every((op) => matchOp(value, op, cond[op]));
}

/** Does an object satisfy the whole where tree (used for in-memory refinement)? */
export function matchWhere(obj: any, where: any): boolean {
  if (!where || typeof where !== "object") {
    return true;
  }
  return Object.keys(where).every((key) => {
    const lk = key.toLowerCase();
    if (lk === "and") return (where[key] || []).every((w: any) => matchWhere(obj, w));
    if (lk === "or") return (where[key] || []).some((w: any) => matchWhere(obj, w));
    if (lk === "not") return !matchWhere(obj, where[key]);
    return matchField(obj, key, where[key]);
  });
}

// ---- index-only candidate resolution ----

type Resolved = { set: Set<string> | "ALL"; residual: any };

function scalarOf(cond: any): { eq?: any; in?: any[]; hasOther: boolean } {
  if (cond === null || typeof cond !== "object") {
    return { eq: cond, hasOther: false };
  }
  const keys = Object.keys(cond);
  const eq = "eq" in cond ? cond.eq : undefined;
  const inv = Array.isArray(cond.in) ? cond.in : undefined;
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

async function equalitySet(ex: Executor, keys: Keys, model: ValkeyModel, field: string, value: any, now: number): Promise<Set<string>> {
  if (field === model.primaryKey) {
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
async function resolveWhere(ex: Executor, keys: Keys, model: ValkeyModel, where: any, now: number): Promise<Resolved> {
  if (!where || Object.keys(where).length === 0) {
    return { set: "ALL", residual: {} };
  }
  const conjuncts: Set<string>[] = [];
  const residual: any = {};
  let hadIndexable = false;

  for (const key of Object.keys(where)) {
    const lk = key.toLowerCase();
    if (lk === "and") {
      for (const sub of where[key] || []) {
        const r = await resolveWhere(ex, keys, model, sub, now);
        if (r.set !== "ALL") { conjuncts.push(r.set); hadIndexable = true; }
        Object.assign(residual, r.residual);
      }
      continue;
    }
    if (lk === "or") {
      const branches: Set<string>[] = [];
      for (const sub of where[key] || []) {
        const r = await resolveWhere(ex, keys, model, sub, now);
        if (r.set === "ALL" || Object.keys(r.residual).length) {
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
      residual[key] = where[key];
      continue;
    }
    // Field condition.
    const { eq, in: inv, hasOther } = scalarOf(where[key]);
    if (model.isSearchable(key) && eq !== undefined) {
      conjuncts.push(await equalitySet(ex, keys, model, key, eq, now));
      hadIndexable = true;
      if (hasOther) residual[key] = where[key];
    } else if (model.isSearchable(key) && inv) {
      const union = new Set<string>();
      for (const v of inv) {
        (await equalitySet(ex, keys, model, key, v, now)).forEach((id) => union.add(id));
      }
      conjuncts.push(union);
      hadIndexable = true;
      if (hasOther) residual[key] = where[key];
    } else {
      residual[key] = where[key]; // non-indexed field / range operator → refine in memory
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
export async function executeQuery(ex: Executor, keys: Keys, model: ValkeyModel, where: any, now: number): Promise<any[]> {
  const resolved = await resolveWhere(ex, keys, model, where, now);
  const ids = resolved.set === "ALL"
    ? [...(await activeMembers(ex, keys, model, keys.ids(model.name), now))]
    : [...resolved.set];
  if (!ids.length) return [];

  const raw = await ex.mgetObj(ids.map((id) => keys.obj(model.name, id)));
  const out: any[] = [];
  const hasResidual = Object.keys(resolved.residual).length > 0;
  for (let i = 0; i < ids.length; i++) {
    if (raw[i] == null) continue; // expired / missing
    const obj = deserialize(model.fields, raw[i]);
    if (!hasResidual || matchWhere(obj, resolved.residual)) {
      out.push(obj);
    }
  }
  return out;
}
