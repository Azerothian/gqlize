import {describe, it, expect, beforeEach, afterAll} from "@jest/globals";
import type IORedis from "ioredis";
import {IORedisCacheStore} from "../src";
import {flush, makeClient, shutdown} from "./helper/redis";

let client: IORedis;

beforeEach(async() => {
  client = await makeClient();
  await flush(client);
});

afterAll(shutdown);

describe("IORedisCacheStore", () => {
  it("stores, reads and expires entries", async() => {
    const store = new IORedisCacheStore(client);
    await store.set("a", "1", 60_000);
    expect(await store.get("a")).toBe("1");
    expect(await store.get("missing")).toBeUndefined();
    await store.set("short", "x", 20);
    await new Promise((r) => setTimeout(r, 60));
    expect(await store.get("short")).toBeUndefined();
  });

  it("evicts the least recently used entry past maxEntries", async() => {
    const store = new IORedisCacheStore(client, {maxEntries: 2});
    await store.set("a", "1", 60_000);
    await store.set("b", "2", 60_000);
    await store.get("a"); // `b` is now the oldest
    await store.set("c", "3", 60_000);
    expect(await store.get("a")).toBe("1");
    expect(await store.get("b")).toBeUndefined();
    expect(await store.get("c")).toBe("3");
    expect(await client.zcard("{ormize-cache}:lru")).toBe(2);
  });

  it("evicts by bytes past maxSize, and refuses an entry bigger than the budget", async() => {
    const keyBytes = "{t}:e:a".length;
    const store = new IORedisCacheStore(client, {prefix: "t", maxSize: 2 * (keyBytes + 4)});
    await store.set("a", "1234", 60_000);
    await store.set("b", "1234", 60_000);
    await store.set("c", "12", 60_000);
    expect(await store.get("a")).toBeUndefined();
    expect(Number(await client.get("{t}:bytes"))).toBe(2 * keyBytes + 6);
    await store.set("d", "x".repeat(100), 60_000);
    expect(await store.get("d")).toBeUndefined();
    expect(await store.get("b")).toBe("1234");
  });

  it("replaces an entry without double-counting it, and settles an expired one on a miss", async() => {
    const store = new IORedisCacheStore(client, {prefix: "t"});
    await store.set("a", "1234", 60_000);
    await store.set("a", "12", 60_000);
    expect(Number(await client.get("{t}:bytes"))).toBe("{t}:e:a".length + 2);
    await client.del("{t}:e:a"); // as if it had expired
    expect(await store.get("a")).toBeUndefined();
    expect(Number(await client.get("{t}:bytes"))).toBe(0);
    expect(await client.zcard("{t}:lru")).toBe(0);
  });

  it("shares generations between stores on the same prefix, and not across prefixes", async() => {
    const one = new IORedisCacheStore(client);
    const two = new IORedisCacheStore(await makeClient());
    const other = new IORedisCacheStore(client, {prefix: "other"});
    expect(await one.versions(["A", "B"])).toEqual([0, 0]);
    await two.invalidate(["A"]);
    await two.invalidate(["A", "B"]);
    expect(await one.versions(["B", "A"])).toEqual([1, 2]);
    expect(await other.versions(["A"])).toEqual([0]);
    expect(await one.versions([])).toEqual([]);
  });

  it("reloads its scripts after the server forgets them", async() => {
    const store = new IORedisCacheStore(client);
    await store.set("a", "1", 60_000);
    await client.script("FLUSH");
    expect(await store.get("a")).toBe("1");
  });

  it("clears only its own prefix", async() => {
    const store = new IORedisCacheStore(client);
    await store.set("a", "1", 60_000);
    await store.invalidate(["A"]);
    await client.set("unrelated", "keep");
    await store.clear();
    expect(await store.get("a")).toBeUndefined();
    expect(await store.versions(["A"])).toEqual([0]);
    expect(await client.get("unrelated")).toBe("keep");
  });

  it("opens and closes its own client from a connection", async() => {
    const options = client.options;
    const store = new IORedisCacheStore({host: options.host, port: options.port, lazyConnect: false});
    await store.set("a", "1", 60_000);
    expect(await store.get("a")).toBe("1");
    await store.quit();
  });
});
