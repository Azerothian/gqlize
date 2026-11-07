import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { graphql, type GraphQLSchema } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { Ormize, MemoryCacheStore } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { dialectConfig, trackConnection, testDialect } from "@azerothian/test-fixtures/dialect";
import type IORedis from "ioredis";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

// The read cache across adapters. `Item` lives on Valkey and `File` on SQL, related
// both ways. A cross-adapter relation is resolved as a scoped root query on the
// target (`resolveFindAll` with a join-key scope), so the SQL side's rows are
// cached per parent. Valkey can't snapshot its rows, so on that side only counts
// are cached. Either way a hit has to equal a miss, and a write on either
// adapter has to reach the other side's cached reads.

const sqlName = testDialect();
let client: IORedis;

async function build(prefix: string, cached: boolean) {
  const orm = new Ormize(cached ? { cache: { store: new MemoryCacheStore(), onError: (e) => { throw e; } } } : {});
  const valkeyAdapter = new ValkeyAdapter({ prefix }, client);
  orm.registerAdapter(valkeyAdapter, "valkey");
  const sqlAdapter = new SequelizeAdapter({}, await dialectConfig());
  trackConnection(sqlAdapter);
  orm.registerAdapter(sqlAdapter, sqlName);
  await orm.addDefinition({
    name: "Item",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      label: { type: DataTypes.String, index: true },
    },
    relationships: [{ type: "hasMany", model: "File", name: "files", options: { foreignKey: "itemId" } }],
  }, "valkey");
  await orm.addDefinition({
    name: "File",
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
      size: { type: Sequelize.INTEGER, allowNull: true },
      itemId: { type: Sequelize.STRING, allowNull: true },
    },
    options: { timestamps: false },
    relationships: [{ type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } }],
  }, sqlName);
  await orm.initialise();
  await orm.sync();
  // Every read the cache can stand in for: SQL rows and counts, Valkey counts.
  // (Valkey rows are always read live: the adapter can't snapshot them.)
  const spies = [jest.spyOn(sqlAdapter, "findAll"), jest.spyOn(sqlAdapter, "count"), jest.spyOn(valkeyAdapter, "count")];
  const schema = await createSchema(orm);
  return { orm, schema, cacheableReads: () => spies.reduce((n, spy) => n + spy.mock.calls.length, 0) };
}

async function run(schema: GraphQLSchema, source: string) {
  const result = await graphql({ schema, source });
  if (result.errors?.length) {
    throw new Error(`${source}\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.data;
}

// Valkey ids are generated, so each engine is seeded through its own API with
// the same labels, and results are compared without ids.
async function seed(orm: Ormize) {
  const items: Record<string, unknown> = {};
  for (const label of ["a", "b", "c"]) {
    const [row] = await orm.processCreate("Item", null, { input: { label } }, {}, undefined);
    items[label] = (row as { id: unknown }).id;
  }
  const files: [string, number, string][] = [["a1", 10, "a"], ["a2", 30, "a"], ["a3", 20, "a"], ["b1", 5, "b"]];
  for (const [name, size, label] of files) {
    await orm.processCreate("File", null, { input: { name, size } }, {}, undefined);
    await orm.getModel("File").update({ itemId: items[label] }, { where: { name } });
  }
  return items;
}

const VARIANTS = [
  "query { models { Item(where: {label: {eq: \"a\"}}) { total edges { node { label files { total edges { node { name size } } } } } } } }",
  "query { models { Item(where: {label: {eq: \"a\"}}) { edges { node { label files(orderBy: sizeDESC) { edges { node { name } } } } } } } }",
  "query { models { Item(where: {label: {eq: \"a\"}}) { edges { node { label files(where: {size: {gt: 15}}) { total edges { node { name } } } } } } } }",
  "query { models { Item(where: {label: {eq: \"a\"}}) { edges { node { label files(first: 1, orderBy: nameDESC) { total edges { node { name } } } } } } } }",
  "query { models { Item(where: {label: {eq: \"b\"}}) { edges { node { label files { total edges { node { name } } } } } } } }",
  "query { models { Item(where: {label: {eq: \"c\"}}) { edges { node { label files { total } } } } } }",
  "query { models { File(orderBy: nameASC) { total edges { node { name size item { label } } } } } }",
  "query { models { File(where: {size: {lt: 25}}, orderBy: sizeASC) { total edges { node { name item { label } } } } } }",
  "query { models { File { total } } }",
  "query { models { Item { total } } }",
];

async function all(schema: GraphQLSchema) {
  const out: unknown[] = [];
  for (const v of VARIANTS) {
    out.push(await run(schema, v));
  }
  return out;
}

beforeAll(async () => {
  client = await makeClient();
  await flush(client);
});
afterAll(async () => { await shutdown(); });

describe("read cache across adapters", () => {
  it("serves cross-adapter relations from the cache exactly as a miss, and invalidates from either side", async () => {
    const plain = await build("plain", false);
    const cached = await build("cached", true);
    const plainItems = await seed(plain.orm);
    const cachedItems = await seed(cached.orm);

    const expected = await all(plain.schema);
    const seeded = cached.cacheableReads();
    expect(await all(cached.schema)).toEqual(expected);
    const before = cached.cacheableReads();
    // Not vacuous: every variant reached a cacheable read on the miss pass, the
    // root File reads and the per-parent cross-adapter `files` reads alike.
    expect(before - seeded).toBeGreaterThanOrEqual(VARIANTS.length);
    expect(await all(cached.schema)).toEqual(expected);
    // Every cacheable read in the second pass was a hit, the per-parent scoped ones included.
    expect(cached.cacheableReads()).toBe(before);

    // A write on each side, the same on both engines.
    for (const [engine, items] of [[plain, plainItems], [cached, cachedItems]] as const) {
      await engine.orm.processCreate("File", null, { input: { name: "c1", size: 7 } }, {}, undefined);
      await engine.orm.getModel("File").update({ itemId: items.c }, { where: { name: "c1" } });
      await engine.orm.processUpdate("File", null, { input: { size: 1 }, where: { name: { eq: "a2" } } }, {}, undefined);
      await engine.orm.processUpdate("Item", null, { input: { label: "bb" }, where: { label: { eq: "b" } } }, {}, undefined);
      // A nested write that crosses adapters: the File mutation creates an Item on
      // Valkey (re-entering `processCreate`), and the cached Valkey count of Items
      // has to see it.
      await engine.orm.processCreate("File", null, { input: { name: "z1", item: { create: { label: "z" } } } }, {}, undefined);
    }
    const after = await all(plain.schema);
    expect(after).not.toEqual(expected);
    expect(await all(cached.schema)).toEqual(after);
  });
});
