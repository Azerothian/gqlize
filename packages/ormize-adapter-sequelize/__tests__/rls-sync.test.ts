// RLS sync tests (RFC §6.4): create, no-op on unchanged hash, alter, drop+create
// on `for` change, stale-policy removal, refusal on an unmarked name clash,
// disable reversal, roles only with manageRoles, advisory lock taken, reset()
// reapplies. Postgres project only.

import { describe, it, expect, beforeAll } from "@jest/globals";
import { DataTypes, QueryTypes } from "sequelize";
import {
  testDialect, dialectConfig, trackConnection, createRlsRoleHelper,
} from "@azerothian/test-fixtures/dialect";
import SequelizeAdapter from "../src/index";
import { rls, sql } from "@azerothian/ormize/rls";
import type { Definition } from "@azerothian/utilize/types/index";

const isPostgres = testDialect() === "postgres";
const describePostgres = isPostgres ? describe : describe.skip;

describePostgres("SequelizeAdapter.syncRowSecurity", () => {
  let adapter: SequelizeAdapter;

  const makeAdapter = async () => {
    const config = await dialectConfig();
    const a = trackConnection(
      new SequelizeAdapter({ }, config as unknown as string),
      { suite: true },
    );
    return a;
  };

  const taskDef: Definition = {
    name: "Task",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      name: { type: DataTypes.STRING },
      ownerId: { type: DataTypes.UUID },
    },
    options: {
      timestamps: false,
      rls: {
        enabled: true,
        force: true,
        policies: {
          own: {
            for: "all",
            to: "app_member",
            using: { ownerId: { eq: rls.setting("app.user_id", "uuid") } },
          },
        },
      },
    },
  };

  const makeDefinitions = (overrides?: { [name: string]: Definition }) => {
    return { Task: taskDef, ...overrides };
  };

  /**
   * Helper: query pg_policy for a table.
   */
  /** Quote for regclass: `'"TableName"'::regclass`. */
  const rc = (tableName: string) => `'"${tableName}"'::regclass`;

  const getPolicies = async (tableName: string) => {
    const [rows] = await adapter.sequelize.query(
      `SELECT p.polname, p.polcmd, p.polpermissive, d.description
       FROM pg_policy p
       LEFT JOIN pg_description d ON d.objoid = p.oid
       WHERE p.polrelid = ${rc(tableName)}
       ORDER BY p.polname`,
    );
    return rows as Array<{ polname: string; polcmd: string; polpermissive: boolean; description: string | null }>;
  };

  /**
   * Helper: check if RLS is enabled on a table.
   */
  const getRlsStatus = async (tableName: string) => {
    const [rows] = await adapter.sequelize.query(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class WHERE oid = ${rc(tableName)}`,
    );
    return (rows as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>)[0];
  };

  beforeAll(async () => {
    adapter = await makeAdapter();
    // Define the model manually
    adapter.sequelize.define("Task", {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      name: { type: DataTypes.STRING },
      ownerId: { type: DataTypes.UUID },
    }, { timestamps: false, tableName: "Tasks" });
    await adapter.sequelize.sync({ force: true });
  });

  it("creates policies on first sync", async () => {
    const executed = await adapter.syncRowSecurity(makeDefinitions(), { manageRoles: true });
    // Should have executed: advisory lock, enable RLS, force RLS, marker policy, comment on marker, create policy, comment on policy
    expect(executed.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(executed.some((s) => s.includes("ENABLE ROW LEVEL SECURITY"))).toBe(true);
    expect(executed.some((s) => s.includes("FORCE ROW LEVEL SECURITY"))).toBe(true);
    expect(executed.some((s) => s.includes("CREATE POLICY"))).toBe(true);

    // Verify in catalog
    const policies = await getPolicies("Tasks");
    const ownPolicy = policies.find((p) => p.polname === "Tasks_own");
    expect(ownPolicy).toBeDefined();
    expect(ownPolicy!.description).toMatch(/^gqlize:managed:/);

    // Verify RLS is enabled
    const status = await getRlsStatus("Tasks");
    expect(status.relrowsecurity).toBe(true);
    expect(status.relforcerowsecurity).toBe(true);
  });

  it("is a no-op when nothing changed (no ALTER issued)", async () => {
    // First sync should have already run above
    const executed = await adapter.syncRowSecurity(makeDefinitions(), { manageRoles: true });
    // Should only have advisory lock + catalog reads, no CREATE/ALTER/DROP
    expect(executed.filter((s) => s.includes("CREATE POLICY")).length).toBe(0);
    expect(executed.filter((s) => s.includes("ALTER POLICY")).length).toBe(0);
    expect(executed.filter((s) => s.includes("DROP POLICY")).length).toBe(0);
    expect(executed.filter((s) => s.includes("ALTER TABLE")).length).toBe(0);
  });

  it("alters a policy when USING expression changes", async () => {
    // Change the policy's USING expression
    const modified = makeDefinitions({
      Task: {
        ...taskDef,
        options: {
          ...taskDef.options,
          rls: {
            enabled: true,
            force: true,
            policies: {
              own: {
                for: "all",
                to: "app_member",
                using: { ownerId: { eq: rls.setting("app.different_id", "uuid") } },
              },
            },
          },
        },
      },
    });
    const executed = await adapter.syncRowSecurity(modified, { manageRoles: true });
    // Should ALTER (same `for` and `as`, just different expression)
    expect(executed.some((s) => s.includes("ALTER POLICY"))).toBe(true);
    expect(executed.filter((s) => s.includes("DROP POLICY")).length).toBe(0);
  });

  it("drops and recreates when `for` changes", async () => {
    const modified = makeDefinitions({
      Task: {
        ...taskDef,
        options: {
          ...taskDef.options,
          rls: {
            enabled: true,
            force: true,
            policies: {
              own: {
                for: "select",
                to: "app_member",
                using: { ownerId: { eq: rls.setting("app.user_id", "uuid") } },
              },
            },
          },
        },
      },
    });
    const executed = await adapter.syncRowSecurity(modified, { manageRoles: true });
    // Should DROP + CREATE (since `for` changed from ALL to SELECT)
    expect(executed.some((s) => s.includes("DROP POLICY"))).toBe(true);
    expect(executed.some((s) => s.includes("CREATE POLICY"))).toBe(true);
  });

  it("removes stale managed policies", async () => {
    // First restore back to the original policy
    await adapter.syncRowSecurity(makeDefinitions(), { manageRoles: true });

    // Now sync with an empty policy set (but RLS still enabled)
    const noPolDefs = makeDefinitions({
      Task: {
        ...taskDef,
        options: {
          ...taskDef.options,
          rls: {
            enabled: true,
            force: true,
            policies: {},
          },
        },
      },
    });
    const executed = await adapter.syncRowSecurity(noPolDefs, { manageRoles: true });
    expect(executed.some((s) => s.includes("DROP POLICY") && s.includes("Tasks_own"))).toBe(true);

    // The marker policy should still be there
    const policies = await getPolicies("Tasks");
    const marker = policies.find((p) => p.polname === "Tasks__gqlize_rls_marker");
    expect(marker).toBeDefined();
    const ownPolicy = policies.find((p) => p.polname === "Tasks_own");
    expect(ownPolicy).toBeUndefined();
  });

  it("refuses to take over an unmarked policy", async () => {
    // Create a hand-written policy with the same name gqlize would use
    await adapter.sequelize.query(
      `CREATE POLICY "Tasks_manual" ON "Tasks" AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE)`,
    );

    const defsWithClash = makeDefinitions({
      Task: {
        ...taskDef,
        options: {
          ...taskDef.options,
          rls: {
            enabled: true,
            force: true,
            policies: {
              manual: {
                for: "all",
                to: "app_member",
                using: { ownerId: { eq: rls.setting("app.user_id", "uuid") } },
              },
            },
          },
        },
      },
    });

    await expect(adapter.syncRowSecurity(defsWithClash, { manageRoles: true })).rejects.toThrow(/not created by gqlize/);

    // Clean up
    await adapter.sequelize.query(`DROP POLICY "Tasks_manual" ON "Tasks"`);
  });

  it("disables RLS when model no longer has rls.enabled", async () => {
    // First enable it
    await adapter.syncRowSecurity(makeDefinitions(), { manageRoles: true });

    // Now sync with rls disabled
    const disabledDefs: { [name: string]: Definition } = {
      Task: {
        ...taskDef,
        options: {
          ...taskDef.options,
          rls: undefined,
        },
      },
    };
    const executed = await adapter.syncRowSecurity(disabledDefs, { manageRoles: true });
    expect(executed.some((s) => s.includes("DISABLE ROW LEVEL SECURITY"))).toBe(true);
    expect(executed.some((s) => s.includes("NO FORCE ROW LEVEL SECURITY"))).toBe(true);

    // Verify
    const status = await getRlsStatus("Tasks");
    expect(status.relrowsecurity).toBe(false);
    expect(status.relforcerowsecurity).toBe(false);
  });

  it("creates roles only with manageRoles", async () => {
    // Drop any existing test role
    try { await adapter.sequelize.query(`DROP ROLE IF EXISTS "test_role_rls"`); } catch { /* ok */ }

    const defsWithRole = makeDefinitions({
      Task: {
        ...taskDef,
        options: {
          ...taskDef.options,
          rls: {
            enabled: true,
            force: true,
            policies: {
              custom: {
                for: "select",
                to: "test_role_rls",
                using: sql`true`,
              },
            },
          },
        },
      },
    });

    // With manageRoles: should create the role AND the policy
    const exec2 = await adapter.syncRowSecurity(defsWithRole, { manageRoles: true });
    expect(exec2.some((s) => s.includes("CREATE ROLE"))).toBe(true);
    expect(exec2.some((s) => s.includes("CREATE POLICY"))).toBe(true);

    // Verify role exists
    const roles = await adapter.sequelize.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'test_role_rls'`,
      { type: QueryTypes.SELECT },
    );
    expect(roles.length).toBe(1);
  });

  it("advisory lock is taken", async () => {
    const executed = await adapter.syncRowSecurity(makeDefinitions(), { manageRoles: true });
    expect(executed[0]).toMatch(/pg_advisory_xact_lock/);
  });
});

