// Execution layer. Every adapter read/write goes through an `Executor`:
//   - DirectExecutor      → runs commands immediately against the client.
//   - ValkeyTransaction    → buffers writes in a per-transaction overlay (with
//                            read-your-writes), applied atomically via MULTI/EXEC
//                            on commit or discarded on rollback.
// The overlay is instanced per transaction — nothing is shared globally.

const TOMBSTONE = Symbol("tombstone");

function scoreArg(score: number): string {
  return score === Infinity ? "+inf" : String(score);
}

/** Parse an ioredis ZRANGE ... WITHSCORES flat reply into a member→score map. */
function parseWithScores(flat: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < flat.length; i += 2) {
    const s = flat[i + 1];
    m.set(flat[i], s === "inf" || s === "+inf" ? Infinity : parseFloat(s));
  }
  return m;
}

export interface Executor {
  readonly buffered: boolean;
  // reads
  getObj(key: string): Promise<string | null>;
  mgetObj(keys: string[]): Promise<(string | null)[]>;
  zMembers(zkey: string): Promise<Map<string, number>>;
  sMembers(key: string): Promise<string[]>;
  getStr(key: string): Promise<string | null>;
  pttl(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  // writes
  putObj(key: string, value: string, ttlMs?: number): void;
  delObj(key: string): void;
  zadd(zkey: string, score: number, member: string): void;
  zrem(zkey: string, member: string): void;
  sadd(key: string, ...members: string[]): void;
  srem(key: string, ...members: string[]): void;
  putStr(key: string, value: string, ttlMs?: number): void;
  delStr(key: string): void;
  pexpire(key: string, ttlMs: number): void;
  persist(key: string): void;
}

/** Immediate, non-transactional execution. Writes are fire-and-collect promises. */
export class DirectExecutor implements Executor {
  readonly buffered = false;
  private pending: Promise<any>[] = [];
  constructor(private client: any) {}

  private track(p: Promise<any>): void {
    this.pending.push(p);
  }
  /** Await all in-flight writes issued since the last flush. */
  async flush(): Promise<void> {
    const p = this.pending;
    this.pending = [];
    await Promise.all(p);
  }

  getObj(key: string) { return this.client.get(key); }
  mgetObj(keys: string[]) { return keys.length ? this.client.mget(...keys) : Promise.resolve([]); }
  async zMembers(zkey: string) { return parseWithScores(await this.client.zrange(zkey, 0, -1, "WITHSCORES")); }
  sMembers(key: string) { return this.client.smembers(key); }
  getStr(key: string) { return this.client.get(key); }
  pttl(key: string) { return this.client.pttl(key); }
  incr(key: string) { return this.client.incr(key); }

  putObj(key: string, value: string, ttlMs?: number) {
    this.track(ttlMs && ttlMs > 0 ? this.client.set(key, value, "PX", ttlMs) : this.client.set(key, value));
  }
  delObj(key: string) { this.track(this.client.del(key)); }
  zadd(zkey: string, score: number, member: string) { this.track(this.client.zadd(zkey, scoreArg(score), member)); }
  zrem(zkey: string, member: string) { this.track(this.client.zrem(zkey, member)); }
  sadd(key: string, ...members: string[]) { if (members.length) this.track(this.client.sadd(key, ...members)); }
  srem(key: string, ...members: string[]) { if (members.length) this.track(this.client.srem(key, ...members)); }
  putStr(key: string, value: string, ttlMs?: number) {
    this.track(ttlMs && ttlMs > 0 ? this.client.set(key, value, "PX", ttlMs) : this.client.set(key, value));
  }
  delStr(key: string) { this.track(this.client.del(key)); }
  pexpire(key: string, ttlMs: number) { this.track(this.client.pexpire(key, ttlMs)); }
  persist(key: string) { this.track(this.client.persist(key)); }
}

/**
 * A per-transaction overlay + `MULTI`/`EXEC` buffer. Reads merge the overlay over
 * the store (read-your-writes); writes are buffered and applied atomically on
 * `commit`, or dropped on `rollback` (nothing was ever written to Redis).
 * `incr` is the one exception — it executes immediately so ids are available
 * mid-transaction (a rolled-back counter, like a SQL sequence, is acceptable).
 */
export class ValkeyTransaction implements Executor {
  readonly buffered = true;
  private objects = new Map<string, string | typeof TOMBSTONE>();
  private strs = new Map<string, string | typeof TOMBSTONE>();
  private zAdds = new Map<string, Map<string, number>>();
  private zRems = new Map<string, Set<string>>();
  private sAdds = new Map<string, Set<string>>();
  private sRems = new Map<string, Set<string>>();
  private commands: any[][] = [];

