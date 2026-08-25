import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";
import type IORedis from "ioredis";
import ValkeyAdapter, { type ValkeyRow } from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let client: IORedis;

const ItemDef = {
  name: "Item",
  define: {
    id: { type: DataTypes.UUID, primaryKey: true },
    label: { type: DataTypes.String, index: true },
  },
  options: {},
  relationships: [{ type: "hasMany", model: "Task", name: "tasks", options: { foreignKey: "itemId" } }],
};
const TaskDef = {
  name: "Task",
  define: {
    id: { type: DataTypes.UUID, primaryKey: true },
    name: { type: DataTypes.String },
  },
  options: {},
  relationships: [{ type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } }],
};

async function buildOrm() {
  const orm = new Ormize();
  const adapter = new ValkeyAdapter({ prefix: "orm" }, client);
  orm.registerAdapter(adapter, "valkey");
  await orm.addDefinition(ItemDef);
  await orm.addDefinition(TaskDef);
  await orm.initialise();
  await orm.sync();
  return { orm, adapter };
}

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await flush(client); });

describe("valkey adapter — ormize integration", () => {
  it("creates and lists through the manager", async () => {
    const { orm } = await buildOrm();
    await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("Item", null, { input: { label: "b" } }, {}, undefined);
    const { total, models } = await orm.resolveFindAll("Item", null, {}, {}, undefined);
    expect(total).toBe(2);
    // `resolveFindAll`'s `models` are `AdapterRow` (`unknown`) by contract — no
    // caller may assume a shape — so each row is narrowed locally to what this
    // test actually put in.
    expect(models.map((m) => (m as { label: string }).label).sort()).toEqual(["a", "b"]);
    const filtered = await orm.resolveFindAll("Item", null, { where: { label: "a" } }, {}, undefined);
    expect(filtered.total).toBe(1);
  });

  it("reads a hasMany relationship via the foreign-key index", async () => {
    const { orm, adapter } = await buildOrm();
    // Same `AdapterRow` (`unknown`) contract as above; this one is narrowed to
    // `ValkeyRow` rather than an ad hoc shape because it's passed on to the
    // adapter's own `resolveManyRelationship`, which expects one.
    const [item] = (await orm.processCreate("Item", null, { input: { label: "box" } }, {}, undefined)) as ValkeyRow[];
    await orm.processCreate("Task", null, { input: { name: "t1", itemId: item.id } }, {}, undefined);
    await orm.processCreate("Task", null, { input: { name: "t2", itemId: item.id } }, {}, undefined);
    const assoc = adapter.getAssociations("Item").tasks;
    const { total, models } = await adapter.resolveManyRelationship("Task", assoc, item, {args: {}, offset: 0});
    expect(total).toBe(2);
    // `resolveManyRelationship` here is the adapter's own (concrete) method,
    // which already returns `ValkeyRow[]` — no cast/annotation needed to read
    // `.name` off it.
    expect(models.map((m) => m.name).sort()).toEqual(["t1", "t2"]);
  });
});

describe("valkey adapter — cross-adapter transaction with SQLite", () => {
  it("rolls back the Valkey write when the SQLite write fails", async () => {
    const orm = new Ormize();
    const valkey = new ValkeyAdapter({ prefix: "xadapter" }, client);
    orm.registerAdapter(valkey, "valkey");
    orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
    await orm.addDefinition({ name: "Note", define: { id: { type: DataTypes.UUID, primaryKey: true }, text: { type: DataTypes.String, index: true } }, options: {} }, "valkey");
    await orm.addDefinition({ name: "Audit", define: { message: { type: Sequelize.STRING, allowNull: false } }, options: { timestamps: false } }, "sqlite");
    await orm.initialise();
    await orm.sync();

    await expect(
      orm.transaction(async () => {
        await orm.processCreate("Note", null, { input: { text: "hello" } }, {}, undefined); // valkey — buffered
        await orm.processCreate("Audit", null, { input: { message: null } }, {}, undefined); // sqlite — fails
      }),
    ).rejects.toBeTruthy();

    // The Valkey write was never committed (overlay discarded on rollback).
    const { total } = await orm.resolveFindAll("Note", null, {}, {}, undefined);
    expect(total).toBe(0);
  });
});
