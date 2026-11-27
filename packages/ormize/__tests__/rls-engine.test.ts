// Database enforcement through the engine (RFC §6.5/§6.6), Postgres only.
//
// The adapter suites prove the mechanics (settings, `SET LOCAL ROLE`, policy
// SQL). This one proves the engine leaves row filtering to the database only
// where the database actually has an identity to filter by, and keeps its own
// scope everywhere else. The connection here is PGlite's superuser, which
// bypasses RLS, so any read that runs without the role switch AND without the
// engine's scope returns every row: each test below fails that way if the
// guarantee it pins breaks.

import { describe, it, expect, beforeAll } from "@jest/globals";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { rls } from "@azerothian/ormize/rls";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { testDialect, dialectConfig, trackConnection, createRlsRoleHelper } from "@azerothian/test-fixtures/dialect";
import Database from "../src/manager";
import { MemoryCacheStore } from "../src";

const describePostgres = testDialect() === "postgres" ? describe : describe.skip;

type Row = { title: string };
const titles = (rows: unknown[]) => (rows as Row[]).map((r) => r.title).sort();
const as = (user?: string) => (user ? { user } : {});

// The engine-side rule, identical in meaning to the policy below.
const ownScope: ScopePredicate = (_defName, operation, _options, context) => {
  const user = (context as { user?: string }).user;
  if (!user) {
    return false;
  }
  return operation === "create" ? { set: { ownerId: user } } : { where: { ownerId: { eq: user } } };
};

describePostgres("ormize - database enforcement under RLS", () => {
  let db: Database;
  let adapter: SequelizeAdapter;
  const statements: string[] = [];

  beforeAll(async() => {
    db = new Database({
      permission: { scope: ownScope },
      cache: { store: new MemoryCacheStore(), onError: (e: unknown) => { throw e; } },
      rls: { manageRoles: true },
    });
    const config = await dialectConfig({
      logging: (sql: string) => { statements.push(sql); },
    });
    adapter = trackConnection(new SequelizeAdapter({
      rls: {
        settings: (ctx) => ({ "app.user_id": (ctx as { user?: string }).user ?? "" }),
        role: (ctx) => ((ctx as { user?: string }).user ? "app_member" : undefined),
      },
    }, config), { suite: true });
    db.registerAdapter(adapter, "pg");
    await db.addDefinition({
      name: "Task",
      define: {
        title: { type: Sequelize.STRING, allowNull: false },
        ownerId: { type: Sequelize.STRING, allowNull: true },
      },
      options: {
        timestamps: false,
        tableName: "rls_tasks",
        rls: {
          enabled: true,
          policies: {
            own: { for: "all", to: "app_member", using: { ownerId: { eq: rls.setting("app.user_id", "text") } } },
          },
        },
      },
    }, "pg");
    await db.initialise();
    await db.sync();
    await createRlsRoleHelper(adapter, ["rls_tasks"], ["app_member"]);
    await adapter.sequelize.query(`GRANT USAGE, SELECT ON SEQUENCE "rls_tasks_id_seq" TO "app_member"`);
    await db.models.Task.bulkCreate([
      { title: "u1-a", ownerId: "u1" },
      { title: "u1-b", ownerId: "u1" },
      { title: "u2-a", ownerId: "u2" },
    ]);
  });

  it("each principal sees only its own rows, twice over with the cache on", async() => {
    for (let round = 0; round < 2; round++) {
      expect(titles((await db.resolveFindAll("Task", null, {}, as("u1"))).models)).toEqual(["u1-a", "u1-b"]);
      expect(titles((await db.resolveFindAll("Task", null, {}, as("u2"))).models)).toEqual(["u2-a"]);
    }
  });

  it("leaves the filtering to the policy: the read carries no scope clause", async() => {
    statements.length = 0;
    const result = await db.resolveFindAll("Task", null, { where: { title: { like: "u1%" } } }, as("u1"));
    expect(titles(result.models)).toEqual(["u1-a", "u1-b"]);
    const reads = statements.filter((sql) => /SELECT .* FROM "rls_tasks"/.test(sql));
    expect(reads.length).toBeGreaterThan(0);
    // The column list names ownerId either way; the scope would show up in WHERE.
    const whereOf = (sql: string) => sql.slice(sql.indexOf(" WHERE ") + 1);
    expect(reads.every((sql) => sql.includes(" WHERE "))).toBe(true);
    expect(reads.some((sql) => whereOf(sql).includes("ownerId"))).toBe(false);
    expect(statements.some((sql) => /SET LOCAL ROLE "app_member"/.test(sql))).toBe(true);
  });

  it("refuses a request with no identity instead of running under the connection's role", async() => {
    statements.length = 0;
    const result = await db.resolveFindAll("Task", null, {}, as());
    expect(result.models).toEqual([]);
    expect(statements.some((sql) => /FROM "rls_tasks"/.test(sql))).toBe(false);
  });

  it("keeps the engine's scope on a transaction the adapter didn't open with an identity", async() => {
    // A caller's own Sequelize transaction: no settings, no role switch, and
    // the superuser connection bypasses RLS. Only the engine scope stands
    // between u1 and u2's row, so it must still be applied.
    await adapter.sequelize.transaction(async(transaction) => {
      const result = await db.resolveFindAll("Task", null, {}, { user: "u1", transaction });
      expect(titles(result.models)).toEqual(["u1-a", "u1-b"]);
    });
  });

  it("keeps the engine's scope when the principal differs from the one the transaction was opened for", async() => {
    // A transaction this adapter opened with u1's identity, then reused by a
    // request for u2: the database would filter as u1, so the engine must not
    // leave u2's read to it.
    const tx = await adapter.beginTransaction({ user: "u1" });
    try {
      const result = await db.resolveFindAll("Task", null, {}, { user: "u2", transaction: tx.handle });
      expect(titles(result.models)).toEqual([]);
    } finally {
      await tx.rollback();
    }
  });

  it("a write leaves out-of-scope rows alone", async() => {
    const updated = await db.processUpdate("Task", null, { where: {}, input: { title: "changed" } }, as("u2"));
    expect(titles(updated)).toEqual(["changed"]);
    const all = await db.models.Task.findAll({ order: [["id", "ASC"]] });
    expect(all.map((r: { title: string }) => r.title)).toEqual(["u1-a", "u1-b", "changed"]);
  });
});
