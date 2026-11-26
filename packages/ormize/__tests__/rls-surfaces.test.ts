// The surfaces that hold the model directly, under RLS (RFC §6.5), and
// `orm.asSystem`. Postgres only.
//
// The connection here is PGlite's superuser, which bypasses RLS: a statement
// that runs off the request's transaction sees every row, so each assertion
// that a caller sees only its own rows also proves the statement ran on the
// transaction the engine opened with the caller's settings and role.

import { describe, it, expect, beforeAll } from "@jest/globals";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { rls } from "@azerothian/ormize/rls";
import { scopeAware, unscoped } from "@azerothian/utilize/gate";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { testDialect, dialectConfig, trackConnection, createRlsRoleHelper } from "@azerothian/test-fixtures/dialect";
import Database from "../src/manager";
import { ScopeDeniedError } from "../src";

const describePostgres = testDialect() === "postgres" ? describe : describe.skip;

type Row = { title: string };
type Ctx = { user?: string; transaction?: unknown };
const titles = (rows: unknown) => (rows as Row[]).map((r) => r.title).sort();
const as = (user?: string): Ctx => (user ? { user } : {});

const ownScope: ScopePredicate = (_defName, operation, _options, context) => {
  const user = (context as Ctx).user;
  if (!user) {
    return false;
  }
  return operation === "create" ? { set: { ownerId: user } } : { where: { ownerId: { eq: user } } };
};

type ModelStatic = { findAll(options: object): Promise<unknown[]> };

async function build(options: { bypass: boolean }) {
  const db = new Database({ permission: { scope: ownScope }, rls: { manageRoles: true } });
  const adapter = trackConnection(new SequelizeAdapter({
    rls: {
      settings: (ctx) => ({ "app.user_id": (ctx as Ctx).user ?? "" }),
      role: (ctx) => ((ctx as Ctx).user ? "app_member" : undefined),
      ...(options.bypass ? { bypassRole: "app_bypass" } : {}),
    },
  }, await dialectConfig()), { suite: true });
  db.registerAdapter(adapter, "pg");
  await db.addDefinition({
    name: "Task",
    define: {
      title: { type: Sequelize.STRING, allowNull: false },
      ownerId: { type: Sequelize.STRING, allowNull: true },
    },
    options: {
      timestamps: false,
      tableName: "rls_surface_tasks",
      rls: {
        enabled: true,
        policies: { own: { for: "all", to: "app_member", using: { ownerId: { eq: rls.setting("app.user_id", "text") } } } },
      },
      classMethods: {
        // No `:scope…` parameter and no declaration: under RLS the statement
        // runs on the request's transaction and the policy filters it.
        // A descriptor, which `Definition.classMethods` doesn't name in its type.
        rawTitles: { type: "query", query: "SELECT title FROM rls_surface_tasks ORDER BY title" } as never,
        // A function method queries through the transaction it is handed.
        viaTransaction: scopeAware(async function(this: ModelStatic, _args: unknown, context: Ctx) {
          return this.findAll({ transaction: context.transaction });
        }),
        // Declared to see past the row rules.
        everything: unscoped(async function(this: ModelStatic, _args: unknown, context: Ctx) {
          return this.findAll({ transaction: context.transaction });
        }),
      },
    },
  }, "pg");
  // Same scope, no RLS: here the engine is the only thing filtering.
  await db.addDefinition({
    name: "Note",
    define: {
      title: { type: Sequelize.STRING, allowNull: false },
      ownerId: { type: Sequelize.STRING, allowNull: true },
    },
    options: { timestamps: false, tableName: "rls_surface_notes" },
  }, "pg");
  await db.initialise();
  await db.sync();
  await createRlsRoleHelper(adapter, ["rls_surface_tasks"], ["app_member", "app_bypass"]);
  await adapter.sequelize.query(`ALTER ROLE "app_bypass" BYPASSRLS`);
  await db.models.Task.bulkCreate([
    { title: "u1-a", ownerId: "u1" },
    { title: "u1-b", ownerId: "u1" },
    { title: "u2-a", ownerId: "u2" },
  ]);
  await db.models.Note.bulkCreate([{ title: "n-u1", ownerId: "u1" }, { title: "n-u2", ownerId: "u2" }]);
  return db;
}

describePostgres("ormize - class methods and asSystem under RLS", () => {
  let db: Database;
  let plain: Database;

  beforeAll(async() => {
    db = await build({ bypass: true });
    plain = await build({ bypass: false });
  });

  it("a raw-SQL class method answers to the policy, with no :scope parameter", async() => {
    expect(titles(await db.resolveClassMethod("Task", "rawTitles", {}, as("u1")))).toEqual(["u1-a", "u1-b"]);
    expect(titles(await db.resolveClassMethod("Task", "rawTitles", {}, as("u2")))).toEqual(["u2-a"]);
  });

  it("a function class method is handed the request's RLS transaction", async() => {
    expect(titles(await db.resolveClassMethod("Task", "viaTransaction", {}, as("u2")))).toEqual(["u2-a"]);
  });

  it("refuses a class method on an RLS model when the request has no identity", async() => {
    await expect(db.resolveClassMethod("Task", "rawTitles", {}, as())).rejects.toThrow(ScopeDeniedError);
  });

  it("an unscoped class method runs under bypassRole when there is one", async() => {
    expect(titles(await db.resolveClassMethod("Task", "everything", {}, as("u1")))).toEqual(["u1-a", "u1-b", "u2-a"]);
  });

  it("without a bypassRole, an unscoped class method runs as the request and sees less", async() => {
    expect(titles(await plain.resolveClassMethod("Task", "everything", {}, as("u1")))).toEqual(["u1-a", "u1-b"]);
  });

  it("asSystem reads every row through the engine, under bypassRole", async() => {
    const rows = await db.asSystem((system) => db.resolveFindAll("Task", null, {}, system));
    expect(titles(rows.models)).toEqual(["u1-a", "u1-b", "u2-a"]);
  });

  it("asSystem is unscoped on a model the engine filters, too", async() => {
    expect(titles((await db.resolveFindAll("Note", null, {}, as("u1"))).models)).toEqual(["n-u1"]);
    const rows = await db.asSystem((system) => db.resolveFindAll("Note", null, {}, system));
    expect(titles(rows.models)).toEqual(["n-u1", "n-u2"]);
  });

  it("asSystem refuses to start without a bypassRole", async() => {
    let ran = false;
    await expect(plain.asSystem(() => { ran = true; return Promise.resolve(); })).rejects.toThrow(/bypassRole/);
    expect(ran).toBe(false);
  });

  it("a request can't pass itself off as the system", async() => {
    const forged = JSON.parse(JSON.stringify({ ...as("u1"), system: true })) as Ctx;
    expect(titles((await db.resolveFindAll("Task", null, {}, forged)).models)).toEqual(["u1-a", "u1-b"]);
  });
});
