import Database from "../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { describe, it, expect } from "@jest/globals";
import Sequelize from "sequelize";

// A minimal self-referential model: a Node has many child Nodes. `name` is NOT
// NULL, so a nested create with a null name fails at the DB — exercising the
// multi-step (parent + nested child) mutation path.
async function buildOrm() {
  const db = new Database();
  db.registerAdapter(
    new SequelizeAdapter({}, { dialect: "sqlite", logging: false }),
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
  });
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

// Two adapters (two independent SQLite instances). `Left` lives on "sqlite",
// `Right` on "sqlite2". A coordinated `orm.transaction` must commit both or, on
// failure, roll BOTH back — even though they are separate database connections.
async function buildTwoAdapterOrm() {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite2");
  await db.addDefinition({ name: "Left", define: { name: { type: Sequelize.STRING, allowNull: false } }, options: { timestamps: false } }, "sqlite");
  await db.addDefinition({ name: "Right", define: { name: { type: Sequelize.STRING, allowNull: false } }, options: { timestamps: false } }, "sqlite2");
  await db.initialise();
  await db.sync();
  return db;
}

describe("manager - cross-adapter transactions", () => {
  it("rolls back BOTH adapters when work on one fails", async () => {
    const db = await buildTwoAdapterOrm();
    await expect(
      db.transaction(async () => {
        await db.processCreate("Left", null, { input: { name: "l" } }, {}, undefined);
        // Fails at the DB (NOT NULL) on the *other* adapter.
        await db.processCreate("Right", null, { input: { name: null } }, {}, undefined);
      }),
    ).rejects.toBeTruthy();
    // The Left row (a different adapter/connection) must have rolled back too.
    expect(await db.models.Left.count()).toEqual(0);
    expect(await db.models.Right.count()).toEqual(0);
  });

  it("commits both adapters when all work succeeds", async () => {
    const db = await buildTwoAdapterOrm();
    await db.transaction(async () => {
      await db.processCreate("Left", null, { input: { name: "l" } }, {}, undefined);
      await db.processCreate("Right", null, { input: { name: "r" } }, {}, undefined);
    });
    expect(await db.models.Left.count()).toEqual(1);
    expect(await db.models.Right.count()).toEqual(1);
  });
});

describe("manager - ambient context tracking", () => {
  it("propagates the request context across async boundaries into hooks", async () => {
    let seenInHook: unknown;
    const db = new Database();
    db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
    await db.addDefinition({
      name: "Ctx",
      define: { name: { type: Sequelize.STRING, allowNull: false } },
      options: { timestamps: false },
      before(opts) {
        // The hook reads the ambient context implicitly — it was never threaded.
        seenInHook = db.getContext();
        return opts.params;
      },
    });
    await db.initialise();
    await db.sync();

    expect(db.getContext()).toBeUndefined();
    await db.runWithContext({ user: "u1" }, async () => {
      expect(db.getContext()).toEqual({ user: "u1" });
      await db.processCreate("Ctx", null, { input: { name: "x" } }, {}, undefined);
    });
    expect(seenInHook).toEqual({ user: "u1" });
    // Context does not leak outside the scope.
    expect(db.getContext()).toBeUndefined();
  });
});
