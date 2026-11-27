// Global filters (RFC §5) end-to-end through the GraphQL schema.
// Tests every chokepoint where the filter is the only thing hiding a row.

import Sequelize from "sequelize";
import { graphql } from "graphql";
import type { GraphQLSchema } from "graphql";
import { Ormize as Database } from "@azerothian/ormize";
import type { Definition, Permission } from "@azerothian/utilize";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { ScopeConfigurationError } from "@azerothian/utilize/gate";
import { describe, it, expect } from "@jest/globals";

import { createSchema } from "../src";
import { createAdapterForDialect, registerTeardown } from "./helper/dialect";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TaskDef: Definition = {
  name: "Task",
  define: {
    title: { type: Sequelize.STRING, allowNull: false },
    archived: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    ownerId: { type: Sequelize.INTEGER, allowNull: true, writable: true },
  },
  options: {
    timestamps: false,
    tableName: "tasks",
    filters: {
      active: { where: { archived: { eq: false } } },
    },
  },
  relationships: [
    { type: "hasMany", model: "Note", name: "notes", options: { foreignKey: "taskId" } },
    { type: "belongsTo", model: "User", name: "owner", options: { foreignKey: "ownerId" } },
  ],
};

const NoteDef: Definition = {
  name: "Note",
  define: {
    body: { type: Sequelize.STRING, allowNull: false },
    taskId: { type: Sequelize.INTEGER, allowNull: true },
  },
  options: { timestamps: false, tableName: "notes" },
  relationships: [
    { type: "belongsTo", model: "Task", name: "task", options: { foreignKey: "taskId" } },
  ],
};

const UserDef: Definition = {
  name: "User",
  define: {
    name: { type: Sequelize.STRING, allowNull: false },
    archived: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
  },
  options: {
    timestamps: false,
    tableName: "users",
    filters: {
      active: { where: { archived: { eq: false } } },
    },
  },
  relationships: [
    { type: "hasMany", model: "Task", name: "tasks", options: { foreignKey: "ownerId" } },
    { type: "hasOne", model: "Task", name: "latestTask", options: { foreignKey: "ownerId" } },
  ],
};

interface BuildOptions {
  permission?: Permission;
  scope?: ScopePredicate;
  taskFilters?: Record<string, { where: Record<string, unknown>; operations?: ("read" | "update" | "delete")[] }>;
}

async function build(options: BuildOptions = {}) {
  const permission = options.permission || (options.scope ? { scope: options.scope } : undefined);
  const db = new Database({ permission });
  const { adapter, name, teardown } = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
  const taskDef = options.taskFilters
    ? { ...TaskDef, options: { ...TaskDef.options, filters: options.taskFilters } }
    : TaskDef;
  await db.addDefinition(taskDef);
  await db.addDefinition(NoteDef);
  await db.addDefinition(UserDef);
  await db.initialise();
  await db.sync();
  const schema = await createSchema(db);
  return { db, schema };
}

async function seed(db: Database) {
  await db.models.User.bulkCreate([
    { name: "alice", archived: false },
    { name: "bob", archived: true },
  ]);
  const alice = await db.models.User.findOne({ where: { name: "alice" } });
  const bob = await db.models.User.findOne({ where: { name: "bob" } });
  await db.models.Task.bulkCreate([
    { title: "live-1", archived: false, ownerId: alice.id },
    { title: "live-2", archived: false, ownerId: bob.id },
    { title: "done-1", archived: true, ownerId: alice.id },
    { title: "done-2", archived: true, ownerId: bob.id },
  ]);
  const live1 = await db.models.Task.findOne({ where: { title: "live-1" } });
  const done1 = await db.models.Task.findOne({ where: { title: "done-1" } });
  await db.models.Note.bulkCreate([
    { body: "on live", taskId: live1.id },
    { body: "on done", taskId: done1.id },
  ]);
  return { alice, bob, live1, done1 };
}

type Ctx = { user: { id: number } };
function ctx(id: number): Ctx { return { user: { id } }; }

async function ask(schema: GraphQLSchema, query: string, variables?: Record<string, unknown>, context?: Ctx) {
  return graphql({ schema, source: query, contextValue: context || ctx(1), variableValues: variables });
}

// ---------------------------------------------------------------------------
// Read chokepoints
// ---------------------------------------------------------------------------

