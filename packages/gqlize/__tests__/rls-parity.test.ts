// RFC row-security §7/§8 parity: the group-manager rules, enforced by the
// engine on SQLite and by generated Postgres policies alone on Postgres.
//
// One rules tree feeds both `createRoleBasedPermissions` (the engine's scope)
// and `compileRlsPolicies` (the policies `sync()` installs). Every assertion
// below runs on both projects and must see the same rows. On Postgres the
// test connection is a superuser that bypasses RLS, so the adapter switches to
// `app_member` per request; a guard checks the reads carry no scope clause, so
// the Postgres run can't pass because the engine quietly kept filtering.

import Sequelize from "sequelize";
import { graphql } from "graphql";
import type { GraphQLSchema } from "graphql";
import { Ormize as Database, ScopeEscapeError } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import createRoleBasedPermissions, { compileRlsPolicies } from "@azerothian/utilize/permissions";
import type { RoleRules } from "@azerothian/utilize/permissions";
import type { Definition } from "@azerothian/utilize";
import { createRlsRoleHelper, dialectConfig, trackConnection } from "@azerothian/test-fixtures/dialect";
import { describe, it, expect, beforeAll } from "@jest/globals";

import { createSchema } from "../src";
import { currentDialect } from "./helper/dialect";

const postgres = currentDialect() === "postgres";

const managesUser = {
  via: "memberships.group.memberships",
  match: { userId: "$principal.id", role: "manager" },
};

const rules: RoleRules = {
  member: {
    model: "allow",
    query: "allow",
    mutation: "allow",
    field: "allow",
    scope: {
      User: { any: [{ own: "id" }, managesUser] },
      Group: { via: "memberships", match: { userId: "$principal.id" } },
      Membership: {
        read: { via: "group.memberships", match: { userId: "$principal.id" } },
        write: {
          all: [
            { via: "group.memberships", match: { userId: "$principal.id", role: "manager" } },
            { not: { own: "userId" } },
          ],
        },
      },
    },
  },
};

const policies = compileRlsPolicies(rules, {
  dbRole: () => "app_member",
  settings: { id: "app.user_id" },
  settingTypes: { id: "integer" },
});

const rlsOf = (model: string) => (postgres ? { rls: { enabled: true, policies: policies[model] } } : {});

const UserDef: Definition = {
  name: "User",
  define: { name: { type: Sequelize.STRING, allowNull: false } },
  options: { timestamps: false, tableName: "pm_users", ...rlsOf("User") },
  relationships: [{ type: "hasMany", model: "Membership", name: "memberships", options: { foreignKey: "userId" } }],
};
const GroupDef: Definition = {
  name: "Group",
  define: { name: { type: Sequelize.STRING, allowNull: false } },
  options: { timestamps: false, tableName: "pm_groups", ...rlsOf("Group") },
  relationships: [{ type: "hasMany", model: "Membership", name: "memberships", options: { foreignKey: "groupId" } }],
};
const MembershipDef: Definition = {
  name: "Membership",
  define: {
    userId: { type: Sequelize.INTEGER, allowNull: false, writable: true },
    groupId: { type: Sequelize.INTEGER, allowNull: false, writable: true },
    role: { type: Sequelize.STRING, allowNull: false },
  },
  options: { timestamps: false, tableName: "pm_memberships", ...rlsOf("Membership") },
  relationships: [
    { type: "belongsTo", model: "User", name: "user", options: { foreignKey: "userId" } },
    { type: "belongsTo", model: "Group", name: "group", options: { foreignKey: "groupId" } },
  ],
};

// alice manages G1 (bob, erin); dave manages G2 (carol, erin).
const ALICE = 1, BOB = 2, CAROL = 3, DAVE = 4, ERIN = 5;
const G1 = 1, G2 = 2;

type Ctx = { user?: { id: number } };
const as = (id?: number): Ctx => (id === undefined ? {} : { user: { id } });

