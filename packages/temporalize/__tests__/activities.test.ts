import { beforeEach, describe, expect, it } from "@jest/globals";
import { createActivities } from "../src/activities";
import { ErrorType } from "../src/workflow-types";
import { buildOrm, ctx, expectFailure } from "./helper";

describe("generated activities", () => {
  let orm: any;
  let acts: any;

  beforeEach(async () => {
    orm = await buildOrm();
    acts = createActivities(orm);
  });

  it("generates a CRUD activity set per model, namespaced by model name", () => {
    for (const op of ["create", "findAll", "findOne", "findByPk", "count", "update", "destroy", "select"]) {
      expect(typeof acts[`Task.${op}`]).toBe("function");
      expect(typeof acts[`Item.${op}`]).toBe("function");
    }
  });

  it("generates activities for declared class and instance methods", () => {
    expect(typeof acts["Item.classMethods.labelsUpper"]).toBe("function");
    expect(typeof acts["Item.instanceMethods.describe"]).toBe("function");
    // Task declares neither.
    expect(acts["Task.classMethods.labelsUpper"]).toBeUndefined();
  });

  it("can be narrowed to one queue's models", () => {
    const only = createActivities(orm, {}, ["Task"]);
    expect(Object.keys(only).every((k) => k.startsWith("Task."))).toBe(true);
  });

  it("omits method activities when they are not exposed", () => {
    const bare = createActivities(orm, { expose: { classMethods: false, instanceMethods: false } });
    expect(bare["Item.classMethods.labelsUpper"]).toBeUndefined();
    expect(bare["Item.instanceMethods.describe"]).toBeUndefined();
    expect(typeof bare["Item.create"]).toBe("function");
  });

  describe("crud round trip", () => {
    it("creates and reads back", async () => {
      const created = await acts["Task.create"]({ context: ctx, input: { name: "alpha" } });
      expect(created).toHaveLength(1);
      expect(created[0].name).toBe("alpha");

      const list = await acts["Task.findAll"]({ context: ctx });
      expect(list.total).toBe(1);
      expect(list.rows[0].name).toBe("alpha");

      const one = await acts["Task.findByPk"]({ context: ctx, id: created[0].id });
      expect(one.name).toBe("alpha");
    });

    it("returns plain JSON, not ORM instances", async () => {
      const [created] = await acts["Task.create"]({ context: ctx, input: { name: "alpha" } });
      expect(Object.getPrototypeOf(created)).toBe(Object.prototype);
      expect(() => JSON.stringify(created)).not.toThrow();
    });

    it("filters, orders and paginates", async () => {
      for (const name of ["a", "b", "c"]) {
        await acts["Task.create"]({ context: ctx, input: { name } });
      }
      const filtered = await acts["Task.findAll"]({ context: ctx, where: { name: { eq: "b" } } });
      expect(filtered.total).toBe(1);
      expect(filtered.rows[0].name).toBe("b");

      const page = await acts["Task.findAll"]({ context: ctx, orderBy: [["name", "DESC"]], limit: 2 });
      expect(page.total).toBe(3);
      expect(page.rows.map((r: any) => r.name)).toEqual(["c", "b"]);

      const offset = await acts["Task.findAll"]({ context: ctx, orderBy: [["name", "ASC"]], limit: 1, offset: 2 });
      expect(offset.rows.map((r: any) => r.name)).toEqual(["c"]);
    });

    it("counts without returning rows", async () => {
      await acts["Task.create"]({ context: ctx, input: { name: "alpha" } });
      await acts["Task.create"]({ context: ctx, input: { name: "beta" } });
      expect(await acts["Task.count"]({ context: ctx })).toBe(2);
    });

    it("findOne returns null when nothing matches", async () => {
      expect(await acts["Task.findOne"]({ context: ctx, where: { name: { eq: "nope" } } })).toBeNull();
      expect(await acts["Task.findByPk"]({ context: ctx, id: 999 })).toBeNull();
    });

    it("updates matching rows", async () => {
      await acts["Task.create"]({ context: ctx, input: { name: "alpha" } });
      const updated = await acts["Task.update"]({
        context: ctx,
        input: { done: true },
        where: { name: { eq: "alpha" } },
      });
      expect(updated).toHaveLength(1);
      expect(updated[0].done).toBe(true);
    });

    it("destroys matching rows", async () => {
      await acts["Task.create"]({ context: ctx, input: { name: "alpha" } });
      const deleted = await acts["Task.destroy"]({ context: ctx, where: { name: { eq: "alpha" } } });
      expect(deleted).toHaveLength(1);
      expect(await acts["Task.count"]({ context: ctx })).toBe(0);
    });

    it("select rewires relationships without writing the matched rows", async () => {
      const [item] = await acts["Item.create"]({ context: ctx, input: { label: "parent" } });
      const rows = await acts["Item.select"]({
        context: ctx,
        where: { label: { eq: "parent" } },
        input: { tasks: { create: [{ name: "child" }] } },
      });
      expect(rows).toHaveLength(1);
      // The matched Item is untouched; the child Task now points at it.
      expect(rows[0].label).toBe("parent");
      const tasks = await acts["Task.findAll"]({ context: ctx });
      expect(tasks.rows.map((t: any) => [t.name, t.itemId])).toEqual([["child", item.id]]);
    });
  });

  describe("class and instance methods", () => {
    it("dispatches a class method with args and context", async () => {
      await acts["Item.create"]({ context: ctx, input: { label: "alpha" } });
      await acts["Item.create"]({ context: ctx, input: { label: "beta" } });
      const result = await acts["Item.classMethods.labelsUpper"]({ context: ctx, args: {} });
      expect(result.sort()).toEqual(["ALPHA", "BETA"]);
    });

    it("loads the addressed row before dispatching an instance method", async () => {
      const [item] = await acts["Item.create"]({ context: ctx, input: { label: "alpha" } });
      const result = await acts["Item.instanceMethods.describe"]({
        context: ctx,
        id: item.id,
        args: { suffix: "x" },
      });
      expect(result).toBe("alpha:x");
    });

    it("fails non-retryably when the instance does not exist", async () => {
      await expectFailure(
        acts["Item.instanceMethods.describe"]({ context: ctx, id: 999, args: {} }),
        ErrorType.NotFound
      );
    });

    it("requires an id to address an instance", async () => {
      await expectFailure(
        acts["Item.instanceMethods.describe"]({ context: ctx, args: {} }),
        ErrorType.Validation
      );
    });
  });

  describe("guards", () => {
    it("refuses an unscoped bulk update unless all:true is passed", async () => {
      await acts["Task.create"]({ context: ctx, input: { name: "alpha" } });
      await expectFailure(
        acts["Task.update"]({ context: ctx, input: { done: true } }),
        ErrorType.UnscopedMutation
      );
      const updated = await acts["Task.update"]({ context: ctx, input: { done: true }, all: true });
      expect(updated).toHaveLength(1);
    });

    it("refuses an unscoped bulk delete unless all:true is passed", async () => {
      await acts["Task.create"]({ context: ctx, input: { name: "alpha" } });
      await expectFailure(acts["Task.destroy"]({ context: ctx }), ErrorType.UnscopedMutation);
      expect(await acts["Task.destroy"]({ context: ctx, all: true })).toHaveLength(1);
    });

    it("validates input against the generated create schema", async () => {
      // `name` is allowNull: false, so an empty create is rejected before it
      // reaches the driver.
      await expectFailure(acts["Task.create"]({ context: ctx, input: {} }), ErrorType.Validation);
    });

    it("skips validation when disabled", async () => {
      const loose = createActivities(orm, { validate: false });
      // The same input the schema rejected above now reaches the engine
      // untouched, so no non-retryable Validation failure is raised.
      await expect(loose["Task.create"]({ context: ctx, input: {} })).resolves.toEqual([]);
    });

    it("rejects a non-positive limit and a negative offset", async () => {
      await expectFailure(acts["Task.findAll"]({ context: ctx, limit: 0 }), ErrorType.Validation);
      await expectFailure(acts["Task.findAll"]({ context: ctx, offset: -1 }), ErrorType.Validation);
    });

    it("refuses every mutation when readOnly", async () => {
      const ro = createActivities(orm, { readOnly: true });
      await expectFailure(ro["Task.create"]({ context: ctx, input: { name: "a" } }), ErrorType.Forbidden);
      await expectFailure(ro["Task.destroy"]({ context: ctx, all: true }), ErrorType.Forbidden);
      await expectFailure(ro["Item.classMethods.labelsUpper"]({ context: ctx }), ErrorType.Forbidden);
      // Reads still work.
      await expect(ro["Task.count"]({ context: ctx })).resolves.toBe(0);
    });
  });
});
