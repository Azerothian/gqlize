import { describe, it, expect } from "@jest/globals";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import type { Definition } from "../src/types";
import Database from "../src/manager";

/**
 * `OrmAdapter.discoverDefinitions` — the hook a backend that owns its own schema
 * registers its models through, instead of being handed them by `define()`.
 *
 * Tested here against the SQL adapter rather than the MikroORM one, because what
 * is being pinned is the *manager's* half of the contract: when it runs, what
 * wins, and what happens on a second call. Those answers must not depend on
 * which backend supplied the definitions.
 */

const NOTE: Definition = {
  name: "Note",
  define: { title: { type: DataTypes.String } },
  options: { timestamps: false },
};
const TAG: Definition = {
  name: "Tag",
  define: { label: { type: DataTypes.String } },
  options: { timestamps: false },
};

/** An adapter that reports definitions of its own, and counts how often it was asked. */
function discovering(definitions: Definition[]) {
  const adapter = new SequelizeAdapter({}, { dialect: "sqlite", logging: false });
  let calls = 0;
  return Object.assign(adapter, {
    discoverDefinitions: () => {
      calls += 1;
      return definitions;
    },
    discoveryCalls: () => calls,
  });
}

describe("adapter-supplied definitions", () => {
  it("registers them during initialise(), with no define() call", async () => {
    const db = new Database();
    db.registerAdapter(discovering([NOTE, TAG]));
    await db.initialise();

    expect(Object.keys(db.getDefinitions()).sort()).toEqual(["Note", "Tag"]);
    expect(db.getModel("Note")).toBeDefined();
    expect(db.getFields("Note").title).toBeDefined();
  });

  it("lets an explicitly authored definition win over the adapter's", async () => {
    const db = new Database();
    db.registerAdapter(discovering([NOTE]));
    // Same name, different shape. Discovery runs after the `define()` queue has
    // drained, so this is the one that survives — an author overriding a
    // discovered model is the whole reason the order is that way round.
    db.define({
      ...NOTE,
      define: { title: { type: DataTypes.String }, pinned: { type: DataTypes.Boolean } },
    } as never);
    await db.initialise();

    expect(db.getFields("Note").pinned).toBeDefined();
  });

  it("is a no-op on a second initialise() rather than a duplicate-name throw", async () => {
    const db = new Database();
    const adapter = discovering([NOTE]);
    db.registerAdapter(adapter);
    await db.initialise();
    await expect(db.initialise()).resolves.toBeUndefined();

    expect(adapter.discoveryCalls()).toBe(2);
    expect(Object.keys(db.getDefinitions())).toEqual(["Note"]);
  });

  it("wires the relationships a discovered definition declares", async () => {
    const db = new Database();
    db.registerAdapter(discovering([
      { ...NOTE, relationships: [{ type: "hasMany", model: "Tag", name: "tags", options: { foreignKey: "noteId" } }] },
      { ...TAG, define: { ...TAG.define, noteId: { type: DataTypes.Int } } },
    ]));
    await db.initialise();

    expect(db.getAssociations("Note").tags).toMatchObject({ target: "Tag", foreignKey: "noteId" });
  });

  it("leaves an adapter that does not implement it alone", async () => {
    // Absent means "this backend has no schema of its own", which is how both
    // shipped SQL/KV adapters work — `initialise()` must not assume otherwise.
    const db = new Database();
    db.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }));
    db.define(NOTE as never);
    await db.initialise();

    expect(Object.keys(db.getDefinitions())).toEqual(["Note"]);
  });
});
