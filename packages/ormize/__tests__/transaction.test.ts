import Database from "../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { OrmAdapter } from "../src/types";
import { describe, it, expect } from "@jest/globals";
import Sequelize from "sequelize";

// A minimal self-referential model: a Node has many child Nodes. `name` is NOT
// NULL, so a nested create with a null name fails at the DB — exercising the
// multi-step (parent + nested child) mutation path.
async function buildOrm() {
  const db: any = new Database();
  db.registerAdapter(
    new SequelizeAdapter({}, { dialect: "sqlite", logging: false }) as OrmAdapter,
    "sqlite",
  );
  await db.addDefinition({
    name: "Node",
    define: { name: { type: Sequelize.STRING, allowNull: false } },
    options: { timestamps: false },
    relationships: [
      { type: "hasMany", model: "Node", name: "children", options: { as: "children", foreignKey: "parentId", sourceKey: "id" } },
      { type: "belongsTo", model: "Node", name: "parent", options: { as: "parent", foreignKey: "parentId", sourceKey: "id" } },
    ],
  } as any);
  await db.initialise();
  await db.sync();
  return db;
}

describe("manager - transactions", () => {
  it("rolls back the parent when a nested create fails", async () => {
    const db = await buildOrm();
    const before = await db.models.Node.count();
    await expect(
      db.processCreate(
        "Node",
        null,
        { input: { name: "parent", children: { create: [{ name: null }] } } },
        {},
        undefined,
      ),
    ).rejects.toBeTruthy();
    // The parent must NOT be left orphaned — the whole mutation rolled back.
    expect(await db.models.Node.count()).toEqual(before);
  });

  it("commits a valid multi-step create (parent + children) atomically", async () => {
    const db = await buildOrm();
    const before = await db.models.Node.count();
    await db.processCreate(
      "Node",
      null,
      { input: { name: "parent", children: { create: [{ name: "a" }, { name: "b" }] } } },
      {},
      undefined,
    );
    // Parent + two children all committed.
    expect(await db.models.Node.count()).toEqual(before + 3);
    const parent = await db.models.Node.findOne({ where: { name: "parent" } });
    const childA = await db.models.Node.findOne({ where: { name: "a" } });
    expect(childA.parentId).toEqual(parent.id);
  });
});
