// `rls.softDeleteFlag` (RFC §6.8), Postgres only: a SELECT policy that hides
// soft-deleted rows behind a flag the adapter raises, against every soft-delete
// path the engine has. Without the flag the same policy breaks them (the
// control at the bottom), which is the table in §6.8.

import { describe, it, expect, beforeAll } from "@jest/globals";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { sql } from "@azerothian/ormize/rls";
import { testDialect, dialectConfig, trackConnection, createRlsRoleHelper } from "@azerothian/test-fixtures/dialect";
import Database from "../src/manager";

const describePostgres = testDialect() === "postgres" ? describe : describe.skip;

type Ctx = { user?: string };
type Row = { title: string };
const titles = (rows: unknown) => (rows as Row[]).map((r) => r.title).sort();
const u1: Ctx = { user: "u1" };

async function build(flag: boolean, table: string) {
  const db = new Database({ rls: { manageRoles: true } });
  const adapter = trackConnection(new SequelizeAdapter({
    rls: {
      settings: (ctx) => ({ "app.user_id": (ctx as Ctx).user ?? "" }),
      role: (ctx) => ((ctx as Ctx).user ? "app_member" : undefined),
      ...(flag ? { softDeleteFlag: "app.include_deleted" } : {}),
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
      paranoid: true,
      tableName: table,
      rls: {
        enabled: true,
        policies: {
          see: {
            for: "select", to: "app_member",
            using: sql`"ownerId" = (SELECT nullif(current_setting('app.user_id', true), ''))
              AND ("deletedAt" IS NULL OR current_setting('app.include_deleted', true) = 'on')`,
          },
          write: { for: "update", to: "app_member", using: sql`"ownerId" = (SELECT nullif(current_setting('app.user_id', true), ''))` },
          remove: { for: "delete", to: "app_member", using: sql`"ownerId" = (SELECT nullif(current_setting('app.user_id', true), ''))` },
          add: { for: "insert", to: "app_member", withCheck: sql`"ownerId" = (SELECT nullif(current_setting('app.user_id', true), ''))` },
        },
      },
    },
  }, "pg");
  await db.initialise();
  await db.sync();
  await createRlsRoleHelper(adapter, [table], ["app_member"]);
  await db.models.Task.bulkCreate([
    { title: "live", ownerId: "u1" },
    { title: "gone", ownerId: "u1" },
    { title: "theirs", ownerId: "u2" },
  ]);
  await db.models.Task.destroy({ where: { title: "gone" } });
  return db;
}

describePostgres("ormize - rls.softDeleteFlag", () => {
  let db: Database;

  beforeAll(async() => {
    db = await build(true, "rls_flag_tasks");
  });

  const read = (deleted?: "INCLUDE" | "ONLY") =>
    db.resolveFindAll("Task", null, deleted ? { deleted } : {}, u1).then((r) => titles(r.models));

  it("reads deleted rows when asked to, and only then", async() => {
    expect(await read()).toEqual(["live"]);
    expect(await read("INCLUDE")).toEqual(["gone", "live"]);
    expect(await read("ONLY")).toEqual(["gone"]);
  });

  it("restores a soft-deleted row", async() => {
    expect(titles(await db.processRestore("Task", null, { title: { eq: "gone" } }, u1))).toEqual(["gone"]);
    expect(await read()).toEqual(["gone", "live"]);
  });

  it("soft deletes, where the new row is one the policy would hide", async() => {
    expect(titles(await db.processDelete("Task", null, { title: { eq: "gone" } }, u1))).toEqual(["gone"]);
    expect(await read()).toEqual(["live"]);
    expect(await read("ONLY")).toEqual(["gone"]);
  });

  it("the owner rule still holds with the flag on", async() => {
    expect(await read("INCLUDE")).not.toContain("theirs");
    expect(await db.processDelete("Task", null, { title: { eq: "theirs" } }, u1)).toEqual([]);
  });
});

describePostgres("ormize - the same policy without the flag", () => {
  let db: Database;

  beforeAll(async() => {
    db = await build(false, "rls_noflag_tasks");
  });

  it("can't see deleted rows or soft delete, as RFC §6.8 measured", async() => {
    expect(titles((await db.resolveFindAll("Task", null, { deleted: "ONLY" }, u1)).models)).toEqual([]);
    await expect(db.processDelete("Task", null, { title: { eq: "live" } }, u1)).rejects.toThrow(/6\.8/);
  });
});
