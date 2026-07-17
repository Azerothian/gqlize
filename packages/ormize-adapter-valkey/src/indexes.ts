import { Keys } from "./keys";
import { ValkeyModel } from "./model";
import { Executor } from "./transaction";

export interface IndexPlan {
  /** Equality-index ZSET keys this object belongs to. */
  equality: string[];
  /** Unique-index string keys (for enforcement) + their field/value. */
  unique: { key: string; field: string; value: any }[];
}

/** The index/unique keys an object belongs to, given its current field values. */
export function planIndexes(keys: Keys, model: ValkeyModel, obj: any): IndexPlan {
  const equality: string[] = [];
  for (const field of model.indexes) {
    if (field in obj) {
      equality.push(keys.index(model.name, field, obj[field]));
    }
  }
  const unique: IndexPlan["unique"] = [];
  for (const field of model.uniques) {
    if (field in obj) {
      unique.push({ key: keys.unique(model.name, field, obj[field]), field, value: obj[field] });
    }
  }
  return { equality, unique };
}

/** Add an id to `ids`, every equality index, and reserve its unique keys. */
export function addToIndexes(
  ex: Executor,
  keys: Keys,
  model: ValkeyModel,
  id: any,
  plan: IndexPlan,
  score: number,
  ttlMs?: number,
): void {
  const sid = String(id);
  ex.zadd(keys.ids(model.name), score, sid);
  const membership: string[] = [];
  for (const k of plan.equality) {
    ex.zadd(k, score, sid);
    membership.push(k);
  }
  for (const u of plan.unique) {
    ex.putStr(u.key, sid, ttlMs);
    membership.push(u.key);
  }
  if (membership.length) {
    ex.sadd(keys.membership(model.name, id), ...membership);
  }
}

/** Remove an id from every index/unique/membership structure it belongs to. */
export async function removeFromIndexes(ex: Executor, keys: Keys, model: ValkeyModel, id: any): Promise<void> {
  const sid = String(id);
  const mKey = keys.membership(model.name, id);
  const members = await ex.sMembers(mKey);
  for (const k of members) {
    if (k.includes(":u:")) {
      ex.delStr(k);
    } else {
      ex.zrem(k, sid);
    }
  }
  ex.zrem(keys.ids(model.name), sid);
  ex.delStr(mKey);
}

/** Re-index after an update: diff old vs new index membership + refresh scores. */
export function reindex(
  ex: Executor,
  keys: Keys,
  model: ValkeyModel,
  id: any,
  oldObj: any,
  newObj: any,
  score: number,
  ttlMs?: number,
): void {
  const sid = String(id);
  const before = planIndexes(keys, model, oldObj);
  const after = planIndexes(keys, model, newObj);
  const beforeEq = new Set(before.equality);
  const afterEq = new Set(after.equality);
  const beforeUq = new Map(before.unique.map((u) => [u.key, u]));
  const afterUq = new Map(after.unique.map((u) => [u.key, u]));

  const added: string[] = [];
  const removed: string[] = [];
  for (const k of afterEq) {
    if (!beforeEq.has(k)) { ex.zadd(k, score, sid); added.push(k); } else { ex.zadd(k, score, sid); /* refresh score */ }
  }
  for (const k of beforeEq) {
    if (!afterEq.has(k)) { ex.zrem(k, sid); removed.push(k); }
  }
  for (const [k, u] of afterUq) {
    if (!beforeUq.has(k)) { ex.putStr(u.key, sid, ttlMs); added.push(k); }
  }
  for (const [k] of beforeUq) {
    if (!afterUq.has(k)) { ex.delStr(k); removed.push(k); }
  }
  ex.zadd(keys.ids(model.name), score, sid); // refresh expiry score
  if (added.length) ex.sadd(keys.membership(model.name, id), ...added);
  if (removed.length) ex.srem(keys.membership(model.name, id), ...removed);
}
