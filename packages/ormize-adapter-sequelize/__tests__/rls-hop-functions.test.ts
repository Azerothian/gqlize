// Relationship hops into RLS tables (`HopFunctionRegistry` in
// `src/rls/compile-policy.ts`): a policy that follows a relationship into a
// table with RLS runs that hop through a generated SECURITY DEFINER function.
// Without it these two policies are infinite recursion in Postgres (each
// table's policy reads the other's table, and Membership's reads itself).
// Postgres project only.

import { describe, it, expect, beforeAll } from "@jest/globals";
import { DataTypes, QueryTypes } from "sequelize";
import { ScopeConfigurationError } from "@azerothian/utilize/gate";
import { testDialect, dialectConfig, trackConnection, createRlsRoleHelper } from "@azerothian/test-fixtures/dialect";
import type { RlsRoleHelper } from "@azerothian/test-fixtures/dialect";
import SequelizeAdapter from "../src/index";
import { rls } from "@azerothian/ormize/rls";
import type { Definition } from "@azerothian/utilize/types/index";

const describePostgres = testDialect() === "postgres" ? describe : describe.skip;

const me = rls.setting("app.user_id", "integer");

const definitions = (membershipRead: object = { group: { is: { memberships: { some: { userId: { eq: me } } } } } }) => ({
  Group: {
    name: "Group",
    define: {},
    options: {
      rls: { enabled: true, policies: { read: { for: "select", to: "hop_member", using: { memberships: { some: { userId: { eq: me } } } } } } },
    },
  },
  Membership: {
    name: "Membership",
    define: {},
    options: { rls: { enabled: true, policies: { read: { for: "select", to: "hop_member", using: membershipRead } } } },
  },
} as unknown as { [name: string]: Definition });

async function defineModels(adapter: SequelizeAdapter) {
  const Group = adapter.sequelize.define("Group", { name: DataTypes.STRING }, { timestamps: false, tableName: "hop_groups" });
  const Membership = adapter.sequelize.define("Membership", {
    name: DataTypes.STRING, userId: DataTypes.INTEGER, groupId: DataTypes.INTEGER,
  }, { timestamps: false, tableName: "hop_memberships" });
  Group.hasMany(Membership, { as: "memberships", foreignKey: "groupId" });
  Membership.belongsTo(Group, { as: "group", foreignKey: "groupId" });
  await adapter.sequelize.sync({ force: true });
  return { Group, Membership };
}

type Proc = { proname: string; prosecdef: boolean; proconfig: string[] | null; public_exec: boolean; member_exec: boolean };

