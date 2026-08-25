import Sequelize from "sequelize";
import { Ormize, sequelizeHookList } from "@azerothian/ormize";
import SequelizeAdapter from "../src";
import { describe, expect, it, jest } from "@jest/globals";

const TaskDef = {
  name: "Task",
  define: {
    title: { type: Sequelize.STRING, allowNull: false },
  },
};

/**
 * The names in `sequelizeHookList` fire off the Sequelize *instance*. Passing
 * them to `sequelize.define` is accepted and stores them under
 * `Model.options.hooks`, where nothing ever reads them — see #45. These tests
 * pin the call counts so that cannot regress silently.
 */
async function build(globalHooks: Record<string, unknown> = {}, def: Record<string, unknown> = TaskDef) {
  const adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
  const db = new Ormize({ globalHooks } as never).registerAdapter(adapter).define(def as never);
  await db.initialise();
  await db.sync();
  return { db, adapter };
}

describe("Sequelize-instance hooks", () => {
  it("fires globalHooks.beforeQuery for every query, including raw SQL", async () => {
    const calls: Record<string, number> = {};
    const bump = (name: string) => () => { calls[name] = (calls[name] || 0) + 1; };

    const { db, adapter } = await build({
      // instance-level
      beforeQuery: bump("beforeQuery"),
      afterQuery: bump("afterQuery"),
      beforeBulkSync: bump("beforeBulkSync"),
      afterBulkSync: bump("afterBulkSync"),
      // model-level controls
      beforeCreate: bump("beforeCreate"),
      beforeFind: bump("beforeFind"),
      beforeSync: bump("beforeSync"),
    });

    const Task = db.getModel("Task") as never as { create(v: unknown): Promise<unknown>; findAll(): Promise<unknown[]> };
    await Task.create({ title: "a" });
    await Task.findAll();
    await adapter.sequelize.query("SELECT * FROM Tasks");
    await adapter.sequelize.query("SELECT * FROM Tasks", {
      model: adapter.sequelize.models.Task,
      mapToModel: true,
    });

    // The point of #45: these used to be 0 no matter what the caller registered.
    expect(calls.beforeQuery).toBeGreaterThan(0);
    expect(calls.afterQuery).toBeGreaterThan(0);
    expect(calls.beforeBulkSync).toBeGreaterThan(0);
    expect(calls.afterBulkSync).toBeGreaterThan(0);

    // Controls: real model hooks are unaffected by the split.
    expect(calls.beforeCreate).toBeGreaterThan(0);
    expect(calls.beforeFind).toBeGreaterThan(0);
    expect(calls.beforeSync).toBeGreaterThan(0);
  });

  it("no longer files instance-hook names on the model", async () => {
    const { adapter } = await build();
    const registered = adapter.sequelize.models.Task.options.hooks as Record<string, unknown[]>;
    for (const name of sequelizeHookList) {
      expect(registered[name]).toBeUndefined();
    }
    // Control: a genuine model hook still gets its slot.
    expect(registered.beforeFind).toBeDefined();
  });

  it("hands the instance hook Sequelize's own arguments", async () => {
    const before: { model?: unknown; sql?: string }[] = [];
    const after: { sql?: string }[] = [];
    const { db, adapter } = await build({
      beforeQuery: (options: { model?: unknown }, query: { sql?: string }) => {
        before.push({ model: options?.model, sql: query?.sql });
      },
      afterQuery: (_options: unknown, query: { sql?: string }) => {
        after.push({ sql: query?.sql });
      },
    });
    await (db.getModel("Task") as never as { findAll(): Promise<unknown[]> }).findAll();

    // `options.model` is the model the query is bound to, and the only handle a
    // raw-SQL guard has on which definition it is about to read.
    const modelled = before.find((b) => b.model === adapter.sequelize.models.Task);
    expect(modelled).toBeDefined();

    // `beforeQuery` runs before `query.run(sql)`, so the statement is not on the
    // Query object yet and `sql` is a local in `Sequelize#query` with the
    // replacements already interpolated: the hook can inspect and throw, never
    // rewrite. By `afterQuery` the Query is carrying it.
    expect(modelled?.sql).toBeUndefined();
    expect(after.some((a) => (a.sql || "").startsWith("SELECT"))).toBe(true);
  });

  it("picks up a hook added after initialise()", async () => {
    let seen = 0;
    const { db } = await build();
    db.addHook("beforeQuery", () => { seen += 1; });
    await (db.getModel("Task") as never as { findAll(): Promise<unknown[]> }).findAll();
    expect(seen).toBeGreaterThan(0);
  });

  it("warns and ignores a per-definition instance hook", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let fired = 0;
      const { adapter } = await build({}, {
        ...TaskDef,
        hooks: { beforeQuery: () => { fired += 1; }, beforeFind: () => undefined },
      });

      expect(warn).toHaveBeenCalled();
      const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(message).toContain("beforeQuery");
      expect(message).toContain("Task");
      // Ignored, not quietly registered somewhere useless.
      const registered = adapter.sequelize.models.Task.options.hooks as Record<string, unknown[]>;
      expect(registered.beforeQuery).toBeUndefined();
      expect(fired).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("installs the instance hooks once even if initialise() runs again", async () => {
    let calls = 0;
    const { db } = await build({ beforeQuery: () => { calls += 1; } });
    await db.initialise();

    calls = 0;
    await (db.getModel("Task") as never as { findAll(): Promise<unknown[]> }).findAll();
    expect(calls).toBe(1);
  });
});
