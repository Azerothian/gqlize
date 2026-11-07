import type { AdapterQueryOptions, CacheOptions, CacheRequest, CacheStore } from "@azerothian/utilize/types/index";
import { getStore } from "../context";
import { cacheEntryKey } from "@azerothian/utilize/utils/cache-key";
import { fingerprint, hash } from "./fingerprint";

export { MemoryCacheStore } from "./memory-store";
export type { MemoryCacheStoreOptions } from "./memory-store";

const DEFAULT_TTL = 60_000;
const DEFAULT_MAX_ENTRY_SIZE = 1024 * 1024;

/** How a result becomes the string a store holds, and back. `decode` must build fresh objects every call. */
export type ResultCodec<T> = {encode: (value: T) => string, decode: (text: string) => T};

export type CachedRead = CacheRequest & {
  options: AdapterQueryOptions;
  /** Every model the read touched. A write to any of them invalidates it. */
  tags: string[];
  /** The definition's own `cache.ttl`, if it has one. */
  ttl?: number;
};

/** What the cache asks the engine about a model before it touches the store. */
export type ReadCacheHost = {
  /** `false` when the definition opted out, the definition's settings when it opted in explicitly. */
  definitionCache(defName: string): false | {ttl?: number} | undefined;
  /** Whether hooks this cache can't see run inside the adapter call for this read. */
  hasOpaqueHooks(defName: string, operation: CacheRequest["operation"]): boolean;
};

/** One adapter call in progress, and how many identical reads are waiting on it. */
type Flight<T> = {followers: number, result: Promise<{value: T, encoded: string | undefined}>};

/** How many too-big results to remember (see `oversized`). */
const OVERSIZED_MEMORY = 1000;

/**
 * A read-through cache in front of an adapter's `findAll` and `count`.
 *
 * The key is everything that decides which rows come back: the model, the
 * operation, the adapter-native options after every scope, `before` hook and
 * exposed-method `input` has been applied, and `vary(context)`. On top of that
 * come the current generation of every model the read touched, so a write to
 * any of them makes the key unreachable (see {@link CacheStore}).
 *
 * A read the cache can't make safe goes straight to the adapter and nothing is
 * stored. That covers a read inside a transaction (it may see writes nobody
 * else can yet), an excluded model, a model with hooks the cache can't account
 * for, and an options bag it can't fingerprint.
 */
export default class ReadCache {
  private store: CacheStore;
  private dedupe: boolean;
  private inflight = new Map<string, Flight<unknown>>();
  /**
   * Reads whose last result was over `maxEntrySize`, keyed by shape (the key
   * without generations, so a write doesn't make the cache forget), with when
   * to try again. Encoding is the expensive half of a miss, and without this a
   * page that never fits paid for it on every request and stored nothing.
   */
  private oversized = new Map<string, number>();

  constructor(private options: CacheOptions, private host: ReadCacheHost) {
    this.store = options.store;
    this.dedupe = options.dedupe !== false;
  }

  read = async <T>(request: CachedRead, fetch: () => Promise<T>, codec: ResultCodec<T>): Promise<T> => {
    const shaped = this.shapeOf(request);
    const found = shaped && await this.find(shaped.shape, shaped.tags);
    if (!shaped || !found) {
      return fetch();
    }
    const {shape} = shaped;
    const {key, value: hit} = found;
    if (hit !== undefined) {
      try {
        return codec.decode(hit);
      } catch (e) {
        // A corrupt entry is a miss, and the fresh result below overwrites it.
        this.reportError(e);
      }
    }
    const joined = this.dedupe ? this.inflight.get(key) as Flight<T> | undefined : undefined;
    if (joined) {
      joined.followers++;
      const {encoded} = await joined.result;
      // The leader's rows are the leader's, so a follower decodes its own copy.
      // An unencodable result has no copy to give, and the follower fetches.
      return encoded === undefined ? fetch() : codec.decode(encoded);
    }
    const ttl = request.ttl ?? this.options.ttl ?? DEFAULT_TTL;
    const skipEncode = (this.oversized.get(shape) ?? 0) > Date.now();
    const flight: Flight<T> = {followers: 0, result: Promise.resolve(undefined as never)};
    flight.result = (async() => {
      const value = await fetch();
      // A result known not to fit is only encoded when a follower needs a copy.
      // Followers join before the fetch settles, so the count is final here.
      if (skipEncode && flight.followers === 0) {
        return {value, encoded: undefined};
      }
      try {
        return {value, encoded: codec.encode(value)};
      } catch (e) {
        this.reportError(e);
        return {value, encoded: undefined};
      }
    })();
    if (this.dedupe) {
      this.inflight.set(key, flight);
    }
    try {
      const {value, encoded} = await flight.result;
      if (encoded !== undefined) {
        if (this.fits(encoded)) {
          this.oversized.delete(shape);
          await this.store.set(key, encoded, ttl).catch(this.reportError);
        } else {
          this.rememberOversized(shape, ttl);
        }
      }
      return value;
    } finally {
      this.inflight.delete(key);
    }
  };

