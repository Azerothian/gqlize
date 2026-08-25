import { beforeEach, describe, expect, it } from "@jest/globals";
import type { Ormize } from "@azerothian/ormize";
import type { ActivityMap } from "../src/types";
import { createActivities } from "../src/activities";
import { ErrorType } from "../src/workflow-types";
import type { FindAllResult } from "../src/workflow-types";
import { buildOrm, ctx, expectFailure } from "./helper";

/** Plain-JSON shape of a row as it leaves an activity, for the two fixture models in `./helper`. */
type TaskRow = { id: number; name: string; done?: boolean; itemId?: number | null };
type ItemRow = { id: number; label: string };

describe("generated activities", () => {
  let orm: Ormize;
  let acts: ActivityMap;

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
      const created = (await acts["Task.create"]({ context: ctx, input: { name: "alpha" } })) as TaskRow[];
      expect(created).toHaveLength(1);
      expect(created[0].name).toBe("alpha");

      const list = (await acts["Task.findAll"]({ context: ctx })) as FindAllResult<TaskRow>;
      expect(list.total).toBe(1);
      expect(list.rows[0].name).toBe("alpha");

      const one = (await acts["Task.findByPk"]({ context: ctx, id: created[0].id })) as TaskRow;
      expect(one.name).toBe("alpha");
    });

    it("returns plain JSON, not ORM instances", async () => {
      const [created] = (await acts["Task.create"]({ context: ctx, input: { name: "alpha" } })) as TaskRow[];
      expect(Object.getPrototypeOf(created)).toBe(Object.prototype);
      expect(() => JSON.stringify(created)).not.toThrow();
    });

    it("filters, orders and paginates", async () => {
      for (const name of ["a", "b", "c"]) {
        await acts["Task.create"]({ context: ctx, input: { name } });
      }
      const filtered = (await acts["Task.findAll"]({ context: ctx, where: { name: { eq: "b" } } })) as FindAllResult<TaskRow>;
      expect(filtered.total).toBe(1);
      expect(filtered.rows[0].name).toBe("b");

      const page = (await acts["Task.findAll"]({
        context: ctx,
        orderBy: [["name", "DESC"]],
        limit: 2,
      })) as FindAllResult<TaskRow>;
      expect(page.total).toBe(3);
      expect(page.rows.map((r) => r.name)).toEqual(["c", "b"]);

      const offset = (await acts["Task.findAll"]({
        context: ctx,
        orderBy: [["name", "ASC"]],
        limit: 1,
        offset: 2,
      })) as FindAllResult<TaskRow>;
      expect(offset.rows.map((r) => r.name)).toEqual(["c"]);
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
      const updated = (await acts["Task.update"]({
        context: ctx,
        input: { done: true },
        where: { name: { eq: "alpha" } },
      })) as TaskRow[];
      expect(updated).toHaveLength(1);
      expect(updated[0].done).toBe(true);
    });

    it("destroys matching rows", async () => {
      await acts["Task.create"]({ context: ctx, input: { name: "alpha" } });
      const deleted = (await acts["Task.destroy"]({ context: ctx, where: { name: { eq: "alpha" } } })) as TaskRow[];
      expect(deleted).toHaveLength(1);
      expect(await acts["Task.count"]({ context: ctx })).toBe(0);
    });

    it("select rewires relationships without writing the matched rows", async () => {
      const [item] = (await acts["Item.create"]({ context: ctx, input: { label: "parent" } })) as ItemRow[];
      const rows = (await acts["Item.select"]({
        context: ctx,
        where: { label: { eq: "parent" } },
        input: { tasks: { create: [{ name: "child" }] } },
      })) as ItemRow[];
      expect(rows).toHaveLength(1);
      // The matched Item is untouched; the child Task now points at it.
      expect(rows[0].label).toBe("parent");
      const tasks = (await acts["Task.findAll"]({ context: ctx })) as FindAllResult<TaskRow>;
      expect(tasks.rows.map((t) => [t.name, t.itemId])).toEqual([["child", item.id]]);
    });
  });

  describe("class and instance methods", () => {
    it("dispatches a class method with args and context", async () => {
      await acts["Item.create"]({ context: ctx, input: { label: "alpha" } });
      await acts["Item.create"]({ context: ctx, input: { label: "beta" } });
      const result = (await acts["Item.classMethods.labelsUpper"]({ context: ctx, args: {} })) as string[];
      expect(result.sort()).toEqual(["ALPHA", "BETA"]);
    });

    it("loads the addressed row before dispatching an instance method", async () => {
      const [item] = (await acts["Item.create"]({ context: ctx, input: { label: "alpha" } })) as ItemRow[];
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

    it("commits what a `mutations`-target transform assigns to `this`", async () => {
      // `relabel` returns nothing; everything it does is a write to `this`.
      // Calling it and serialising the return value — which is what an activity
      // used to do for every instance method — dropped that write entirely.
      const [item] = (await acts["Item.create"]({ context: ctx, input: { label: "alpha" } })) as ItemRow[];
      await acts["Item.instanceMethods.relabel"]({ context: ctx, id: item.id, args: { to: "omega" } });
      const after = (await acts["Item.findByPk"]({ context: ctx, id: item.id })) as ItemRow;
      expect(after.label).toBe("omega");
    });

    it("answers a transform with the persisted row, not the method's return", async () => {
      const [item] = (await acts["Item.create"]({ context: ctx, input: { label: "alpha" } })) as ItemRow[];
      const result = (await acts["Item.instanceMethods.relabel"]({ context: ctx, id: item.id })) as ItemRow[];
      expect(Array.isArray(result) ? result[0].label : (result as ItemRow).label).toBe("alpha!");
    });

    it("runs a transform with no params when `args` is omitted", async () => {
      // Scheduling the activity is itself the ask. gqlize's "named but not asked
      // for" reading of a falsy value exists only because its `apply` input lists
      // every exposed transform at once; an activity names exactly one.
      const [item] = (await acts["Item.create"]({ context: ctx, input: { label: "alpha" } })) as ItemRow[];
      await acts["Item.instanceMethods.relabel"]({ context: ctx, id: item.id });
      const after = (await acts["Item.findByPk"]({ context: ctx, id: item.id })) as ItemRow;
      expect(after.label).toBe("alpha!");
    });

    it("still fails non-retryably when a transform addresses a missing row", async () => {
      await expectFailure(
        acts["Item.instanceMethods.relabel"]({ context: ctx, id: 999 }),
        ErrorType.NotFound
      );
    });

    it("requires an id for a transform too", async () => {
      await expectFailure(
        acts["Item.instanceMethods.relabel"]({ context: ctx }),
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
      const updated = (await acts["Task.update"]({ context: ctx, input: { done: true }, all: true })) as TaskRow[];
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
