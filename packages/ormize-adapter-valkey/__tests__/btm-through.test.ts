/**
 * belongsToMany `through` on the Valkey adapter and on a cross-adapter
 * belongsToMany: a payload never writes the join keys or the join row's
 * primary key, an implicit or generated join table makes a plain
 * many-to-many, and a generated join model is exposed by no projection.
 *
 * Regression tests for payloads that used to point a new link at a row the
 * caller never named (both adapters put the caller's values after the keys).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { graphql } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { dialectConfig, trackConnection, testDialect } from "@azerothian/test-fixtures/dialect";
import type IORedis from "ioredis";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

type Row = { [field: string]: unknown };
let client: IORedis;

beforeAll(async () => { client = await makeClient(); });
beforeEach(async () => { await flush(client); });
afterAll(async () => { await shutdown(); });

async function createOne(orm: Ormize, model: string, input: Row): Promise<Row> {
  const [row] = await orm.processCreate(model, null, { input }, {}, undefined);
  return row as Row;
}

/** Valkey-only belongsToMany, through an implicit join table or a registered one. */
async function buildValkey(prefix: string, registeredJoin = false) {
  const orm = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix }, client), "valkey");
  const through = "PostTagV";
  if (registeredJoin) {
    await orm.addDefinition({ name: through, define: { sortOrder: { type: DataTypes.Int, index: true } }, options: {} }, "valkey");
  }
  await orm.addDefinition({ name: "Post", define: { id: { type: DataTypes.UUID, primaryKey: true }, title: { type: DataTypes.String, index: true } }, options: {},
    relationships: [{ type: "belongsToMany", model: "Tag", name: "tags", options: { through, foreignKey: "postId", otherKey: "tagId" } }] }, "valkey");
  await orm.addDefinition({ name: "Tag", define: { id: { type: DataTypes.UUID, primaryKey: true }, name: { type: DataTypes.String, index: true } }, options: {},
    relationships: [{ type: "belongsToMany", model: "Post", name: "posts", options: { through, foreignKey: "tagId", otherKey: "postId" } }] }, "valkey");
  await orm.initialise();
  await orm.sync();
  return orm;
}

/** Post on Valkey, Tag on SQL, no join model declared: ormize generates one. */
async function buildCross(prefix: string) {
  const orm = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix }, client), "valkey");
  const sql = new SequelizeAdapter({}, await dialectConfig());
  trackConnection(sql);
  orm.registerAdapter(sql, testDialect());
  await orm.addDefinition({ name: "Post", define: { id: { type: DataTypes.UUID, primaryKey: true }, title: { type: DataTypes.String, index: true } }, options: {},
    relationships: [{ type: "belongsToMany", model: "Tag", name: "tags", options: { foreignKey: "postId", otherKey: "tagId" } }] }, "valkey");
  await orm.addDefinition({ name: "Tag", define: { name: { type: Sequelize.STRING } }, options: { timestamps: false },
    relationships: [{ type: "belongsToMany", model: "Post", name: "posts", options: { foreignKey: "tagId", otherKey: "postId" } }] }, testDialect());
  await orm.initialise();
  await orm.sync();
  return orm;
}

const addWithThrough = (orm: Ormize, title: string, tag: string, through: Row) =>
  orm.processUpdate("Post", null, { where: { title: { eq: title } }, input: { tags: { add: [{ where: { name: { eq: tag } }, through }] } } }, {}, undefined);

async function joinRows(orm: Ormize, name: string): Promise<Row[]> {
  return await orm.getModelAdapter(name).findAll(name, {}) as Row[];
}

/** Seed `mine` and `victim` posts and a `t1` tag. */
async function seed(orm: Ormize) {
  const victim = await createOne(orm, "Post", { title: "victim" });
  const mine = await createOne(orm, "Post", { title: "mine" });
  const tag = await createOne(orm, "Tag", { name: "t1" });
  return { victim, mine, tag };
}