describe("gqlize - group-manager rules: engine on SQLite, policies on Postgres", () => {
  let db: Database;
  let schema: GraphQLSchema;
  let adapter: SequelizeAdapter;
  const statements: string[] = [];

  beforeAll(async() => {
    db = new Database({
      permission: createRoleBasedPermissions("member", rules, { principal: (ctx) => (ctx as Ctx).user }),
      rls: { manageRoles: true },
    });
    adapter = trackConnection(new SequelizeAdapter(postgres
      ? {
        rls: {
          settings: (ctx) => ({ "app.user_id": String((ctx as Ctx).user?.id ?? "") }),
          role: (ctx) => ((ctx as Ctx).user ? "app_member" : undefined),
        },
      }
      : {}, await dialectConfig({ logging: (sql: string) => { statements.push(sql); } })), { suite: true });
    db.registerAdapter(adapter as never, "main");
    await db.addDefinition(UserDef, "main");
    await db.addDefinition(GroupDef, "main");
    await db.addDefinition(MembershipDef, "main");
    await db.initialise();
    await db.sync();
    if (postgres) {
      await createRlsRoleHelper(adapter, ["pm_users", "pm_groups", "pm_memberships"], ["app_member"]);
      for (const table of ["pm_users", "pm_groups", "pm_memberships"]) {
        await adapter.sequelize.query(`GRANT USAGE, SELECT ON SEQUENCE "${table}_id_seq" TO "app_member"`);
      }
    }
    // Seed as the connection itself, bypassing scope and RLS.
    const models = adapter.sequelize.models;
    await models.User.bulkCreate(["alice", "bob", "carol", "dave", "erin"].map((name) => ({ name })));
    await models.Group.bulkCreate([{ name: "G1" }, { name: "G2" }]);
    await models.Membership.bulkCreate([
      { userId: ALICE, groupId: G1, role: "manager" },
      { userId: BOB, groupId: G1, role: "member" },
      { userId: ERIN, groupId: G1, role: "member" },
      { userId: DAVE, groupId: G2, role: "manager" },
      { userId: CAROL, groupId: G2, role: "member" },
      { userId: ERIN, groupId: G2, role: "member" },
    ]);
    schema = await createSchema(db);
  });

  const names = async(model: "User" | "Group", user?: number) => {
    const result = await graphql({
      schema,
      source: `query { models { ${model} { edges { node { name } } } } }`,
      contextValue: as(user),
    }) as { errors?: unknown[]; data: { models: { [m: string]: { edges: { node: { name: string } }[] } } } };
    expect(result.errors).toBeUndefined();
    return result.data.models[model].edges.map((e) => e.node.name).sort();
  };

  const memberships = async(user?: number) => {
    const rows = (await db.resolveFindAll("Membership", null, {}, as(user))).models as { userId: number; groupId: number }[];
    return rows.map((r) => `${r.userId}@${r.groupId}`).sort();
  };

  it("users: yourself, plus everyone in a group you manage", async() => {
    expect(await names("User", ALICE)).toEqual(["alice", "bob", "erin"]);
    expect(await names("User", BOB)).toEqual(["bob"]);
    expect(await names("User", DAVE)).toEqual(["carol", "dave", "erin"]);
    expect(await names("User", ERIN)).toEqual(["erin"]);
    expect(await names("User")).toEqual([]);
  });

  it("groups: the ones you belong to", async() => {
    expect(await names("Group", ALICE)).toEqual(["G1"]);
    expect(await names("Group", ERIN)).toEqual(["G1", "G2"]);
    expect(await names("Group", CAROL)).toEqual(["G2"]);
  });

  it("memberships: every membership of your groups", async() => {
    expect(await memberships(BOB)).toEqual([`${ALICE}@${G1}`, `${BOB}@${G1}`, `${ERIN}@${G1}`]);
    expect(await memberships(ERIN)).toHaveLength(6);
  });

  it("leaves Postgres reads to the policy", async() => {
    statements.length = 0;
    await names("User", ALICE);
    const reads = statements.filter((sql) => /FROM [`"]pm_users[`"]/.test(sql));
    expect(reads.length).toBeGreaterThan(0);
    // The engine's compiled scope would reach pm_memberships from the read.
    expect(reads.some((sql) => sql.includes("pm_memberships"))).toBe(!postgres);
  });

  it("an update reaches only the users you can manage", async() => {
    const updated = await db.processUpdate("User", null, { where: {}, input: { name: "touched" } }, as(BOB));
    expect(updated).toHaveLength(1);
    const all = await adapter.sequelize.models.User.findAll({ order: [["id", "ASC"]] });
    expect(all.map((r) => (r as unknown as { name: string }).name)).toEqual(["alice", "touched", "carol", "dave", "erin"]);
    await adapter.sequelize.models.User.update({ name: "bob" }, { where: { id: BOB } });
  });

  it("a manager adds someone to their own group", async() => {
    const created = await db.processCreate("Membership", null, { input: { userId: CAROL, groupId: G1, role: "member" } }, as(ALICE));
    expect(created).toHaveLength(1);
    expect(await names("User", ALICE)).toEqual(["alice", "bob", "carol", "erin"]);
    await adapter.sequelize.models.Membership.destroy({ where: { userId: CAROL, groupId: G1 } });
  });

  it("refuses a membership in a group you don't manage, for yourself, or by a plain member", async() => {
    const attempt = (by: number, userId: number, groupId: number) =>
      db.processCreate("Membership", null, { input: { userId, groupId, role: "manager" } }, as(by));
    // Each is the policy's WITH CHECK on Postgres (42501) and the engine's
    // post-create re-check on SQLite; both surface as a scope escape.
    await expect(attempt(ALICE, CAROL, G2)).rejects.toThrow(ScopeEscapeError);
    // Alice is no manager of G2, and the row she is creating, which says she
    // is, must not count as evidence for itself.
    await expect(attempt(ALICE, ALICE, G2)).rejects.toThrow(ScopeEscapeError);
    // Never your own membership, even in a group you do manage.
    await expect(attempt(ALICE, ALICE, G1)).rejects.toThrow(ScopeEscapeError);
    await expect(attempt(BOB, CAROL, G1)).rejects.toThrow(ScopeEscapeError);
    expect(await adapter.sequelize.models.Membership.count()).toEqual(6);
  });

  (postgres ? describe : describe.skip)("postgres only", () => {
    it("the connection's own role sees every row, so the role switch is what is tested", async() => {
      expect(await adapter.sequelize.models.User.count()).toEqual(5);
    });

    it("a second sync changes nothing", async() => {
      const executed = await adapter.syncRowSecurity(
        { User: UserDef, Group: GroupDef, Membership: MembershipDef }, { manageRoles: true },
      );
      expect(executed.filter((sql) => !sql.startsWith("SELECT pg_advisory_xact_lock"))).toEqual([]);
    });
  });
});
