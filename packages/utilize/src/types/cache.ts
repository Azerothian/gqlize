/**
 * Read-cache store contract and cache configuration.
 */

import type { RequestContext } from "./primitives";

/**
 * Where the read cache keeps its entries. Two implementations ship:
 * `MemoryCacheStore` in ormize, and `IORedisCacheStore` in
 * `@azerothian/ormize-cache-ioredis`.
 *
 * Values are opaque strings. The cache serialises a result before calling
 * `set`, so a store never holds a live row and never has to know what one is.
 *
 * Invalidation works by generation, not by listing keys. Each tag (a model
 * name) has a counter, every key embeds the counters of the tags its read
 * touched, and `invalidate` increments them. An entry written before the
 * increment is never looked up again and ages out through the store's LRU or
 * TTL. Because of this, a write in one process invalidates reads another
 * process cached, and the store never tracks which keys belong to which model.
 */
export interface CacheStore {
  /** The current generation of each tag, in the order given. A tag that has never been invalidated is 0. */
  versions(tags: string[]): Promise<number[]>;
  get(key: string): Promise<string | undefined>;
  /** Keep `value` for `ttl` ms. The store may evict it sooner to stay within its size limits. */
  set(key: string, value: string, ttl: number): Promise<void>;
  invalidate(tags: string[]): Promise<void>;
  /** Drop every entry and every generation. */
  clear(): Promise<void>;
  /**
   * Optional: `versions` and `get` in one step, for a store where each call is a
   * network round trip. Reads the current generation of each tag, builds the
   * entry key from them, and returns that key with the entry's value, if any.
   *
   * The key has to be exactly what the cache builds without this method,
   * `cacheEntryKey(shape, versions)` from `@azerothian/utilize/utils/cache-key`.
   * The cache `set`s the result under the returned key, so a store whose key
   * disagrees would never hit.
   */
  lookup?(shape: string, tags: string[]): Promise<{key: string, value: string | undefined}>;
}

/** One read the cache is deciding about. Passed to {@link CacheOptions.exclude}. */
export type CacheRequest = {
  defName: string;
  operation: "findAll" | "count";
  context: RequestContext;
};

export type CacheOptions = {
  store: CacheStore;
  /** How long an entry lives, in ms. Default: 60 000. A definition's `cache.ttl` overrides it. */
  ttl?: number;
  /**
   * The largest serialised result that gets stored, in bytes. A larger one is
   * returned but not cached, so one huge page can't push everything else out of
   * the LRU. Default: 1 MiB. `0` means no limit.
   */
  maxEntrySize?: number;
  /**
   * Concurrent identical reads share one adapter call instead of all missing
   * at the same moment. Each caller still gets its own copy of the rows.
   * Default: `true`.
   */
  dedupe?: boolean;
  /**
   * Reads that are never cached: model names, or a predicate per read. A
   * definition can also opt itself out with `cache: false`.
   */
  exclude?: string[] | ((request: CacheRequest) => boolean);
  /**
   * What to do with a model that has its own find/count hooks (`beforeFind`,
   * `afterFind`, `beforeCount`, defined on the model or globally).
   *
   * Those hooks run inside the adapter call. On a hit they don't run, and their
   * output is what got stored. That is only safe when they behave the same for
   * every caller, and nothing here can check that. So `"bypass"`, the default,
   * leaves such a model uncached. `"cache"` caches it anyway. Use that when
   * the hooks don't depend on who is asking, or when `vary` covers whatever
   * they do depend on.
   */
  hooks?: "bypass" | "cache";
  /**
   * Partition entries by something about the caller that the query itself
   * doesn't show. The return value goes into the key, so it has to be
   * JSON-serialisable and stable. A row scope doesn't need this: it is merged
   * into the filter, and the filter is already part of the key.
   */
  vary?: (context: RequestContext) => unknown;
  /**
   * A failing store never fails a read. The read goes to the adapter, and the
   * error comes here. Default: `console.warn`.
   */
  onError?: (error: unknown) => void;
}