  constructor(private client: any) {}

  // ---- reads (overlay over store) ----
  async getObj(key: string): Promise<string | null> {
    if (this.objects.has(key)) {
      const v = this.objects.get(key)!;
      return v === TOMBSTONE ? null : (v as string);
    }
    return this.client.get(key);
  }
  async mgetObj(keys: string[]): Promise<(string | null)[]> {
    const missing = keys.filter((k) => !this.objects.has(k));
    const fetched = missing.length ? await this.client.mget(...missing) : [];
    const byKey = new Map<string, string | null>();
    missing.forEach((k, i) => byKey.set(k, fetched[i]));
    return keys.map((k) => {
      if (this.objects.has(k)) {
        const v = this.objects.get(k)!;
        return v === TOMBSTONE ? null : (v as string);
      }
      return byKey.get(k) ?? null;
    });
  }
  async zMembers(zkey: string): Promise<Map<string, number>> {
    const base = parseWithScores(await this.client.zrange(zkey, 0, -1, "WITHSCORES"));
    for (const [m, s] of this.zAdds.get(zkey) || []) base.set(m, s);
    for (const m of this.zRems.get(zkey) || []) base.delete(m);
    return base;
  }
  async sMembers(key: string): Promise<string[]> {
    const base = new Set<string>(await this.client.smembers(key));
    for (const m of this.sAdds.get(key) || []) base.add(m);
    for (const m of this.sRems.get(key) || []) base.delete(m);
    return [...base];
  }
  async getStr(key: string): Promise<string | null> {
    if (this.strs.has(key)) {
      const v = this.strs.get(key)!;
      return v === TOMBSTONE ? null : (v as string);
    }
    return this.client.get(key);
  }
  pttl(key: string): Promise<number> { return this.client.pttl(key); }
  incr(key: string): Promise<number> { return this.client.incr(key); }

  // ---- writes (buffered) ----
  putObj(key: string, value: string, ttlMs?: number) {
    this.objects.set(key, value);
    this.commands.push(ttlMs && ttlMs > 0 ? ["set", key, value, "PX", ttlMs] : ["set", key, value]);
  }
  delObj(key: string) {
    this.objects.set(key, TOMBSTONE);
    this.commands.push(["del", key]);
  }
  zadd(zkey: string, score: number, member: string) {
    let a = this.zAdds.get(zkey); if (!a) { a = new Map(); this.zAdds.set(zkey, a); }
    a.set(member, score);
    this.zRems.get(zkey)?.delete(member);
    this.commands.push(["zadd", zkey, scoreArg(score), member]);
  }
  zrem(zkey: string, member: string) {
    let r = this.zRems.get(zkey); if (!r) { r = new Set(); this.zRems.set(zkey, r); }
    r.add(member);
    this.zAdds.get(zkey)?.delete(member);
    this.commands.push(["zrem", zkey, member]);
  }
  sadd(key: string, ...members: string[]) {
    if (!members.length) return;
    let a = this.sAdds.get(key); if (!a) { a = new Set(); this.sAdds.set(key, a); }
    members.forEach((m) => { a!.add(m); this.sRems.get(key)?.delete(m); });
    this.commands.push(["sadd", key, ...members]);
  }
  srem(key: string, ...members: string[]) {
    if (!members.length) return;
    let r = this.sRems.get(key); if (!r) { r = new Set(); this.sRems.set(key, r); }
    members.forEach((m) => { r!.add(m); this.sAdds.get(key)?.delete(m); });
    this.commands.push(["srem", key, ...members]);
  }
  putStr(key: string, value: string, ttlMs?: number) {
    this.strs.set(key, value);
    this.commands.push(ttlMs && ttlMs > 0 ? ["set", key, value, "PX", ttlMs] : ["set", key, value]);
  }
  delStr(key: string) {
    this.strs.set(key, TOMBSTONE);
    this.commands.push(["del", key]);
  }
  pexpire(key: string, ttlMs: number) { this.commands.push(["pexpire", key, ttlMs]); }
  persist(key: string) { this.commands.push(["persist", key]); }

  // ---- finalisation ----
  async commit(): Promise<void> {
    if (!this.commands.length) return;
    const multi = this.client.multi();
    for (const [method, ...args] of this.commands) {
      multi[method](...args);
    }
    this.commands = [];
    await multi.exec();
  }
  async rollback(): Promise<void> {
    // Nothing was written to Redis — just drop the overlay.
    this.objects.clear(); this.strs.clear();
    this.zAdds.clear(); this.zRems.clear();
    this.sAdds.clear(); this.sRems.clear();
    this.commands = [];
  }
}