describePostgres("RLS policies that follow relationships into RLS tables", () => {
  let adapter: SequelizeAdapter;
  let roles: RlsRoleHelper;

  const hopFunctions = () => adapter.sequelize.query(
    `SELECT p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
       has_function_privilege('hop_member', p.oid, 'EXECUTE') AS member_exec
     FROM pg_proc p WHERE p.proname LIKE 'gqlize\\_rls\\_%' ORDER BY p.proname`,
    { type: QueryTypes.SELECT },
  ) as unknown as Promise<Proc[]>;

  const visible = async(user: number, table: string) => {
    let names: string[] = [];
    await roles.asRole("hop_member", { "app.user_id": String(user) }, async({ transaction }) => {
      const rows = await adapter.sequelize.query<{ name: string }>(`SELECT name FROM "${table}" ORDER BY name`,
        { type: QueryTypes.SELECT, transaction: transaction as never });
      names = rows.map((r) => r.name);
    });
    return names;
  };

  beforeAll(async() => {
    adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()), { suite: true });
    const { Group, Membership } = await defineModels(adapter);
    await Group.bulkCreate([{ name: "g1" }, { name: "g2" }]);
    await Membership.bulkCreate([
      { name: "1@g1", userId: 1, groupId: 1 },
      { name: "2@g1", userId: 2, groupId: 1 },
      { name: "2@g2", userId: 2, groupId: 2 },
      { name: "3@g2", userId: 3, groupId: 2 },
    ]);
    await adapter.syncRowSecurity(definitions(), { manageRoles: true });
    roles = await createRlsRoleHelper(adapter, ["hop_groups", "hop_memberships"], ["hop_member"]);
  });

  it("answers through the hop functions instead of recursing", async() => {
    expect(await visible(1, "hop_groups")).toEqual(["g1"]);
    expect(await visible(2, "hop_groups")).toEqual(["g1", "g2"]);
    expect(await visible(1, "hop_memberships")).toEqual(["1@g1", "2@g1"]);
    expect(await visible(3, "hop_memberships")).toEqual(["2@g2", "3@g2"]);
    expect(await visible(9, "hop_memberships")).toEqual([]);
  });

  it("defines them SECURITY DEFINER, with a pinned search_path, executable only by the policy's role", async() => {
    const procs = await hopFunctions();
    expect(procs.length).toBeGreaterThan(0);
    for (const proc of procs) {
      expect(proc.prosecdef).toBe(true);
      expect(proc.proconfig?.[0]).toMatch(/^search_path=pg_catalog, .*pg_temp$/);
      expect(proc.public_exec).toBe(false);
      expect(proc.member_exec).toBe(true);
    }
  });

  it("a second sync changes nothing", async() => {
    const executed = await adapter.syncRowSecurity(definitions(), { manageRoles: true });
    expect(executed.filter((q) => /^(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE)/.test(q))).toEqual([]);
  });

  it("drops a hop function no policy calls any more", async() => {
    const before = (await hopFunctions()).map((p) => p.proname);
    // Membership now visible by its own userId: no hop at all.
    await adapter.syncRowSecurity(definitions({ userId: { eq: me } }), { manageRoles: true });
    const after = (await hopFunctions()).map((p) => p.proname);
    expect(after.length).toBe(before.length - 1);
    expect(await visible(1, "hop_memberships")).toEqual(["1@g1"]);
    // Group's hop now reads a table whose policy no longer reads back.
    expect(await visible(2, "hop_groups")).toEqual(["g1", "g2"]);
    await adapter.syncRowSecurity(definitions(), { manageRoles: true });
    expect((await hopFunctions()).map((p) => p.proname).sort()).toEqual([...before].sort());
  });

  it("refuses an owner that would be subject to RLS itself", async() => {
    const plain = trackConnection(new SequelizeAdapter({
      rls: { settings: () => ({}), role: () => undefined, bypassRole: "hop_plain" },
    }, await dialectConfig()), { suite: true });
    await defineModels(plain);
    await plain.sequelize.query(`CREATE ROLE "hop_plain" NOLOGIN`);
    await expect(plain.syncRowSecurity(definitions(), { manageRoles: true })).rejects.toThrow(ScopeConfigurationError);
    await plain.sequelize.query(`ALTER ROLE "hop_plain" BYPASSRLS`);
    await plain.sequelize.query(`GRANT "hop_plain" TO CURRENT_USER`);
    await plain.syncRowSecurity(definitions(), { manageRoles: true });
    const [owner] = await plain.sequelize.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname LIKE 'gqlize\\_rls\\_%'`,
      { type: QueryTypes.SELECT },
    );
    expect(owner.owner).toBe("hop_plain");
  });

  it("rls:sql creates the same functions, and sync then has nothing to do", async() => {
    const script = adapter.generateRlsSql(definitions(), { manageRoles: true });
    for (const proc of await hopFunctions()) {
      await adapter.sequelize.query(`DROP POLICY IF EXISTS "hop_groups_read" ON "hop_groups"`);
      await adapter.sequelize.query(`DROP POLICY IF EXISTS "hop_memberships_read" ON "hop_memberships"`);
      await adapter.sequelize.query(`DROP FUNCTION "public"."${proc.proname}"()`);
    }
    await adapter.sequelize.query(script);
    expect(await visible(2, "hop_groups")).toEqual(["g1", "g2"]);
    const executed = await adapter.syncRowSecurity(definitions(), { manageRoles: true });
    expect(executed.filter((q) => /^(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE)/.test(q))).toEqual([]);
  });
});
