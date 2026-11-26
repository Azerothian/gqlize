// Global filters (RFC §5): static model-level filters AND-ed into every
// chokepoint. Split by topic from the scope tests; shared fixtures below.

import { describe, it, expect } from "@jest/globals";
import Database from "../src/manager";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import Sequelize from "sequelize";
import type { Permission, ScopePredicate } from "@azerothian/utilize/gate";
import { ScopeConfigurationError } from "@azerothian/utilize/gate";
import { dialectConfig, trackConnection } from "@azerothian/test-fixtures/dialect";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Row = { name: string; archived: boolean; ownerId: number };
const ctx = (id: number) => ({ user: { id } });
const named = (rows: unknown) => (rows as Row[]).map((r) => r.name).sort();

async function buildOrm(options: {
  scope?: ScopePredicate;
  filters?: Record<string, { where: Record<string, unknown>; operations?: ("read" | "update" | "delete")[] }>;
} = {}) {
  const permission: Permission | undefined = options.scope ? { scope: options.scope } : undefined;
  const db = new Database({ permission });
  db.registerAdapter(
    trackConnection(new SequelizeAdapter({}, await dialectConfig())),
    "sqlite",
  );
  await db.addDefinition({
    name: "Task",
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
      archived: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      ownerId: { type: Sequelize.INTEGER, allowNull: true },
    },
    options: {
      timestamps: false,
      tableName: "tasks",
      filters: options.filters,
    },
  });
  await db.initialise();
  await db.sync();
  return db;
}

async function seed(db: Awaited<ReturnType<typeof buildOrm>>) {
  await db.models.Task.bulkCreate([
    { name: "live-1", archived: false, ownerId: 1 },
    { name: "live-2", archived: false, ownerId: 2 },
    { name: "archived-1", archived: true, ownerId: 1 },
    { name: "archived-2", archived: true, ownerId: 2 },
  ]);
}

// ---------------------------------------------------------------------------
// Read chokepoints
// ---------------------------------------------------------------------------

describe("ormize — global filters, reads", () => {
  it("root list: hides rows the filter excludes", async () => {
    const db = await buildOrm({ filters: { archived: { where: { archived: { eq: false } } } } });
    await seed(db);
    const { total, models } = await db.resolveFindAll("Task", null, {}, ctx(1));
    expect(named(models)).toEqual(["live-1", "live-2"]);
    expect(total).toEqual(2);
  });

  it("total agrees with edges", async () => {
    const db = await buildOrm({ filters: { archived: { where: { archived: { eq: false } } } } });
    await seed(db);
    const { total, models } = await db.resolveFindAll("Task", null, {}, ctx(1));
    expect(total).toEqual(models.length);
  });

  it("composes with a scope: both are applied", async () => {
    const db = await buildOrm({
      filters: { archived: { where: { archived: { eq: false } } } },
      scope: () => ({ where: { ownerId: { eq: 1 } } }),
    });
    await seed(db);
    const { total, models } = await db.resolveFindAll("Task", null, {}, ctx(1));
    expect(named(models)).toEqual(["live-1"]);
    expect(total).toEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Write chokepoints
// ---------------------------------------------------------------------------

describe("ormize — global filters, writes", () => {
  it("update: only targets rows the filter allows", async () => {
    const db = await buildOrm({ filters: { archived: { where: { archived: { eq: false } } } } });
    await seed(db);
    const results = await db.processUpdate("Task", null, {
      input: { name: "changed" },
      where: { name: { eq: "archived-1" } },
    }, ctx(1));
    // The filter hides archived rows, so the update touches nothing.
    expect(results).toEqual([]);
    // The original row is untouched.
    const row = await db.models.Task.findOne({ where: { name: "archived-1" } });
    expect(row).toBeTruthy();
  });

  it("delete: only targets rows the filter allows", async () => {
    const db = await buildOrm({ filters: { archived: { where: { archived: { eq: false } } } } });
    await seed(db);
    const results = await db.processDelete("Task", null, { name: { eq: "archived-1" } }, ctx(1));
    expect(results).toEqual([]);
  });

  it("operations restriction: read-only filter does not narrow the update WHERE", async () => {
    const db = await buildOrm({
      // Only a delete-filter — reads and updates are not narrowed.
      filters: { noDelete: { where: { archived: { eq: false } }, operations: ["delete"] } },
    });
    await seed(db);
    // Update can reach archived rows because the filter is delete-only.
    const results = await db.processUpdate("Task", null, {
      input: { name: "renamed" },
      where: { name: { eq: "archived-1" } },
    }, ctx(1));
    expect(results.length).toEqual(1);
    // But delete cannot reach them.
    const deleted = await db.processDelete("Task", null, { name: { eq: "archived-2" } }, ctx(1));
    expect(deleted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// withoutFilters bypass
// ---------------------------------------------------------------------------

describe("ormize — withoutFilters", () => {
  it("lifts only the named filter", async () => {
    const db = await buildOrm({ filters: { archived: { where: { archived: { eq: false } } } } });
    await seed(db);
    const result = await db.withoutFilters(["archived"], async () => {
      return db.resolveFindAll("Task", null, {}, ctx(1));
    });
    expect(result.total).toEqual(4);
  });

  it("nested calls union their names", async () => {
    const db = await buildOrm({
      filters: {
        archived: { where: { archived: { eq: false } } },
        mine: { where: { ownerId: { eq: 1 } } },
      },
    });
    await seed(db);
    // Outer lifts "archived", inner lifts "mine".
    const result = await db.withoutFilters(["archived"], async () => {
      return db.withoutFilters(["mine"], async () => {
        return db.resolveFindAll("Task", null, {}, ctx(1));
      });
    });
    expect(result.total).toEqual(4);
  });

  it("does not lift scope", async () => {
    const db = await buildOrm({
      filters: { archived: { where: { archived: { eq: false } } } },
      scope: () => ({ where: { ownerId: { eq: 1 } } }),
    });
    await seed(db);
    const result = await db.withoutFilters(["archived"], async () => {
      return db.resolveFindAll("Task", null, {}, ctx(1));
    });
    // Scope still applied: only owner 1's rows.
    expect(named(result.models)).toEqual(["archived-1", "live-1"]);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("ormize — global filter validation", () => {
  it("rejects `create` in operations", async () => {
    await expect(buildOrm({
      filters: { bad: { where: { archived: { eq: false } }, operations: ["create" as "read"] } },
    })).rejects.toThrow(ScopeConfigurationError);
  });

  it("rejects an empty where", async () => {
    await expect(buildOrm({
      filters: { bad: { where: {} } },
    })).rejects.toThrow(ScopeConfigurationError);
  });
});