describe("global filters — read chokepoints", () => {
  it("root list: hides archived tasks from edges and total", async () => {
    const b = await build();
    await seed(b.db);
    const r = await ask(b.schema, `{ models { Task { total, edges { node { title } } } } }`);
    const conn = (r.data as Record<string, Record<string, { total: number; edges: { node: { title: string } }[] }>>).models.Task;
    expect(conn.total).toEqual(2);
    expect(conn.edges.map((e) => e.node.title).sort()).toEqual(["live-1", "live-2"]);
  });

  it("total agrees with edges", async () => {
    const b = await build();
    await seed(b.db);
    const r = await ask(b.schema, `{ models { Task { total, edges { node { title } } } } }`);
    const conn = (r.data as Record<string, Record<string, { total: number; edges: { node: { title: string } }[] }>>).models.Task;
    expect(conn.total).toEqual(conn.edges.length);
  });

  it("eager nested connection (hasMany): filter on target hides rows", async () => {
    const b = await build();
    await seed(b.db);
    // User.tasks is a hasMany; Task has an active filter
    const r = await ask(b.schema, `{ models { User { edges { node { name, tasks { total, edges { node { title } } } } } } } }`);
    const users = (r.data as Record<string, Record<string, { edges: { node: { name: string; tasks: { total: number; edges: { node: { title: string } }[] } } }[] }>>).models.User;
    const aliceNode = users.edges.find((e) => e.node.name === "alice");
    expect(aliceNode).toBeDefined();
    // Alice has one live task; the archived one is hidden.
    expect(aliceNode!.node.tasks.total).toEqual(1);
    expect(aliceNode!.node.tasks.edges[0].node.title).toEqual("live-1");
  });

  it("eager single relation (belongsTo): filter on target hides row", async () => {
    const b = await build();
    await seed(b.db);
    // Task.owner is belongsTo User; User has an active filter
    const r = await ask(b.schema, `{ models { Task { edges { node { title, owner { name } } } } } }`);
    const tasks = (r.data as Record<string, Record<string, { edges: { node: { title: string; owner: { name: string } | null } }[] }>>).models.Task;
    const live2 = tasks.edges.find((e) => e.node.title === "live-2");
    // live-2 is owned by bob (archived=true), so owner is filtered out
    expect(live2!.node.owner).toBeNull();
    const live1 = tasks.edges.find((e) => e.node.title === "live-1");
    expect(live1!.node.owner).not.toBeNull();
    expect(live1!.node.owner!.name).toEqual("alice");
  });

  it("eager single relation (hasOne): filter on target hides row", async () => {
    const b = await build();
    await seed(b.db);
    // User.latestTask is hasOne Task; Task has an active filter
    const r = await ask(b.schema, `{ models { User { edges { node { name, latestTask { title } } } } } }`);
    const users = (r.data as Record<string, Record<string, { edges: { node: { name: string; latestTask: { title: string } | null } }[] }>>).models.User;
    const alice = users.edges.find((e) => e.node.name === "alice");
    expect(alice!.node.latestTask).not.toBeNull();
    expect(alice!.node.latestTask!.title).toEqual("live-1");
  });
});

// ---------------------------------------------------------------------------
// Write chokepoints
// ---------------------------------------------------------------------------

describe("global filters — write chokepoints", () => {
  it("update: global filter hides the target row", async () => {
    const b = await build();
    await seed(b.db);
    const r = await ask(b.schema, `mutation { models { Task(update: { input: { title: "changed" }, where: { title: { eq: "done-1" } } }) { title } } }`);
    expect(r.errors).toBeUndefined();
    const updated = (r.data as Record<string, Record<string, { title: string }[]>>).models.Task;
    expect(updated).toEqual([]);
  });

  it("delete: global filter hides the target row", async () => {
    const b = await build();
    await seed(b.db);
    const r = await ask(b.schema, `mutation { models { Task(delete: { title: { eq: "done-1" } }) { title } } }`);
    expect(r.errors).toBeUndefined();
    const deleted = (r.data as Record<string, Record<string, { title: string }[]>>).models.Task;
    expect(deleted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Composition with scope
// ---------------------------------------------------------------------------

describe("global filters — composition with scope", () => {
  it("both filter and scope are applied together", async () => {
    const b = await build({
      scope: (defName) => defName === "Task" ? { where: { ownerId: { eq: 1 } } } : undefined,
    });
    await seed(b.db);
    const r = await ask(b.schema, `{ models { Task { total, edges { node { title } } } } }`);
    const conn = (r.data as Record<string, Record<string, { total: number; edges: { node: { title: string } }[] }>>).models.Task;
    // Only live tasks owned by user 1
    expect(conn.total).toEqual(1);
    expect(conn.edges[0].node.title).toEqual("live-1");
  });
});

// ---------------------------------------------------------------------------
// withoutFilters bypass
// ---------------------------------------------------------------------------

describe("global filters — withoutFilters bypass", () => {
  it("lifts the named filter; scope still applies", async () => {
    const b = await build({
      scope: (defName) => defName === "Task" ? { where: { ownerId: { eq: 1 } } } : undefined,
    });
    await seed(b.db);
    const result = await b.db.withoutFilters(["active"], async () => {
      return b.db.resolveFindAll("Task", null, {}, ctx(1));
    });
    // Filter lifted: archived rows visible. Scope still applied: only owner 1.
    expect(result.total).toEqual(2);
  });

  it("cache key differs: a cached read with filter is not served without it", async () => {
    const b = await build();
    await seed(b.db);
    // First read: with filter
    const { total: filtered } = await b.db.resolveFindAll("Task", null, {}, ctx(1));
    expect(filtered).toEqual(2);
    // Second read: without filter — must see all 4
    const unfiltered = await b.db.withoutFilters(["active"], async () => {
      return b.db.resolveFindAll("Task", null, {}, ctx(1));
    });
    expect(unfiltered.total).toEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Operations restriction
// ---------------------------------------------------------------------------

describe("global filters — operations restriction", () => {
  it("a read-only filter does not narrow update or delete", async () => {
    const b = await build({
      taskFilters: {
        active: { where: { archived: { eq: false } }, operations: ["read"] },
      },
    });
    await seed(b.db);
    // Read is filtered
    const r = await ask(b.schema, `{ models { Task { total } } }`);
    const total = (r.data as Record<string, Record<string, { total: number }>>).models.Task.total;
    expect(total).toEqual(2);
    // Delete reaches archived rows because the filter is read-only
    const dr = await ask(b.schema, `mutation { models { Task(delete: { title: { eq: "done-1" } }) { title } } }`);
    expect(dr.errors).toBeUndefined();
    const deleted = (dr.data as Record<string, Record<string, { title: string }[]>>).models.Task;
    expect(deleted.length).toEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("global filters — validation", () => {
  it("rejects `create` in operations at initialise time", async () => {
    await expect(build({
      taskFilters: { bad: { where: { archived: { eq: false } }, operations: ["create" as "read"] } },
    })).rejects.toThrow(ScopeConfigurationError);
  });
});