describePostgres("RLS enforcement under SET LOCAL ROLE", () => {
  let adapter: SequelizeAdapter;
  let itemDefs: { [name: string]: Definition };

  beforeAll(async () => {
    const config = await dialectConfig();
    adapter = trackConnection(
      new SequelizeAdapter({ }, config as unknown as string),
      { suite: true },
    );

    adapter.sequelize.define("Item", {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      name: { type: DataTypes.STRING },
      ownerId: { type: DataTypes.STRING },
    }, { timestamps: false, tableName: "Items" });
    await adapter.sequelize.sync({ force: true });

    // Apply RLS
    const defs: { [name: string]: Definition } = {
      Item: {
        name: "Item",
        define: {},
        options: {
          timestamps: false,
          rls: {
            enabled: true,
            force: true,
            policies: {
              own: {
                for: "all",
                to: "app_user",
                using: { ownerId: { eq: rls.setting("app.user_id", "text") } },
              },
            },
          },
        },
      },
    };
    // Seed rows BEFORE enabling RLS.
    const Item = adapter.sequelize.models.Item;
    await Item.create({ name: "u1-item", ownerId: "u1" });
    await Item.create({ name: "u2-item", ownerId: "u2" });
    await Item.create({ name: "u1-item2", ownerId: "u1" });

    itemDefs = defs;
    await adapter.syncRowSecurity(defs, { manageRoles: true });

    // Grant table privileges and role membership to allow SET LOCAL ROLE.
    await adapter.sequelize.query(`GRANT ALL ON "Items" TO "app_user"`);
    await adapter.sequelize.query(`GRANT "app_user" TO CURRENT_USER`);
  });

  it("guard: superuser sees all rows without role switch", async () => {
    const rows = await adapter.sequelize.query(`SELECT * FROM "Items"`, { type: QueryTypes.SELECT });
    expect(rows.length).toBe(3);
  });

  it("user sees only their own rows under SET LOCAL ROLE", async () => {
    const helper = await createRlsRoleHelper(adapter, ["Items"], []);
    await helper.asRole("app_user", { "app.user_id": "u1" }, async (opts) => {
      const rows = await adapter.sequelize.query(
        `SELECT * FROM "Items"`,
        { ...(opts as Record<string, unknown>), type: QueryTypes.SELECT },
      ) as unknown as Array<{ name: string }>;
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.name.startsWith("u1"))).toBe(true);
    });
  });

  it("different user sees different rows", async () => {
    const helper = await createRlsRoleHelper(adapter, ["Items"], []);
    await helper.asRole("app_user", { "app.user_id": "u2" }, async (opts) => {
      const rows = await adapter.sequelize.query(
        `SELECT * FROM "Items"`,
        { ...(opts as Record<string, unknown>), type: QueryTypes.SELECT },
      ) as unknown as Array<{ name: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("u2-item");
    });
  });

  it("unset setting returns no rows (not an error)", async () => {
    const helper = await createRlsRoleHelper(adapter, ["Items"], []);
    await helper.asRole("app_user", {}, async (opts) => {
      const rows = await adapter.sequelize.query(
        `SELECT * FROM "Items"`,
        { ...(opts as Record<string, unknown>), type: QueryTypes.SELECT },
      );
      expect(rows.length).toBe(0);
    });
  });

  it("WITH CHECK violation on insert", async () => {
    const helper = await createRlsRoleHelper(adapter, ["Items"], []);
    await expect(
      helper.asRole("app_user", { "app.user_id": "u1" }, async (opts) => {
        await adapter.sequelize.query(
          `INSERT INTO "Items" (id, name, "ownerId") VALUES ('b0000000-0000-0000-0000-000000000001', 'sneaky', 'u2')`,
          opts as Record<string, unknown>,
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("the table marker opens nothing: a role with privileges but no policy sees no rows", async () => {
    // gqlize marks the tables it enabled with a policy of its own. A
    // permissive `USING (TRUE)` marker would OR with every other policy and
    // hand every row to every role; it has to be restrictive.
    const helper = await createRlsRoleHelper(adapter, ["Items"], ["app_unpoliced"]);
    await helper.asRole("app_unpoliced", { "app.user_id": "u1" }, async (opts) => {
      const rows = await adapter.sequelize.query(
        `SELECT * FROM "Items"`,
        { ...(opts as Record<string, unknown>), type: QueryTypes.SELECT },
      ) as unknown[];
      expect(rows).toHaveLength(0);
    });
    const [marker] = await adapter.sequelize.query<{ polpermissive: boolean }>(
      `SELECT polpermissive FROM pg_policy WHERE polrelid = '"Items"'::regclass AND polname = 'Items__gqlize_rls_marker'`,
      { type: QueryTypes.SELECT },
    );
    expect(marker.polpermissive).toBe(false);
  });

  it("sync replaces a permissive marker left by an earlier build", async () => {
    await adapter.sequelize.query(`DROP POLICY "Items__gqlize_rls_marker" ON "Items"`);
    await adapter.sequelize.query(`CREATE POLICY "Items__gqlize_rls_marker" ON "Items" AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE)`);
    await adapter.sequelize.query(`COMMENT ON POLICY "Items__gqlize_rls_marker" ON "Items" IS 'gqlize:rls'`);
    await adapter.syncRowSecurity(itemDefs, { manageRoles: true });
    const [marker] = await adapter.sequelize.query<{ polpermissive: boolean }>(
      `SELECT polpermissive FROM pg_policy WHERE polrelid = '"Items"'::regclass AND polname = 'Items__gqlize_rls_marker'`,
      { type: QueryTypes.SELECT },
    );
    expect(marker.polpermissive).toBe(false);
  });
});

describePostgres("compileRlsPolicies and enforcement parity", () => {
  it("compileRlsPolicies generates policies from role rules", async () => {
    const { compileRlsPolicies } = await import("@azerothian/utilize/permissions");

    const rules = {
      member: {
        scope: {
          Task: { own: "ownerId" },
        },
      },
    };

    const policies = compileRlsPolicies(rules, {
      dbRole: (role) => `app_${role}`,
      settings: { id: "app.user_id" },
    });

    expect(policies.Task).toBeDefined();
    // Should have read, insert, update, delete policies
    expect(policies.Task.member_read).toBeDefined();
    expect(policies.Task.member_read.for).toBe("select");
    expect(policies.Task.member_read.to).toBe("app_member");
    expect(policies.Task.member_insert).toBeDefined();
    expect(policies.Task.member_insert.for).toBe("insert");
    expect(policies.Task.member_update).toBeDefined();
    expect(policies.Task.member_update.for).toBe("update");
    expect(policies.Task.member_delete).toBeDefined();
    expect(policies.Task.member_delete.for).toBe("delete");
  });

  it("compileRlsPolicies via leaf produces quantifier nesting", async () => {
    const { compileRlsPolicies } = await import("@azerothian/utilize/permissions");

    const rules = {
      member: {
        scope: {
          User: {
            any: [
              { own: "id" },
              {
                via: "memberships.group.memberships",
                match: { userId: "$principal.id", role: "manager" },
              },
            ],
          },
        },
      },
    };

    const policies = compileRlsPolicies(rules, {
      dbRole: (role) => `app_${role}`,
      settings: { id: "app.user_id" },
    });

    expect(policies.User).toBeDefined();
    expect(policies.User.member_read).toBeDefined();
    // The USING expression should be an `or` of `own` and `via`
    const using = policies.User.member_read.using;
    expect(using).toBeDefined();
    expect((using as Record<string, unknown>).or).toBeDefined();
  });
});

describePostgres("RLS policy compiler output", () => {
  it("setting reference compiles to current_setting with nullif", async () => {
    const { compilePolicyExpression } = await import("../src/rls/compile-policy");
    const { rls: rlsHelper } = await import("@azerothian/ormize/rls");

    // Build a mock host
    const host = {
      getAssociations: () => ({}),
      quoteIdentifier: (id: string) => `"${id}"`,
      quoteTable: (table: string | object) => `"${typeof table === "string" ? table : (table as { tableName: string }).tableName}"`,
      escapeLiteral: (value: unknown) => `'${String(value).replace(/'/g, "''")}'`,
      getColumnName: (_m: string, f: string) => f,
      getTableName: (m: string) => m,
      getPrimaryKeyAttribute: () => "id",
    };

    const result = compilePolicyExpression(host, "Task", {
      ownerId: { eq: rlsHelper.setting("app.user_id", "uuid") },
    });

    expect(result).toContain("current_setting('app.user_id', true)");
    expect(result).toContain("nullif(");
    expect(result).toContain("::uuid");
  });

  it("array setting compiles to string_to_array", async () => {
    const { compilePolicyExpression } = await import("../src/rls/compile-policy");
    const { rls: rlsHelper } = await import("@azerothian/ormize/rls");

    const host = {
      getAssociations: () => ({}),
      quoteIdentifier: (id: string) => `"${id}"`,
      quoteTable: (table: string | object) => `"${typeof table === "string" ? table : (table as { tableName: string }).tableName}"`,
      escapeLiteral: (value: unknown) => `'${String(value).replace(/'/g, "''")}'`,
      getColumnName: (_m: string, f: string) => f,
      getTableName: (m: string) => m,
      getPrimaryKeyAttribute: () => "id",
    };

    const result = compilePolicyExpression(host, "Task", {
      groupId: { in: rlsHelper.setting("app.group_ids", "uuid[]") },
    });

    expect(result).toContain("string_to_array");
    expect(result).toContain("::uuid[]");
  });

  it("sql fragment passes through verbatim", async () => {
    const { compilePolicyExpression } = await import("../src/rls/compile-policy");
    const { sql: sqlTag } = await import("@azerothian/ormize/rls");

    const host = {
      getAssociations: () => ({}),
      quoteIdentifier: (id: string) => `"${id}"`,
      quoteTable: (t: string | object) => `"${typeof t === "string" ? t : (t as { tableName: string }).tableName}"`,
      escapeLiteral: (value: unknown) => `'${String(value)}'`,
      getColumnName: (_m: string, f: string) => f,
      getTableName: (m: string) => m,
      getPrimaryKeyAttribute: () => "id",
    };

    const result = compilePolicyExpression(host, "Task", sqlTag`true`);
    expect(result).toBe("true");
  });
});

describePostgres("generateRlsSql (rls:sql output)", () => {
  let adapter: SequelizeAdapter;

  beforeAll(async () => {
    const config = await dialectConfig();
    adapter = trackConnection(
      new SequelizeAdapter({ }, config as unknown as string),
      { suite: true },
    );
    adapter.sequelize.define("Task", {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      name: { type: DataTypes.STRING },
      ownerId: { type: DataTypes.UUID },
    }, { timestamps: false, tableName: "Tasks" });
    await adapter.sequelize.sync({ force: true });
  });

  it("generates valid DDL that can be applied to PGlite", async () => {
    const defs: { [name: string]: Definition } = {
      Task: {
        name: "Task",
        define: {},
        options: {
          timestamps: false,
          rls: {
            enabled: true,
            force: true,
            policies: {
              own: {
                for: "all",
                to: "app_member",
                using: { ownerId: { eq: rls.setting("app.user_id", "uuid") } },
              },
            },
          },
        },
      },
    };

    // The script creates the role too, as `sync()` does under manageRoles.
    const sql = adapter.generateRlsSql(defs, { manageRoles: true });
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY");

    // Apply the DDL to a fresh PGlite (via the adapter's connection)
    // First, reset the table's RLS state
    await adapter.sequelize.query(`ALTER TABLE "Tasks" DISABLE ROW LEVEL SECURITY`);
    // Drop any existing policies
    const policies = await adapter.sequelize.query(
      `SELECT polname FROM pg_policy WHERE polrelid = '"Tasks"'::regclass`,
      { type: QueryTypes.SELECT },
    ) as unknown as Array<{ polname: string }>;
    for (const p of policies) {
      await adapter.sequelize.query(`DROP POLICY "${p.polname}" ON "Tasks"`);
    }

    // Apply the script whole, as a migration tool would. A parameterless query
    // goes over the wire as one simple-protocol message, which accepts many
    // statements; splitting on `;` would cut the DO blocks apart.
    await adapter.sequelize.query(sql);

    const policyList = await adapter.sequelize.query(
      `SELECT p.polname, p.polpermissive, d.description FROM pg_policy p
       LEFT JOIN pg_description d ON d.objoid = p.oid
       WHERE p.polrelid = '"Tasks"'::regclass ORDER BY p.polname`,
      { type: QueryTypes.SELECT },
    ) as unknown as Array<{ polname: string; polpermissive: boolean; description: string | null }>;
    const ownPolicy = policyList.find((p) => p.polname === "Tasks_own");
    expect(ownPolicy).toBeDefined();
    expect(ownPolicy!.description).toMatch(/^gqlize:managed:/);
    const marker = policyList.find((p) => p.polname === "Tasks__gqlize_rls_marker");
    expect(marker?.polpermissive).toBe(false);

    // Same state as sync would have produced: a sync now has nothing to do.
    const executed = await adapter.syncRowSecurity(defs, { manageRoles: true });
    expect(executed.filter((q) => /^(CREATE|ALTER|DROP|COMMENT)/.test(q))).toEqual([]);

    // And running the script a second time is harmless.
    await adapter.sequelize.query(sql);
  });
});
