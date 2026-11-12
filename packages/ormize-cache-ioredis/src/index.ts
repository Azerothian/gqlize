import { createHash } from "node:crypto";
import type { CacheStore } from "@azerothian/utilize/types/index";

/**
 * The commands this store uses, written out so a caller can pass any
 * ioredis-compatible client (ioredis, a Valkey fork of it, a test double)
 * without this package's types depending on ioredis.
 */
export interface CacheRedisClient {
  mget(...keys: string[]): Promise<(string | null)[]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  scan(cursor: string, match: "MATCH", pattern: string, count: "COUNT", n: number): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<unknown>;
}

/** What ioredis's own constructor takes: a URL or its options object. Passed through unread. */
export type CacheRedisConnection = string | { [option: string]: unknown };

export type IORedisCacheStoreOptions = {
  /**
   * Namespaces every key. It goes inside a hash tag (`{prefix}:…`), which keeps
   * the whole cache in one Redis Cluster slot. The scripts need that, because
   * they touch the LRU index and the entries together. Default: `"ormize-cache"`.
   */
  prefix?: string;
  /** The most entries kept before the least recently used is evicted. Default: 10 000. `0` means no limit. */
  maxEntries?: number;
  /** The most bytes kept (keys plus values) before the least recently used is evicted. Default: 256 MiB. `0` means no limit. */
  maxSize?: number;
};

// The LRU is a sorted set scored by a counter that lives in Redis. Every set and
// every hit takes the next number, so the lowest score is the least recently
// used entry. A counter rather than a timestamp keeps the order exact across
// processes whose clocks disagree, and between two touches in the same
// millisecond.
//
// Sizes live in a hash beside it, so evicting an entry can subtract what it
// added. An entry that expired by TTL leaves its index rows behind until a
// `get` misses on it or eviction reaches it. Either one settles the accounting,
// and in the meantime the totals overstate what is held, which only means
// something gets evicted early.
//
// KEYS: entry, lru, sizes, bytes, clock
const SET = `
local size = string.len(KEYS[1]) + string.len(ARGV[1])
local maxEntries = tonumber(ARGV[3])
local maxSize = tonumber(ARGV[4])
local old = redis.call('HGET', KEYS[3], KEYS[1])
if old then
  redis.call('DECRBY', KEYS[4], old)
  redis.call('HDEL', KEYS[3], KEYS[1])
  redis.call('ZREM', KEYS[2], KEYS[1])
end
if maxSize > 0 and size > maxSize then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('ZADD', KEYS[2], redis.call('INCR', KEYS[5]), KEYS[1])
redis.call('HSET', KEYS[3], KEYS[1], size)
local total = redis.call('INCRBY', KEYS[4], size)
local count = redis.call('ZCARD', KEYS[2])
while (maxEntries > 0 and count > maxEntries) or (maxSize > 0 and total > maxSize) do
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0)[1]
  if not oldest then break end
  redis.call('ZREM', KEYS[2], oldest)
  local s = redis.call('HGET', KEYS[3], oldest)
  if s then
    redis.call('HDEL', KEYS[3], oldest)
    total = redis.call('DECRBY', KEYS[4], s)
  end
  redis.call('DEL', oldest)
  count = count - 1
end
return 1
`;

// KEYS: entry, lru, sizes, bytes, clock
const GET = `
local v = redis.call('GET', KEYS[1])
if v then
  redis.call('ZADD', KEYS[2], 'XX', redis.call('INCR', KEYS[5]), KEYS[1])
  return v
end
local s = redis.call('HGET', KEYS[3], KEYS[1])
if s then
  redis.call('HDEL', KEYS[3], KEYS[1])
  redis.call('DECRBY', KEYS[4], s)
end
redis.call('ZREM', KEYS[2], KEYS[1])
return false
`;

// The generations and the entry in one round trip. Builds the entry key the way
// `cacheEntryKey` (utilize/utils/cache-key) does, `shape:v1.v2...`, from the
// generation counters, then does what GET does with it. The entry key is computed
// here rather than declared in KEYS, which is why every key shares the prefix's
// hash tag: it is in the same slot as the declared ones.
//
// KEYS: lru, sizes, bytes, clock, then one generation counter per tag
// ARGV: the entry key prefix, `{prefix}:e:<shape>:`
// Returns {suffix, value} on a hit, {suffix} on a miss.
const LOOKUP = `
local parts = {}
for i = 5, #KEYS do
  parts[#parts + 1] = tostring(tonumber(redis.call('GET', KEYS[i]) or '0'))
end
local suffix = table.concat(parts, '.')
local entry = ARGV[1] .. suffix
local v = redis.call('GET', entry)
if v then
  redis.call('ZADD', KEYS[1], 'XX', redis.call('INCR', KEYS[4]), entry)
  return {suffix, v}
end
local s = redis.call('HGET', KEYS[2], entry)
if s then
  redis.call('HDEL', KEYS[2], entry)
  redis.call('DECRBY', KEYS[3], s)
end
redis.call('ZREM', KEYS[1], entry)
return {suffix}
`;

