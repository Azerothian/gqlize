// Global filters and the singular `deleted` argument (RFC §5) on the paths the
// first suite (`global-filters.test.ts`) leaves out: `node(id:)`, a `required`
// include, a relationship `select`, a belongsToMany through a registered join
// model, a quantifier inside a filter, a cross-adapter (lazily resolved)
// relationship, and `deleted` on single-valued relationships and `node` under
// `queryDeleted`, including a model `queryDeleted` denies. In each test the
// filter or gate is the only thing between the caller and the row.

import Sequelize from "sequelize";
import { graphql } from "graphql";
import type { GraphQLSchema } from "graphql";
import { toGlobalId } from "graphql-relay";
import { Ormize as Database } from "@azerothian/ormize";
import type { Definition, Permission } from "@azerothian/utilize";
import { describe, it, expect } from "@jest/globals";

import { createSchema } from "../src";
import { createAdapterForDialect, registerTeardown } from "./helper/dialect";

type Result = { errors?: readonly { message: string }[]; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- each test reads its own corner of the response

const ask = (schema: GraphQLSchema, source: string, variableValues?: { [k: string]: unknown }) =>
  graphql({ schema, source, contextValue: {}, variableValues }) as unknown as Promise<Result>;

const names = (connection: { edges: { node: { name?: string; title?: string } }[] }) =>
  connection.edges.map((e) => e.node.name ?? e.node.title);

async function orm(defs: [Definition, string?][], permission?: Permission, adapters = 1) {
  // The engine reads `scope` off its own bag; the schema builder reads the
  // build-time gates (`queryDeleted`) off `createSchema`'s. Same bag, both places.
  const db = new Database(permission ? { permission } : undefined);
  const adapterNames: string[] = [];
  for (let i = 0; i < adapters; i++) {
    const { adapter, name, teardown } = await createAdapterForDialect();
    registerTeardown(teardown);
    const adapterName = i === 0 ? name : `${name}${i}`;
    db.registerAdapter(adapter, adapterName);
    adapterNames.push(adapterName);
  }
  for (const [def, adapter] of defs) {
    await db.addDefinition(def, adapter === "second" ? adapterNames[1] : adapterNames[0]);
  }
  await db.initialise();
  await db.sync();
  return { db, schema: await createSchema(db, permission ? { permission } : {}) };
}

// ---------------------------------------------------------------------------
// Users with tasks; Task carries the filter.
// ---------------------------------------------------------------------------

const UserDef: Definition = {
  name: "User",
  options: { timestamps: false },
  define: { name: { type: Sequelize.STRING, allowNull: false } },
  relationships: [{ type: "hasMany", model: "Task", name: "tasks", options: { foreignKey: "userId" } }],
};

const taskDef = (filters: NonNullable<Definition["options"]>["filters"]): Definition => ({
  name: "Task",
  options: { timestamps: false, filters },
  define: {
    title: { type: Sequelize.STRING, allowNull: false },
    archived: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    userId: { type: Sequelize.INTEGER, allowNull: true, writable: true },
  },
  relationships: [
    { type: "belongsTo", model: "User", name: "user", options: { foreignKey: "userId" } },
    { type: "hasMany", model: "Step", name: "steps", options: { foreignKey: "taskId" } },
  ],
});

const StepDef: Definition = {
  name: "Step",
  options: { timestamps: false },
  define: {
    label: { type: Sequelize.STRING, allowNull: false },
    taskId: { type: Sequelize.INTEGER, allowNull: true, writable: true },
  },
  relationships: [{ type: "belongsTo", model: "Task", name: "task", options: { foreignKey: "taskId" } }],
};

const activeOnly = { active: { where: { archived: { eq: false } } } };

describe("gqlize - global filters on the remaining paths", () => {
  it("node(id:) does not return a filtered row", async() => {
    const { db, schema } = await orm([[UserDef], [taskDef(activeOnly)], [StepDef]]);
    const live = await db.models.Task.create({ title: "live" });
    const done = await db.models.Task.create({ title: "done", archived: true });
    const source = "query n($id: ID!) { node(id: $id) { ... on Task { title } } }";
    expect((await ask(schema, source, { id: toGlobalId("Task", String(done.id)) })).data.node).toBeNull();
    expect((await ask(schema, source, { id: toGlobalId("Task", String(live.id)) })).data.node.title).toEqual("live");
  });

  it("a required include counts only rows the filter keeps", async() => {
    const { db, schema } = await orm([[UserDef], [taskDef(activeOnly)], [StepDef]]);
    const ada = await db.models.User.create({ name: "ada" });
    const bea = await db.models.User.create({ name: "bea" });
    await db.models.Task.create({ title: "a", userId: ada.id });
    await db.models.Task.create({ title: "b", userId: bea.id, archived: true });
    const result = await ask(schema, "query { models { User(include: [{tasks: {required: true}}]) { total edges { node { name } } } } }");
    expect(result.errors).toBeUndefined();
    expect(names(result.data.models.User)).toEqual(["ada"]);
    expect(result.data.models.User.total).toEqual(1);
  });

  it("a relationship select reaches only rows the filter keeps", async() => {
    const { db, schema } = await orm([[UserDef], [taskDef(activeOnly)], [StepDef]]);
    const ada = await db.models.User.create({ name: "ada" });
    const live = await db.models.Task.create({ title: "live", userId: ada.id });
    const done = await db.models.Task.create({ title: "done", userId: ada.id, archived: true });
    const result = await ask(schema, `mutation { models { User(select: [{ where: {}, input: {
      tasks: { select: [{ where: {}, input: { steps: { create: [{ label: "s" }] } } }] }
    } }]) { name } } }`);
    expect(result.errors).toBeUndefined();
    expect(await db.models.Step.count({ where: { taskId: live.id } })).toEqual(1);
    expect(await db.models.Step.count({ where: { taskId: done.id } })).toEqual(0);
  });

  it("a filter may use a relationship quantifier", async() => {
    // A task is visible only if none of its steps is labelled "blocked".
    const filters = { unblocked: { where: { steps: { none: { label: { eq: "blocked" } } } } } };
    const { db, schema } = await orm([[UserDef], [taskDef(filters)], [StepDef]]);
    const ok = await db.models.Task.create({ title: "ok" });
    const stuck = await db.models.Task.create({ title: "stuck" });
    await db.models.Step.create({ label: "fine", taskId: ok.id });
    await db.models.Step.create({ label: "blocked", taskId: stuck.id });
    const result = await ask(schema, "query { models { Task { total edges { node { title } } } } }");
    expect(result.errors).toBeUndefined();
    expect(names(result.data.models.Task)).toEqual(["ok"]);
    expect(result.data.models.Task.total).toEqual(1);
  });

  it("a cross-adapter (lazily resolved) relationship applies the target's filter", async() => {
    const { db, schema } = await orm([[UserDef, "second"], [taskDef(activeOnly)], [StepDef]], undefined, 2);
    const ada = await db.models.User.create({ name: "ada" });
    await db.models.Task.create({ title: "live", userId: ada.id });
    await db.models.Task.create({ title: "done", userId: ada.id, archived: true });
    const result = await ask(schema, "query { models { User { edges { node { name tasks { total edges { node { title } } } } } } } }");
    expect(result.errors).toBeUndefined();
    const [user] = result.data.models.User.edges;
    expect(names(user.node.tasks)).toEqual(["live"]);
    expect(user.node.tasks.total).toEqual(1);
  });
});

// ---------------------------------------------------------------------------
// belongsToMany through a registered join model that carries the filter.
// ---------------------------------------------------------------------------

describe("gqlize - global filter on a registered join model", () => {
  const ItemDef: Definition = {
    name: "Item",
    options: { timestamps: false },
    define: { title: { type: Sequelize.STRING, allowNull: false } },
    relationships: [{
      type: "belongsToMany", model: "Tag", name: "tags",
      options: { through: { model: "ItemTag" }, foreignKey: "itemId", otherKey: "tagId" },
    }],
  };
  const TagDef: Definition = {
    name: "Tag",
    options: { timestamps: false },
    define: { label: { type: Sequelize.STRING, allowNull: false } },
  };
  const ItemTagDef: Definition = {
    name: "ItemTag",
    options: { timestamps: false, filters: { visible: { where: { hidden: { eq: false } } } } },
    define: {
      itemId: { type: Sequelize.INTEGER, allowNull: false },
      tagId: { type: Sequelize.INTEGER, allowNull: false },
      hidden: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    },
    relationships: [
      { type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } },
      { type: "belongsTo", model: "Tag", name: "tag", options: { foreignKey: "tagId" } },
    ],
  };

  it("a link the join model's filter hides is not followed", async() => {
    const { db, schema } = await orm([[ItemDef], [TagDef], [ItemTagDef]]);
    const item = await db.models.Item.create({ title: "item" });
    const shown = await db.models.Tag.create({ label: "shown" });
    const hidden = await db.models.Tag.create({ label: "hidden" });
    await db.models.ItemTag.create({ itemId: item.id, tagId: shown.id });
    await db.models.ItemTag.create({ itemId: item.id, tagId: hidden.id, hidden: true });
    const result = await ask(schema, "query { models { Item { edges { node { tags { total edges { node { label } } } } } } } }");
    expect(result.errors).toBeUndefined();
    const [row] = result.data.models.Item.edges;
    expect(row.node.tags.edges.map((e: { node: { label: string } }) => e.node.label)).toEqual(["shown"]);
    expect(row.node.tags.total).toEqual(1);
  });
});

