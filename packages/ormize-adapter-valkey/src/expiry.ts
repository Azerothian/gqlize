import { Keys, KeyId } from "./keys";
import { ValkeyModel } from "./model";
import { Executor } from "./transaction";

/** Absolute expiry epoch-ms for a TTL, or +inf when there is no expiry. */
export function ttlToScore(ttlMs: number | null | undefined, now: number): number {
  return ttlMs && ttlMs > 0 ? now + ttlMs : Infinity;
}

/** Milliseconds until expiry (-1 = no expiry, -2 = missing) — mirrors PTTL. */
export function getExpiry(ex: Executor, keys: Keys, model: ValkeyModel, id: KeyId): Promise<number> {
  return ex.pttl(keys.obj(model.name, id));
}

/**
 * Set (ttlMs>0) or clear (null) an object's expiry AND cascade the new expiry
 * score into every mapping the object belongs to — the `ids` ZSET, each equality
 * index ZSET (via score), and each unique-key TTL. This keeps index reads
 * consistent with the object's lifetime.
 */
export async function setExpiry(
  ex: Executor,
  keys: Keys,
  model: ValkeyModel,
  id: KeyId,
  ttlMs: number | null,
): Promise<void> {
  const now = Date.now();
  const objKey = keys.obj(model.name, id);
  const sid = String(id);
  const score = ttlToScore(ttlMs, now);

  if (ttlMs && ttlMs > 0) {
    ex.pexpire(objKey, ttlMs);
  } else {
    ex.persist(objKey);
  }
  ex.zadd(keys.ids(model.name), score, sid);
  const members = await ex.sMembers(keys.membership(model.name, id));
  for (const k of members) {
    if (k.includes(":u:")) {
      if (ttlMs && ttlMs > 0) {
        ex.pexpire(k, ttlMs);
      } else {
        ex.persist(k);
      }
    } else {
      ex.zadd(k, score, sid);
    }
  }
}
