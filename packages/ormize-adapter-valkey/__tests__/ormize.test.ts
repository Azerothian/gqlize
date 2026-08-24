import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let client: any;

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
  const orm: any = new Ormize();
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
    expect(models.map((m: any) => m.label).sort()).toEqual(["a", "b"]);
    const filtered = await orm.resolveFindAll("Item", null, { where: { label: "a" } }, {}, undefined);
    expect(filtered.total).toBe(1);
  });

  it("reads a hasMany relationship via the foreign-key index", async () => {
    const { orm, adapter } = await buildOrm();
    const [item] = await orm.processCreate("Item", null, { input: { label: "box" } }, {}, undefined);
    await orm.processCreate("Task", null, { input: { name: "t1", itemId: item.id } }, {}, undefined);
    await orm.processCreate("Task", null, { input: { name: "t2", itemId: item.id } }, {}, undefined);
    const assoc = adapter.getAssociations("Item").tasks;
    const { total, models } = await adapter.resolveManyRelationship("Task", assoc, item, {}, 0, undefined, {}, {}, false);
    expect(total).toBe(2);
    expect(models.map((m: any) => m.name).sort()).toEqual(["t1", "t2"]);
  });
});

describe("valkey adapter — cross-adapter transaction with SQLite", () => {
  it("rolls back the Valkey write when the SQLite write fails", async () => {
    const orm: any = new Ormize();
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
