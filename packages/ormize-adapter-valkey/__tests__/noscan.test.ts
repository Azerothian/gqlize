import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import type IORedis from "ioredis";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let rawClient: IORedis;

const Def = {
  name: "Thing",
  define: {
    id: { type: DataTypes.UUID, primaryKey: true },
    kind: { type: DataTypes.String, index: true },
    label: { type: DataTypes.String, unique: true },
  },
  options: {},
};

beforeAll(async () => { rawClient = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await flush(rawClient); });

describe("valkey adapter — never scans the keyspace", () => {
  it("issues no KEYS/SCAN commands across CRUD, queries and expiry", async () => {
    const seen = new Set<string>();
    // Record every command name the adapter invokes on the client.
    const spy = new Proxy(rawClient, {
      get(target, prop) {
        // `target` is a real `IORedis`, so an arbitrary-string index into it
        // needs its own (test-only) view; the value's actual shape is read back
        // via `typeof` immediately below, not assumed here.
        const v = (target as unknown as { [k: string]: unknown })[prop as string];
        if (typeof v === "function") {
          return (...args: unknown[]) => {
            if (typeof prop === "string") seen.add(prop.toLowerCase());
            return v.apply(target, args);
          };
        }
        return v;
      },
    });

    const adapter = new ValkeyAdapter({ prefix: "ns" }, spy);
    await adapter.createModel(Def);
    const create = adapter.getCreateFunction("Thing");

    const a = await create({ kind: "x", label: "l1" });
    await create({ kind: "x", label: "l2" });
    await create({ kind: "y", label: "l3" });

    await adapter.findAll("Thing", { where: { kind: "x" } });   // indexed query
    await adapter.findAll("Thing", { where: {} });               // list-all via ids
    await adapter.findAll("Thing", { where: { id: a.id } });     // pk lookup
    await adapter.getUpdateFunction("Thing", undefined)({ kind: "x" }, () => ({ kind: "z" }), {});
    await adapter.setExpiry("Thing", a.id, 1000);
    await adapter.getExpiry("Thing", a.id);
    await adapter.getDeleteFunction("Thing", undefined)({ kind: "y" }, {});

    expect(seen.has("keys")).toBe(false);
    expect(seen.has("scan")).toBe(false);
    // Sanity: we DID talk to redis via index/object primitives.
    expect(seen.has("zrange") || seen.has("mget") || seen.has("get")).toBe(true);
  });
});
