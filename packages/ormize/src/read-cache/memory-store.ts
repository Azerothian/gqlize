import type { CacheStore } from "@azerothian/utilize/types/index";

export type MemoryCacheStoreOptions = {
  /** The most entries kept before the least recently used is evicted. Default: 1000. `0` means no limit. */
  maxEntries?: number;
  /**
   * The most bytes kept (keys plus serialised values, as UTF-8) before the
   * least recently used is evicted. Default: 64 MiB. `0` means no limit.
   */
  maxSize?: number;
};

type Entry = {value: string, size: number, expires: number};

/**
 * An in-process LRU {@link CacheStore}. Every process has its own, so a write
 * only invalidates the cache of the process that made it. Use the ioredis
 * store when more than one process serves the same data.
 *
 * A `Map` iterates in insertion order, so the first key is always the least
 * recently used one, provided a hit deletes its entry and re-inserts it.
 */
export class MemoryCacheStore implements CacheStore {
  private entries = new Map<string, Entry>();
  private generations = new Map<string, number>();
  private bytes = 0;
  private maxEntries: number;
  private maxSize: number;

  constructor(options: MemoryCacheStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.maxSize = options.maxSize ?? 64 * 1024 * 1024;
  }

  /** How many entries are held, expired ones included until something touches them. */
  get size(): number {
    return this.entries.size;
  }

  /** How many bytes the held entries account for. */
  get byteSize(): number {
    return this.bytes;
  }

  versions = (tags: string[]): Promise<number[]> =>
    Promise.resolve(tags.map((tag) => this.generations.get(tag) ?? 0));

  get = (key: string): Promise<string | undefined> => {
    const entry = this.entries.get(key);
    if (!entry) {
      return Promise.resolve(undefined);
    }
    this.entries.delete(key);
    if (entry.expires <= Date.now()) {
      this.bytes -= entry.size;
      return Promise.resolve(undefined);
    }
    this.entries.set(key, entry);
    return Promise.resolve(entry.value);
  };

  set = (key: string, value: string, ttl: number): Promise<void> => {
    const size = Buffer.byteLength(key) + Buffer.byteLength(value);
    this.delete(key);
    // A value bigger than the whole budget would evict everything else and
    // then still not fit.
    if (this.maxSize > 0 && size > this.maxSize) {
      return Promise.resolve();
    }
    this.entries.set(key, {value, size, expires: Date.now() + ttl});
    this.bytes += size;
    for (const oldest of this.entries.keys()) {
      if ((this.maxEntries <= 0 || this.entries.size <= this.maxEntries) && (this.maxSize <= 0 || this.bytes <= this.maxSize)) {
        break;
      }
      this.delete(oldest);
    }
    return Promise.resolve();
  };

  invalidate = (tags: string[]): Promise<void> => {
    for (const tag of tags) {
      this.generations.set(tag, (this.generations.get(tag) ?? 0) + 1);
    }
    return Promise.resolve();
  };

  clear = (): Promise<void> => {
    this.entries.clear();
    this.generations.clear();
    this.bytes = 0;
    return Promise.resolve();
  };

  private delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.bytes -= entry.size;
    }
  }
}