describe("valkey belongsToMany through", () => {
  it("an implicit join table is a plain many-to-many: { where, through } is refused", async () => {
    const orm = await buildValkey("btm-v1");
    await seed(orm);
    expect(orm.getAssociations("Post").tags.throughModel).toBe(false);
    await expect(addWithThrough(orm, "mine", "t1", { postId: "x" })).rejects.toThrow(/carries no join-row data/);
  });

  it("the adapter writes the join keys after the payload", async () => {
    const orm = await buildValkey("btm-v2");
    const { victim, mine, tag } = await seed(orm);
    const adapter = orm.getModelAdapter("Post");
    const [row] = await adapter.findAll("Post", { where: { id: mine.id } }) as Row[];
    const addTags = row[orm.getAssociations("Post").tags.accessors.addMultiple] as (t: Row[], o: Row) => Promise<void>;
    await addTags.call(row, [tag], { through: { postId: victim.id, tagId: "forged", id: "forged" } });
    const rows = await adapter.findAll("PostTagV", {}) as Row[];
    expect(rows.map((r) => [r.postId, r.tagId])).toEqual([[mine.id, tag.id]]);
    expect(rows[0].id).not.toBe("forged");
  });

  it("a registered join model takes through and refuses a join key", async () => {
    const orm = await buildValkey("btm-v3", true);
    const { victim, mine, tag } = await seed(orm);
    expect(orm.getAssociations("Post").tags.throughModel).toBe(true);
    await addWithThrough(orm, "mine", "t1", { sortOrder: 4 });
    // On the now-existing link: a payload naming a join key is refused outright.
    await expect(addWithThrough(orm, "mine", "t1", { postId: victim.id, sortOrder: 5 })).rejects.toThrow(/may not write 'postId'/);
    await addWithThrough(orm, "mine", "t1", { sortOrder: 5 });
    const rows = await joinRows(orm, "PostTagV");
    expect(rows.map((r) => [r.postId, r.tagId, Number(r.sortOrder)])).toEqual([[mine.id, tag.id, 5]]);
  });

  it("set gives each entry its own through", async () => {
    const orm = await buildValkey("btm-v4", true);
    const { mine } = await seed(orm);
    const t2 = await createOne(orm, "Tag", { name: "t2" });
    await orm.processUpdate("Post", null, { where: { title: { eq: "mine" } }, input: { tags: { set: [
      { where: { name: { eq: "t1" } }, through: { sortOrder: 1 } },
      { where: { name: { eq: "t2" } }, through: { sortOrder: 2 } },
    ] } } }, {}, undefined);
    const rows = (await joinRows(orm, "PostTagV")).filter((r) => r.postId === mine.id);
    expect(Object.fromEntries(rows.map((r) => [r.tagId, Number(r.sortOrder)]))[t2.id as string]).toBe(2);
    expect(rows.map((r) => Number(r.sortOrder)).sort()).toEqual([1, 2]);
  });
});

describe("cross-adapter generated join model", () => {
  it("is a plain many-to-many: { where, through } is refused", async () => {
    const orm = await buildCross("btm-x1");
    await seed(orm);
    expect(orm.getAssociations("Post").tags.throughModel).toBe(false);
    await expect(addWithThrough(orm, "mine", "t1", { postId: "x" })).rejects.toThrow(/carries no join-row data/);
  });

  it("the cross-adapter accessor writes the join keys after the payload", async () => {
    const orm = await buildCross("btm-x2");
    const { victim, mine } = await seed(orm);
    const assoc = orm.getAssociations("Post").tags;
    const [post] = await orm.getModelAdapter("Post").findAll("Post", { where: { id: mine.id } }) as Row[];
    const [tag] = await orm.getModelAdapter("Tag").findAll("Tag", {}) as Row[];
    const add = post[assoc.accessors.addMultiple] as (t: Row[], o: Row) => Promise<void>;
    await add.call(post, [tag], { through: { postId: victim.id, tagId: 999 } });
    const rows = await joinRows(orm, assoc.through as string);
    expect(rows.map((r) => r.postId)).toEqual([mine.id]);
  });

  it("is not exposed by GraphQL (REST, Zod and Temporal: see their own suites)", async () => {
    const orm = await buildCross("btm-x3");
    const through = orm.getAssociations("Post").tags.through as string;
    expect(orm.getDefinition(through)?.generated).toBe(true);
    const schema = await createSchema(orm);
    expect(schema.getType(through)).toBeUndefined();
    expect(schema.getType(`${through}RequiredInput`)).toBeUndefined();
    // The relationship itself is still there, as a plain many-to-many.
    expect(schema.getType("PostTagsBelongsToManyInput")).toBeDefined();
  });
});

describe("valkey belongsToMany through — reads", () => {
  /** mine → t1 (2), t2 (1); victim → t2 (5). */
  async function linked(prefix: string) {
    const orm = await buildValkey(prefix, true);
    await seed(orm);
    await createOne(orm, "Tag", { name: "t2" });
    await addWithThrough(orm, "mine", "t1", { sortOrder: 2 });
    await addWithThrough(orm, "mine", "t2", { sortOrder: 1 });
    await addWithThrough(orm, "victim", "t2", { sortOrder: 5 });
    return createSchema(orm);
  }
  const query = async (schema: Awaited<ReturnType<typeof linked>>, source: string) => {
    const res = await graphql({ schema, source });
    expect(res.errors).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- walked by field name
    return res.data as any;
  };

  it("puts the join row on each edge and orders by it", async () => {
    const schema = await linked("btm-r1");
    const data = await query(schema, `{ models { Post(where: {title: {eq: "mine"}}) { edges { node {
      tags(throughOrderBy: sortOrderDESC) { total edges { through { sortOrder } node { name } } } } } } } }`);
    const tags = data.models.Post.edges[0].node.tags;
    expect(tags.total).toBe(2);
    expect(tags.edges.map((e: { node: { name: string }; through: { sortOrder: number } }) => [e.node.name, e.through.sortOrder]))
      .toEqual([["t1", 2], ["t2", 1]]);
  });

  it("required filters parents by join columns", async () => {
    const schema = await linked("btm-r2");
    const data = await query(schema, `{ models { Post { edges { node { title
      tags(required: true, throughWhere: {sortOrder: {eq: 5}}) { edges { node { name } } } } } } } }`);
    expect(data.models.Post.edges.map((e: { node: { title: string } }) => e.node.title)).toEqual(["victim"]);
  });
});
