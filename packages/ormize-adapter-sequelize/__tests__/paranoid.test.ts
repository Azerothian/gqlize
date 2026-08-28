import Sequelize from "sequelize";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "../src";
import type { Definition } from "@azerothian/utilize";
import { describe, expect, it, jest, afterEach } from "@jest/globals";

/**
 * Soft delete, at the adapter boundary: which models actually soft delete, and
 * how `defaultModel` decides that for all of them at once.
 *
 * `softDeletes` is the single predicate the GraphQL layer asks before it emits a
 * `deleted` argument or a `restore` mutation, so everything here is really one
 * question — can this model answer for a deleted row at all?
 */

async function build(
  adapterOptions: ConstructorParameters<typeof SequelizeAdapter>[0],
  definitions: Definition[],
) {
  const orm = new Ormize();
  const adapter = new SequelizeAdapter(adapterOptions, { dialect: "sqlite", logging: false });
  orm.registerAdapter(adapter as never, "sqlite");
  for (const def of definitions) {
    await orm.addDefinition(def);
  }
  await orm.initialise();
  await orm.sync();
  return { orm, adapter };
}

const define = { body: { type: Sequelize.STRING } };

describe("sequelize adapter - paranoid", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("_timestampAttributes (canary)", () => {
    // Undocumented in Sequelize's public typings, and the only place the real
    // column name lives once `deletedAt` has been renamed. If a Sequelize
    // upgrade moves it, `softDeletes` goes quietly false for every model and the
    // whole feature disappears from the schema — hence a canary, as
    // `define-model.test.ts` keeps for its own undocumented internals.
    it("names the deletedAt column on a paranoid model", async() => {
      const { adapter } = await build({}, [{ name: "A", define, options: { paranoid: true } }]);
      const model = adapter.getModel("A") as unknown as { _timestampAttributes?: { deletedAt?: string } };
      expect(model._timestampAttributes?.deletedAt).toEqual("deletedAt");
    });

    it("follows the column when it is renamed", async() => {
      const { adapter } = await build({}, [
        { name: "A", define, options: { paranoid: true, deletedAt: "archivedAt" } },
      ]);
      const model = adapter.getModel("A") as unknown as { _timestampAttributes?: { deletedAt?: string } };
      expect(model._timestampAttributes?.deletedAt).toEqual("archivedAt");
      expect(Object.keys(adapter.getModel("A").rawAttributes)).toContain("archivedAt");
      expect(adapter.softDeletes("A")).toEqual(true);
    });

    it("is empty when paranoid is set without timestamps", async() => {
      // Sequelize accepts the pair and reports `options.paranoid === true`, but
      // defines no column — so `options.paranoid` alone is not a usable predicate.
      jest.spyOn(console, "warn").mockImplementation(() => { /* the warning has its own test */ });
      const { adapter } = await build({}, [
        { name: "A", define, options: { paranoid: true, timestamps: false } },
      ]);
      const model = adapter.getModel("A") as unknown as { _timestampAttributes?: { deletedAt?: string }, options: { paranoid?: boolean } };
      expect(model.options.paranoid).toEqual(true);
      expect(model._timestampAttributes?.deletedAt).toBeUndefined();
      expect(adapter.softDeletes("A")).toEqual(false);
    });
  });

  describe("softDeletes", () => {
    it("is false for a model with no paranoid option", async() => {
      const { adapter } = await build({}, [{ name: "A", define }]);
      expect(adapter.softDeletes("A")).toEqual(false);
    });

    it("is true for a model that opts in on its own", async() => {
      const { adapter } = await build({}, [{ name: "A", define, options: { paranoid: true } }]);
      expect(adapter.softDeletes("A")).toEqual(true);
    });
  });

  describe("defaultModel merge order", () => {
    it("turns every model paranoid when set globally", async() => {
      const { adapter } = await build(
        { defaultModel: { timestamps: true, paranoid: true } },
        [{ name: "A", define }, { name: "B", define }],
      );
      expect(adapter.softDeletes("A")).toEqual(true);
      expect(adapter.softDeletes("B")).toEqual(true);
    });

    it("lets one model opt out of a global default", async() => {
      // `Object.assign({}, defaultModel, def.options)` — the definition's own
      // options are merged *over* the default, which is what makes "all, except
      // this one" expressible without a second switch.
      const { adapter } = await build(
        { defaultModel: { timestamps: true, paranoid: true } },
        [{ name: "A", define }, { name: "B", define, options: { paranoid: false } }],
      );
      expect(adapter.softDeletes("A")).toEqual(true);
      expect(adapter.softDeletes("B")).toEqual(false);
      expect(Object.keys(adapter.getModel("B").rawAttributes)).not.toContain("deletedAt");
    });

    it("lets one model opt in with no global default", async() => {
      const { adapter } = await build({}, [
        { name: "A", define },
        { name: "B", define, options: { paranoid: true } },
      ]);
      expect(adapter.softDeletes("A")).toEqual(false);
      expect(adapter.softDeletes("B")).toEqual(true);
    });

    it("leaves a generated join model non-paranoid under a global default", async() => {
      // Join tables are defined with `timestamps: false`, which a global
      // `paranoid: true` would turn into the silent no-op above — a table whose
      // deletes are hard while it claims to soft delete. The generator pins
      // `paranoid: false` for exactly that reason.
      const { adapter } = await build({ defaultModel: { timestamps: true, paranoid: true } }, [
        {
          name: "Left", define,
          relationships: [{ type: "belongsToMany", model: "Right", name: "rights", options: { through: "LeftRight" } }],
        },
        {
          name: "Right", define,
          relationships: [{ type: "belongsToMany", model: "Left", name: "lefts", options: { through: "LeftRight" } }],
        },
      ]);
      expect(adapter.softDeletes("LeftRight")).toEqual(false);
      expect(adapter.getModel("LeftRight").options.paranoid).toEqual(false);
    });
  });

  it("warns when paranoid is set with timestamps off", async() => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
    await build({}, [{ name: "A", define, options: { paranoid: true, timestamps: false } }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deletes will be permanent"));
    expect(warn.mock.calls[0][0]).toContain(`Model "A"`);
  });

  it("does not warn for the ordinary paranoid model", async() => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
    await build({}, [{ name: "A", define, options: { paranoid: true } }]);
    expect(warn).not.toHaveBeenCalled();
  });
});