  /**
   * Make every cached read of `tags` unreachable now and, when the write is part
   * of a transaction, again once it commits.
   *
   * The second bump is needed. Between the write and the commit, a read outside
   * the transaction still sees the old rows and caches them under the new
   * generation. Only a bump after the commit gets rid of that entry.
   */
  invalidate = async(tags: string[], transaction?: unknown): Promise<void> => {
    if (tags.length === 0) {
      return;
    }
    const bump = () => this.store.invalidate(tags).catch(this.reportError);
    await bump();
    const coordinator = getStore()?.transaction;
    if (coordinator) {
      coordinator.afterCommit(bump);
    } else if (typeof (transaction as {afterCommit?: unknown} | undefined)?.afterCommit === "function") {
      // A transaction the caller opened themselves (e.g. a Sequelize one passed in
      // `context.transaction`), which has no coordinator to report its commit.
      (transaction as {afterCommit: (fn: () => unknown) => void}).afterCommit(bump);
    }
  };

  clear = (): Promise<void> => this.store.clear();

  /**
   * The read without its generations: everything that decides its result, and
   * the tags whose generations complete the key. `undefined` when the read
   * can't be cached at all.
   */
  private shapeOf = (request: CachedRead): {shape: string, tags: string[]} | undefined => {
    const {defName, operation, context, options} = request;
    if (options.transaction || getStore()?.transaction) {
      return undefined;
    }
    const own = this.host.definitionCache(defName);
    if (own === false || this.excluded(request)) {
      return undefined;
    }
    if (own === undefined && this.options.hooks !== "cache" && this.host.hasOpaqueHooks(defName, operation)) {
      return undefined;
    }
    const described = fingerprint(options);
    if (described === undefined) {
      return undefined;
    }
    let vary = "";
    if (this.options.vary) {
      try {
        // `null` rather than `""` for an undefined result, so a caller `vary`
        // can't place (an anonymous request, say) never shares the key of a
        // cache configured without `vary` at all.
        vary = `v:${JSON.stringify(this.options.vary(context) ?? null)}`;
      } catch (e) {
        // Like every other failure here: the read goes to the adapter, uncached.
        this.reportError(e);
        return undefined;
      }
    }
    return {
      shape: `${defName}:${operation}:${hash(`${described}|${vary}`)}`,
      tags: [...new Set(request.tags)].sort(),
    };
  };

  /**
   * The entry key under the current generations, and the entry if there is one.
   * One call to a store with `lookup`, otherwise `versions` then `get`.
   * `undefined` when the generations can't be read: without them a hit can't
   * be told from a stale entry, so the read goes uncached.
   */
  private find = async(shape: string, tags: string[]): Promise<{key: string, value: string | undefined} | undefined> => {
    if (this.store.lookup) {
      try {
        return await this.store.lookup(shape, tags);
      } catch (e) {
        this.reportError(e);
        return undefined;
      }
    }
    let key: string;
    try {
      key = cacheEntryKey(shape, await this.store.versions(tags));
    } catch (e) {
      this.reportError(e);
      return undefined;
    }
    try {
      return {key, value: await this.store.get(key)};
    } catch (e) {
      // An unreadable entry is a miss; the key is still good for storing a fresh one.
      this.reportError(e);
      return {key, value: undefined};
    }
  };

  /** Try storing it again after `ttl`: the result may have shrunk by then. */
  private rememberOversized(shape: string, ttl: number) {
    this.oversized.delete(shape);
    this.oversized.set(shape, Date.now() + ttl);
    if (this.oversized.size > OVERSIZED_MEMORY) {
      this.oversized.delete(this.oversized.keys().next().value as string);
    }
  }

  private excluded(request: CachedRead): boolean {
    const {exclude} = this.options;
    if (!exclude) {
      return false;
    }
    if (Array.isArray(exclude)) {
      return exclude.includes(request.defName);
    }
    return exclude({defName: request.defName, operation: request.operation, context: request.context});
  }

  private fits(encoded: string): boolean {
    const max = this.options.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE;
    return max <= 0 || Buffer.byteLength(encoded) <= max;
  }

  private reportError = (e: unknown) => {
    if (this.options.onError) {
      this.options.onError(e);
    } else {
      console.warn("ormize read cache:", e); // eslint-disable-line no-console
    }
  };
}

