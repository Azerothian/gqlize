import {describe, it, expect, jest} from "@jest/globals";
import {Op, literal, col} from "sequelize";
import {MemoryCacheStore} from "../src";
import ReadCache from "../src/read-cache";
import {encode, decode} from "../src/read-cache/codec";
import {fingerprint} from "../src/read-cache/fingerprint";
import OrmizeTransaction from "../src/transaction";
import {cacheEntryKey} from "@azerothian/utilize/utils/cache-key";
import type Ormize from "../src/manager";

describe("MemoryCacheStore", () => {
  it("evicts the least recently used entry past maxEntries", async() => {
    const store = new MemoryCacheStore({maxEntries: 2});
    await store.set("a", "1", 1000);
    await store.set("b", "2", 1000);
    await store.get("a"); // `b` is now the oldest
    await store.set("c", "3", 1000);
    expect(await store.get("a")).toBe("1");
    expect(await store.get("b")).toBeUndefined();
    expect(await store.get("c")).toBe("3");
    expect(store.size).toBe(2);
  });

  it("evicts by bytes past maxSize, and refuses an entry bigger than the budget", async() => {
    const store = new MemoryCacheStore({maxSize: 10});
    await store.set("a", "1234", 1000); // 5 bytes
    await store.set("b", "1234", 1000); // 10 in total
    await store.set("c", "12", 1000); // 13, so `a` goes
    expect(await store.get("a")).toBeUndefined();
    expect(store.byteSize).toBe(8);
    await store.set("d", "x".repeat(20), 1000);
    expect(await store.get("d")).toBeUndefined();
    expect(await store.get("b")).toBe("1234");
  });

  it("replaces an entry without double-counting it", async() => {
    const store = new MemoryCacheStore();
    await store.set("a", "1234", 1000);
    await store.set("a", "12", 1000);
    expect(store.byteSize).toBe(3);
    expect(store.size).toBe(1);
  });

  it("expires entries by ttl", async() => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const store = new MemoryCacheStore();
      await store.set("a", "1", 50);
      now.mockReturnValue(1049);
      expect(await store.get("a")).toBe("1");
      now.mockReturnValue(1050);
      expect(await store.get("a")).toBeUndefined();
      expect(store.byteSize).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it("counts generations per tag", async() => {
    const store = new MemoryCacheStore();
    expect(await store.versions(["A", "B"])).toEqual([0, 0]);
    await store.invalidate(["A"]);
    await store.invalidate(["A", "B"]);
    expect(await store.versions(["B", "A"])).toEqual([1, 2]);
    await store.clear();
    expect(await store.versions(["A"])).toEqual([0]);
  });
});

describe("read cache codec", () => {
  it("round-trips the column types JSON loses", () => {
    const value = {
      at: new Date("2020-01-02T03:04:05.006Z"),
      bad: new Date(NaN),
      blob: Buffer.from([0, 1, 255]),
      big: 12345678901234567890n,
      nested: [{at: new Date(0)}],
      json: {plain: true, n: null},
    };
    const back = decode(encode(value)) as typeof value;
    expect(back.at).toEqual(value.at);
    expect(back.at).toBeInstanceOf(Date);
    expect(Number.isNaN(back.bad.getTime())).toBe(true);
    expect(Buffer.isBuffer(back.blob)).toBe(true);
    expect([...back.blob]).toEqual([0, 1, 255]);
    expect(back.big).toBe(value.big);
    expect(back.nested[0].at).toEqual(new Date(0));
    expect(back.json).toEqual(value.json);
  });

  it("encodes exactly as JSON.stringify would, toJSON included", () => {
    const decimal = {toJSON: () => "12.50"};
    const value = {price: decimal, nested: {list: [1, "a", null, true]}, gone: undefined, fn: () => 1};
    expect(encode(value)).toBe(JSON.stringify(value));
  });
});

describe("read cache fingerprint", () => {
  it("tells apart filters that differ only under a symbol key", () => {
    expect(fingerprint({where: {id: {[Op.in]: [1]}}})).not.toBe(fingerprint({where: {id: {[Op.in]: [2]}}}));
    expect(fingerprint({where: {id: {[Op.in]: [1]}}})).not.toBe(fingerprint({where: {id: {[Op.notIn]: [1]}}}));
  });

  it("ignores key order and per-request keys", () => {
    const a = fingerprint({limit: 1, where: {a: 1, b: 2}, getGraphQLArgs: () => ({}), logging: false});
    const b = fingerprint({where: {b: 2, a: 1}, limit: 1});
    expect(a).toBe(b);
  });

  it("tells apart Sequelize helpers with the same fields", () => {
    expect(fingerprint({order: [literal("name")]})).not.toBe(fingerprint({order: [col("name")]}));
  });

  it("names a class but refuses a closure", () => {
    class Task {}
    expect(fingerprint({include: [{model: Task}]})).toContain("class:Task");
    expect(fingerprint({where: {id: () => 1}})).toBeUndefined();
  });

  it("refuses a cycle but accepts a shared reference", () => {
    const shared = {a: 1};
    expect(fingerprint({x: shared, y: shared})).toBeDefined();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(fingerprint({include: cyclic})).toBeUndefined();
  });
});

describe("ReadCache", () => {
  const host = {definitionCache: () => undefined, hasOpaqueHooks: () => false};
  const codec = {encode: (v: {n: number}) => JSON.stringify(v), decode: (t: string) => JSON.parse(t) as {n: number}};
  const request = (options: object = {}) => ({defName: "A", operation: "findAll" as const, context: {}, options, tags: ["A", "B"]});

  it("gives each caller its own copy, the leader included", async() => {
    const cache = new ReadCache({store: new MemoryCacheStore()}, host);
    const fetch = jest.fn(() => Promise.resolve({n: 1}));
    const [a, b] = await Promise.all([cache.read(request(), fetch, codec), cache.read(request(), fetch, codec)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    const c = await cache.read(request(), fetch, codec);
    expect(c).toEqual(a);
    expect(c).not.toBe(a);
  });

  it("propagates the leader's error to the followers and caches nothing", async() => {
    const store = new MemoryCacheStore();
    const cache = new ReadCache({store}, host);
    const fetch = jest.fn(() => Promise.reject(new Error("boom")));
    const results = await Promise.allSettled([cache.read(request(), fetch, codec), cache.read(request(), fetch, codec)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it("misses after any tag the read touched is invalidated", async() => {
    const cache = new ReadCache({store: new MemoryCacheStore()}, host);
    const fetch = jest.fn(() => Promise.resolve({n: 1}));
    await cache.read(request(), fetch, codec);
    await cache.invalidate(["C"]);
    await cache.read(request(), fetch, codec);
    expect(fetch).toHaveBeenCalledTimes(1);
    await cache.invalidate(["B"]);
    await cache.read(request(), fetch, codec);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses a definition's ttl over the cache-wide one", async() => {
    const store = new MemoryCacheStore();
    const set = jest.spyOn(store, "set");
    const cache = new ReadCache({store, ttl: 5000}, host);
    await cache.read(request(), () => Promise.resolve({n: 1}), codec);
    await cache.read({...request({x: 1}), ttl: 10}, () => Promise.resolve({n: 1}), codec);
    expect(set.mock.calls.map((c) => c[2])).toEqual([5000, 10]);
  });

  it("stops encoding a read whose result never fits, until its ttl passes", async() => {
    const store = new MemoryCacheStore();
    const cache = new ReadCache({store, maxEntrySize: 5, ttl: 1000}, host);
    const encode = jest.fn(codec.encode);
    const counting = {...codec, encode};
    const big = () => Promise.resolve({n: 123456789});
    await cache.read(request(), big, counting);
    await cache.read(request(), big, counting);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
    // A write changes the key but not the shape: still known not to fit.
    await cache.invalidate(["A"]);
    await cache.read(request(), big, counting);
    expect(encode).toHaveBeenCalledTimes(1);
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 1001);
    try {
      await cache.read(request(), big, counting);
      expect(encode).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("still gives a follower its own copy of a result known not to fit", async() => {
    const cache = new ReadCache({store: new MemoryCacheStore(), maxEntrySize: 5}, host);
    await cache.read(request(), () => Promise.resolve({n: 123456789}), codec);
    const fetch = jest.fn(() => Promise.resolve({n: 123456789}));
    const [a, b] = await Promise.all([cache.read(request(), fetch, codec), cache.read(request(), fetch, codec)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("uses a store's single-call lookup instead of versions and get", async() => {
    const inner = new MemoryCacheStore();
    const lookup = jest.fn(async(shape: string, tags: string[]) => {
      const key = cacheEntryKey(shape, await inner.versions(tags));
      return {key, value: await inner.get(key)};
    });
    const store = Object.assign(inner, {lookup});
    const versions = jest.spyOn(store, "versions");
    const get = jest.spyOn(store, "get");
    const cache = new ReadCache({store}, host);
    const fetch = jest.fn(() => Promise.resolve({n: 1}));
    await cache.read(request(), fetch, codec);
    await cache.read(request(), fetch, codec);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(2);
    // Only from inside the stand-in lookup, never by the cache itself.
    expect(versions).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("reads uncached when the store's lookup fails", async() => {
    const errors: unknown[] = [];
    const store = Object.assign(new MemoryCacheStore(), {lookup: () => Promise.reject(new Error("down"))});
    const cache = new ReadCache({store, onError: (e) => errors.push(e)}, host);
    const fetch = jest.fn(() => Promise.resolve({n: 1}));
    expect(await cache.read(request(), fetch, codec)).toEqual({n: 1});
    await cache.read(request(), fetch, codec);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(2);
  });

  it("does not cache an options bag it cannot fingerprint", async() => {
    const store = new MemoryCacheStore();
    const cache = new ReadCache({store}, host);
    const fetch = jest.fn(() => Promise.resolve({n: 1}));
    await cache.read(request({where: () => 1}), fetch, codec);
    await cache.read(request({where: () => 1}), fetch, codec);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });
});

describe("OrmizeTransaction.afterCommit", () => {
  const manager = {adapters: {}} as unknown as Ormize;

  it("runs callbacks after commit and drops them on rollback", async() => {
    const committed = new OrmizeTransaction(manager);
    const ran = jest.fn();
    committed.afterCommit(ran);
    await committed.commit();
    expect(ran).toHaveBeenCalledTimes(1);

    const rolledBack = new OrmizeTransaction(manager);
    const skipped = jest.fn();
    rolledBack.afterCommit(skipped);
    await rolledBack.rollback();
    await rolledBack.commit();
    expect(skipped).not.toHaveBeenCalled();
  });

  it("does not let a failing callback fail the commit", async() => {
    const tx = new OrmizeTransaction(manager);
    const after = jest.fn();
    tx.afterCommit(() => { throw new Error("nope"); });
    tx.afterCommit(after);
    await expect(tx.commit()).resolves.toBeUndefined();
    expect(after).toHaveBeenCalled();
  });
});