// ---------------------------------------------------------------------------
// `deleted` on single-valued relationships and node(id:).
// ---------------------------------------------------------------------------

describe("gqlize - deleted on belongsTo, hasOne and node", () => {
  const DocDef: Definition = {
    name: "Doc",
    options: { paranoid: true },
    define: { name: { type: Sequelize.STRING, allowNull: false } },
    relationships: [{ type: "hasOne", model: "Cover", name: "cover", options: { foreignKey: "docId" } }],
  };
  const CoverDef: Definition = {
    name: "Cover",
    options: { paranoid: true },
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
      docId: { type: Sequelize.INTEGER, allowNull: true, writable: true },
    },
    relationships: [{ type: "belongsTo", model: "Doc", name: "doc", options: { foreignKey: "docId" } }],
  };

  async function seeded(permission?: Permission) {
    const built = await orm([[DocDef], [CoverDef]], permission);
    const doc = await built.db.models.Doc.create({ name: "doc" });
    const cover = await built.db.models.Cover.create({ name: "cover", docId: doc.id });
    await doc.destroy();
    await cover.destroy();
    // A live pair alongside, so the parents can be reached at all.
    const liveDoc = await built.db.models.Doc.create({ name: "live" });
    const liveCover = await built.db.models.Cover.create({ name: "orphan", docId: doc.id });
    return { ...built, doc, cover, liveDoc, liveCover };
  }

  it("belongsTo hides a soft-deleted target by default and shows it with INCLUDE", async() => {
    const { schema } = await seeded({ queryDeleted: () => true });
    const hidden = await ask(schema, "query { models { Cover { edges { node { name doc { name } } } } } }");
    expect(hidden.errors).toBeUndefined();
    expect(hidden.data.models.Cover.edges.map((e: { node: unknown }) => e.node)).toEqual([{ name: "orphan", doc: null }]);
    const shown = await ask(schema, "query { models { Cover { edges { node { name doc(deleted: INCLUDE) { name } } } } } }");
    expect(shown.errors).toBeUndefined();
    expect(shown.data.models.Cover.edges.map((e: { node: unknown }) => e.node)).toEqual([{ name: "orphan", doc: { name: "doc" } }]);
  });

  it("hasOne shows a soft-deleted target only with ONLY or INCLUDE", async() => {
    const { schema } = await seeded({ queryDeleted: () => true });
    const query = (arg: string) => ask(schema,
      `query { models { Doc(deleted: INCLUDE) { edges { node { name cover${arg} { name } } } } } }`);
    const byName = (r: Result) => Object.fromEntries(
      r.data.models.Doc.edges.map((e: { node: { name: string; cover: { name: string } | null } }) => [e.node.name, e.node.cover?.name ?? null]));
    const live = await query("");
    expect(live.errors).toBeUndefined();
    expect(byName(live).doc).toEqual("orphan");
    const only = await query("(deleted: ONLY)");
    expect(only.errors).toBeUndefined();
    expect(byName(only).doc).toEqual("cover");
  });

  it("omits the argument when queryDeleted denies the target, so naming it fails validation", async() => {
    const { schema } = await seeded({ queryDeleted: () => false });
    const result = await ask(schema, "query { models { Cover { edges { node { doc(deleted: INCLUDE) { name } } } } } }");
    expect(result.errors?.[0].message).toMatch(/deleted/);
  });

  it("node(id:) returns a soft-deleted row only with INCLUDE and only where queryDeleted allows it", async() => {
    // queryDeleted allows Cover but not Doc. `node` carries the argument
    // because one model qualifies; a Doc id must still not come back deleted.
    const { schema, doc, cover } = await seeded({ queryDeleted: (defName: string) => defName === "Cover" });
    const source = "query n($id: ID!) { node(id: $id, deleted: INCLUDE) { ... on Doc { name } ... on Cover { name } } }";
    const plain = "query n($id: ID!) { node(id: $id) { ... on Cover { name } } }";
    expect((await ask(schema, plain, { id: toGlobalId("Cover", String(cover.id)) })).data.node).toBeNull();
    expect((await ask(schema, source, { id: toGlobalId("Cover", String(cover.id)) })).data.node).toEqual({ name: "cover" });
    const denied = await ask(schema, source, { id: toGlobalId("Doc", String(doc.id)) });
    expect(denied.errors).toBeUndefined();
    expect(denied.data.node).toBeNull();
  });

  it("node(id:) passes the argument through a variable too", async() => {
    const { schema, cover } = await seeded({ queryDeleted: () => true });
    const source = "query n($id: ID!, $d: GQLTDeletedFilter) { node(id: $id, deleted: $d) { ... on Cover { name } } }";
    const result = await ask(schema, source, { id: toGlobalId("Cover", String(cover.id)), d: "INCLUDE" });
    expect(result.errors).toBeUndefined();
    expect(result.data.node).toEqual({ name: "cover" });
  });
});
