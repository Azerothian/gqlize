// The read cache in front of RLS reads (RFC §6.5), Postgres only. The policy's
// filter never shows in the query options, so the key carries the request's
// database identity, and the tags carry every model the policy reads.

import { describe, it, expect, beforeAll } from "@jest/globals";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { rls } from "@azerothian/ormize/rls";
import { testDialect, dialectConfig, trackConnection, createRlsRoleHelper } from "@azerothian/test-fixtures/dialect";
import Database from "../src/manager";
import { MemoryCacheStore } from "../src";

const describePostgres = testDialect() === "postgres" ? describe : describe.skip;

type Ctx = { user?: string };
const as = (user: string): Ctx => ({ user });
const titles = (rows: unknown[]) => (rows as { title: string }[]).map((r) => r.title).sort();
const me = rls.setting("app.user_id", "text");

describePostgres("ormize - read cache under RLS", () => {
  let db: Database;
  const statements: string[] = [];
  const docReads = () => statements.filter((sql) => /SELECT .* FROM "rls_cache_docs"/.test(sql)).length;

  beforeAll(async() => {
    db = new Database({
      cache: { store: new MemoryCacheStore(), onError: (e: unknown) => { throw e; } },
      rls: { manageRoles: true },
    });
    const adapter = trackConnection(new SequelizeAdapter({
      rls: {
        settings: (ctx) => ({ "app.user_id": (ctx as Ctx).user ?? "" }),
        role: (ctx) => ((ctx as Ctx).user ? "app_member" : undefined),
      },
    }, await dialectConfig({ logging: (sql: string) => { statements.push(sql); } })), { suite: true });
    db.registerAdapter(adapter, "pg");
    await db.addDefinition({
      name: "Doc",
      define: { title: { type: Sequelize.STRING, allowNull: false } },
      options: {
        timestamps: false,
        tableName: "rls_cache_docs",
        // Visible to anyone holding a membership of it: the policy reads another table.
        rls: { enabled: true, policies: { member: { for: "select", to: "app_member", using: { memberships: { some: { userId: { eq: me } } } } } } },
      },
      relationships: [{ type: "hasMany", model: "DocMember", name: "memberships", options: { foreignKey: "docId" } }],
    }, "pg");
    await db.addDefinition({
      name: "DocMember",
      define: { userId: { type: Sequelize.STRING }, docId: { type: Sequelize.INTEGER } },
      options: { timestamps: false, tableName: "rls_cache_members" },
    }, "pg");
    await db.initialise();
    await db.sync();
    await createRlsRoleHelper(adapter, ["rls_cache_docs", "rls_cache_members"], ["app_member"]);
    await db.models.Doc.bulkCreate([{ title: "a" }, { title: "b" }]);
    await db.models.DocMember.bulkCreate([{ userId: "u1", docId: 1 }, { userId: "u2", docId: 2 }]);
  });

  it("serves a repeat RLS read from the cache", async() => {
    expect(titles((await db.resolveFindAll("Doc", null, {}, as("u1"))).models)).toEqual(["a"]);
    const before = docReads();
    expect(titles((await db.resolveFindAll("Doc", null, {}, as("u1"))).models)).toEqual(["a"]);
    expect(docReads()).toBe(before);
  });

  it("never serves one identity's rows to another", async() => {
    expect(titles((await db.resolveFindAll("Doc", null, {}, as("u2"))).models)).toEqual(["b"]);
  });

  it("a write to a table the policy reads invalidates the cached read", async() => {
    expect(titles((await db.resolveFindAll("Doc", null, {}, as("u1"))).models)).toEqual(["a"]);
    await db.models.DocMember.destroy({ where: { userId: "u1" } });
    expect(titles((await db.resolveFindAll("Doc", null, {}, as("u1"))).models)).toEqual([]);
  });
});
