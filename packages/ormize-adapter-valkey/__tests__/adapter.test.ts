import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import type { AdapterQueryOptions, AdapterWhere } from "@azerothian/utilize/types/index";
import type IORedis from "ioredis";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let client: IORedis;
let adapter: ValkeyAdapter;

const UserDef = {
  name: "User",
  define: {
    id: { type: DataTypes.UUID, primaryKey: true },
    email: { type: DataTypes.String, unique: true },
    role: { type: DataTypes.String, index: true },
    name: { type: DataTypes.String },
    born: { type: DataTypes.Date },
  },
  options: {},
};

async function build() {
  adapter = new ValkeyAdapter({ prefix: "t" }, client);
  await adapter.createModel(UserDef);
  await adapter.initialise();
}

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await flush(client); await build(); });

const create = (input: { [field: string]: unknown }, options?: AdapterQueryOptions) => adapter.getCreateFunction("User")(input, options);
const find = (where?: AdapterWhere) => adapter.findAll("User", { where });

describe("valkey adapter — CRUD + type fidelity", () => {
  it("creates and reads back with types preserved", async () => {
    const born = new Date("1990-01-02T03:04:05.000Z");
    const u = await create({ email: "a@x.com", role: "admin", name: "Ada", born });
    expect(u.id).toBeTruthy();
    const rows = await find({ id: u.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].born instanceof Date).toBe(true);
    expect(rows[0].born.toISOString()).toBe(born.toISOString());
    expect(rows[0].email).toBe("a@x.com");
  });
});

describe("valkey adapter — index-only queries", () => {
  it("queries by an indexed field", async () => {
    await create({ email: "a@x.com", role: "admin", name: "Ada" });
    await create({ email: "b@x.com", role: "user", name: "Bob" });
    await create({ email: "c@x.com", role: "admin", name: "Cy" });
    const admins = await find({ role: "admin" });
    expect(admins.map((r) => r.name).sort()).toEqual(["Ada", "Cy"]);
  });

  it("lists all via the ids set when where is empty", async () => {
    await create({ email: "a@x.com", role: "admin" });
    await create({ email: "b@x.com", role: "user" });
    expect(await find({})).toHaveLength(2);
  });

  it("rejects a where that has no indexed field (no keyspace scan)", async () => {
    await create({ email: "a@x.com", role: "admin", name: "Ada" });
    await expect(find({ name: "Ada" })).rejects.toThrow(/indexed field/);
  });

  it("uses an index to seed then refines a non-indexed condition in memory", async () => {
    await create({ email: "a@x.com", role: "admin", name: "Ada" });
    await create({ email: "b@x.com", role: "admin", name: "Bob" });
    const rows = await find({ role: "admin", name: "Bob" });
    expect(rows.map((r) => r.name)).toEqual(["Bob"]);
  });

  it("enforces unique indexes", async () => {
    await create({ email: "dupe@x.com", role: "user" });
    await expect(create({ email: "dupe@x.com", role: "user" })).rejects.toThrow(/unique constraint/);
  });
});

describe("valkey adapter — expiry cascades to mappings", () => {
  it("setExpiry removes the object from index results once elapsed, and getExpiry reflects TTL", async () => {
    const u = await create({ email: "a@x.com", role: "admin", name: "Ada" });
    await adapter.setExpiry("User", u.id, 50);
    expect(await adapter.getExpiry("User", u.id)).toBeGreaterThan(0);
    // Still present immediately.
    expect(await find({ role: "admin" })).toHaveLength(1);
    // After it elapses, index + ids reads exclude it (score-filtered), no scan.
    await new Promise((r) => setTimeout(r, 120));
    expect(await find({ role: "admin" })).toHaveLength(0);
    expect(await find({})).toHaveLength(0);
  });
});