// KEYS: one generation counter per tag
const INVALIDATE = `
for i = 1, #KEYS do
  redis.call('INCR', KEYS[i])
end
return #KEYS
`;

type Script = {source: string, sha: string};
const script = (source: string): Script => ({source, sha: createHash("sha1").update(source).digest("hex")});
const scripts = {set: script(SET), get: script(GET), lookup: script(LOOKUP), invalidate: script(INVALIDATE)};

function looksLikeClient(x: unknown): x is CacheRedisClient {
  const c = x as Partial<CacheRedisClient> | null | undefined;
  return !!c && typeof c.evalsha === "function" && typeof c.mget === "function";
}

/**
 * A {@link CacheStore} in Redis or Valkey, through ioredis. Every process that
 * points at the same server and prefix shares the entries and the
 * invalidations. A write in one process makes the cached reads of all of them
 * unreachable.
 *
 * Pass a client you already have, or a URL or ioredis options and the store
 * opens its own (and `quit` closes it). ioredis is loaded only in the second
 * case.
 */
export class IORedisCacheStore implements CacheStore {
  readonly client: CacheRedisClient;
  private ownsClient = false;
  private prefix: string;
  /** The LRU index, size hash, byte total and clock: KEYS 1-4 of the lookup script. */
  private index: string[];
  private maxEntries: number;
  private maxSize: number;

  constructor(clientOrConnection: CacheRedisClient | CacheRedisConnection, options: IORedisCacheStoreOptions = {}) {
    if (looksLikeClient(clientOrConnection)) {
      this.client = clientOrConnection;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a constructor cannot await an `import()`, and a caller injecting a client need not install ioredis
      const IORedis = require("ioredis");
      this.client = new (IORedis.default || IORedis)(clientOrConnection) as CacheRedisClient;
      this.ownsClient = true;
    }
    this.prefix = `{${options.prefix ?? "ormize-cache"}}`;
    this.index = ["lru", "sizes", "bytes", "clock"].map((name) => `${this.prefix}:${name}`);
    this.maxEntries = options.maxEntries ?? 10_000;
    this.maxSize = options.maxSize ?? 256 * 1024 * 1024;
  }

  versions = async(tags: string[]): Promise<number[]> => {
    if (tags.length === 0) {
      return [];
    }
    const values = await this.client.mget(...tags.map(this.versionKey));
    return values.map((v) => (v === null ? 0 : Number(v)));
  };

  /** `versions` and `get` in one round trip (see {@link CacheStore.lookup}). */
  lookup = async(shape: string, tags: string[]): Promise<{key: string, value: string | undefined}> => {
    const [suffix, value] = await this.run(scripts.lookup, [...this.index, ...tags.map(this.versionKey)], `${this.entryKey(shape)}:`) as [string, string?];
    return {key: `${shape}:${suffix}`, value: typeof value === "string" ? value : undefined};
  };

  get = async(key: string): Promise<string | undefined> => {
    const value = await this.run(scripts.get, this.indexKeys(key));
    return typeof value === "string" ? value : undefined;
  };

  set = async(key: string, value: string, ttl: number): Promise<void> => {
    await this.run(scripts.set, this.indexKeys(key), value, Math.max(1, Math.ceil(ttl)), this.maxEntries, this.maxSize);
  };

  invalidate = async(tags: string[]): Promise<void> => {
    if (tags.length > 0) {
      await this.run(scripts.invalidate, tags.map(this.versionKey));
    }
  };

  /**
   * Deletes everything under the prefix. It uses SCAN, so in a cluster it only
   * reaches the node this client is connected to. That is the node holding the
   * prefix's slot.
   */
  clear = async(): Promise<void> => {
    const pattern = `${this.prefix.replace(/[*?[\]\\]/g, "\\$&")}:*`;
    let cursor = "0";
    do {
      const [next, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 500);
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
      cursor = next;
    } while (cursor !== "0");
  };

  /** Close the connection, but only one this store opened itself. */
  quit = async(): Promise<void> => {
    if (this.ownsClient) {
      await this.client.quit();
    }
  };

  private versionKey = (tag: string) => `${this.prefix}:v:${tag}`;

  private entryKey = (key: string) => `${this.prefix}:e:${key}`;

  /** What the get and set scripts take: the entry, then the LRU index keys. */
  private indexKeys(key: string): string[] {
    return [this.entryKey(key), ...this.index];
  }

  /** EVALSHA, loading the script with EVAL the first time a server hasn't seen it. */
  private async run(s: Script, keys: string[], ...args: (string | number)[]): Promise<unknown> {
    try {
      return await this.client.evalsha(s.sha, keys.length, ...keys, ...args);
    } catch (e) {
      if (!String((e as Error)?.message).includes("NOSCRIPT")) {
        throw e;
      }
      return this.client.eval(s.source, keys.length, ...keys, ...args);
    }
  }
}

export default IORedisCacheStore;
