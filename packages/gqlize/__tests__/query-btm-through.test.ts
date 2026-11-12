/**
 * Reading a belongsToMany in through mode: each edge carries its join row
 * (`through`), edges filter and order by join columns (`throughWhere`,
 * `throughOrderBy`), `required` filters parents by them, and a join row the
 * join model's read rules hide is no edge at all. A hidden or implicit join
 * model reads as a plain many-to-many.
 */
import {graphql, GraphQLObjectType, type GraphQLSchema} from "graphql";
import Sequelize from "sequelize";
import {Ormize as Database} from "@azerothian/ormize";
import type {ScopePredicate} from "@azerothian/utilize";
import {createSchema} from "../src";
import {registerDialectAdapter} from "./helper/dialect";
import {describe, it, expect} from "@jest/globals";
import type {Definition, GqlizeOptions} from "../src/types";

function defs(registeredJoin: boolean): Definition[] {
  const through = registeredJoin ? {model: "PostTag"} : "PostTagImplicit";
  const out: Definition[] = [
    {name: "Post", define: {title: {type: Sequelize.STRING, allowNull: false}},
      relationships: [{type: "belongsToMany", model: "Tag", name: "tags", options: {through, foreignKey: "postId", otherKey: "tagId"}}]},
    {name: "Tag", define: {name: {type: Sequelize.STRING, allowNull: false}},
      relationships: [{type: "belongsToMany", model: "Post", name: "posts", options: {through, foreignKey: "tagId", otherKey: "postId"}}]},
  ];
  if (registeredJoin) {
    out.push({name: "PostTag", define: {
      sortOrder: {type: Sequelize.INTEGER, allowNull: true},
      label: {type: Sequelize.STRING, allowNull: true},
      hidden: {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false},
    }});
  }
  return out;
}

type Linkable = {addTags: (t: unknown[], o?: unknown) => Promise<void>};

/**
 * p1 → t1 (2, "a"), t2 (1, "b"), t3 (3, hidden); p2 → t2 (5). Built through
 * the Sequelize accessors so the fixture does not depend on the verbs under test.
 */
async function build(registeredJoin: boolean, permission?: GqlizeOptions["permission"]) {
  const db = new Database(permission ? {permission} : {});
  await registerDialectAdapter(db);
  for (const d of defs(registeredJoin)) {
    await db.addDefinition(d);
  }
  await db.initialise();
  await db.sync();
  const {Post, Tag} = db.models;
  const p1 = await Post.create({title: "p1"}) as unknown as Linkable;
  const p2 = await Post.create({title: "p2"}) as unknown as Linkable;
  const [t1, t2, t3] = [await Tag.create({name: "t1"}), await Tag.create({name: "t2"}), await Tag.create({name: "t3"})];
  if (registeredJoin) {
    await p1.addTags([t1], {through: {sortOrder: 2, label: "a"}});
    await p1.addTags([t2], {through: {sortOrder: 1, label: "b"}});
    await p1.addTags([t3], {through: {sortOrder: 3, hidden: true}});
    await p2.addTags([t2], {through: {sortOrder: 5}});
  } else {
    await p1.addTags([t1, t2, t3]);
    await p2.addTags([t2]);
  }
  return db;
}

async function run(schema: GraphQLSchema, source: string) {
  const res = await graphql({schema, source});
  if (res.errors?.length) {
    throw res.errors[0];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions walk the result by field name
  return res.data as any;
}

type Edge = {node: {name: string}; through?: {sortOrder: number | null; label: string | null}};

/** The tags edges of post `title`, given the connection's argument list. */
async function tagsOf(schema: GraphQLSchema, title: string, args = "", edge = "through { sortOrder label } node { name }") {
  const data = await run(schema, `{ models { Post(where: {title: {eq: "${title}"}}) { edges { node {
    tags${args ? `(${args})` : ""} { total pageInfo { hasNextPage } edges { cursor ${edge} } }
  } } } } }`);
  return data.models.Post.edges[0].node.tags as {total: number; pageInfo: {hasNextPage: boolean}; edges: (Edge & {cursor: string})[]};
}

const names = (edges: Edge[]) => edges.map((e) => e.node.name);

/** PostTag rows marked `hidden` are out of the read scope. */
const hideMarked: ScopePredicate = (defName, operation) =>
  defName === "PostTag" && operation === "read" ? {where: {hidden: {eq: false}}} : undefined;

describe("belongsToMany through — reads", () => {
  it("puts the join row on each edge", async () => {
    const schema = await createSchema(await build(true), {});
    const tags = await tagsOf(schema, "p1", "orderBy: nameASC");
    expect(tags.total).toBe(3);
    expect(tags.edges.map((e) => [e.node.name, e.through])).toEqual([
      ["t1", {sortOrder: 2, label: "a"}],
      ["t2", {sortOrder: 1, label: "b"}],
      ["t3", {sortOrder: 3, label: null}],
    ]);
  });

  it("names the connection after the parent, so the edge type is its own", async () => {
    const schema = await createSchema(await build(true), {});
    const edge = schema.getType("PostTagBelongsToManyTagsEdge") as GraphQLObjectType;
    expect(Object.keys(edge.getFields()).sort()).toEqual(["cursor", "node", "through"]);
    expect(String(edge.getFields().through.type)).toBe("PostTag");
  });

  it("throughWhere filters edges, and total with them", async () => {
    const schema = await createSchema(await build(true), {});
    const tags = await tagsOf(schema, "p1", "throughWhere: {sortOrder: {gte: 2}}, orderBy: nameASC");
    expect(names(tags.edges)).toEqual(["t1", "t3"]);
    expect(tags.total).toBe(2);
  });

  it("throughOrderBy orders edges by join columns and pages across them", async () => {
    const schema = await createSchema(await build(true), {});
    const all = await tagsOf(schema, "p1", "throughOrderBy: sortOrderDESC");
    expect(names(all.edges)).toEqual(["t3", "t1", "t2"]);
    const first = await tagsOf(schema, "p1", "throughOrderBy: sortOrderASC, first: 2");
    expect(names(first.edges)).toEqual(["t2", "t1"]);
    expect(first.pageInfo.hasNextPage).toBe(true);
    expect(first.total).toBe(3);
    const next = await tagsOf(schema, "p1", `throughOrderBy: sortOrderASC, first: 2, after: "${first.edges[1].cursor}"`);
    expect(names(next.edges)).toEqual(["t3"]);
    expect(next.pageInfo.hasNextPage).toBe(false);
  });

  it("a join row the join model's read scope hides is no edge", async () => {
    const schema = await createSchema(await build(true, {scope: hideMarked}), {});
    const tags = await tagsOf(schema, "p1", "orderBy: nameASC");
    expect(names(tags.edges)).toEqual(["t1", "t2"]);
    expect(tags.total).toBe(2);
    // The other side reads the same join rows.
    const data = await run(schema, `{ models { Tag(where: {name: {eq: "t3"}}) { edges { node { posts { total } } } } } }`);
    expect(data.models.Tag.edges[0].node.posts.total).toBe(0);
  });

  it("required filters parents by a visible matching link", async () => {
    const schema = await createSchema(await build(true, {scope: hideMarked}), {});
    const titles = async(args: string) => (await run(schema, `{ models { Post(orderBy: titleASC) { edges { node { title
      tags(${args}) { edges { node { name } } } } } } } }`)).models.Post.edges.map((e: {node: {title: string}}) => e.node.title);
    expect(await titles("required: true, throughWhere: {sortOrder: {eq: 5}}")).toEqual(["p2"]);
    expect(await titles("required: true, throughWhere: {sortOrder: {gte: 1}}")).toEqual(["p1", "p2"]);
    // p1's only link with sortOrder 3 is hidden, so it is no link.
    expect(await titles("required: true, throughWhere: {sortOrder: {eq: 3}}")).toEqual([]);
    // Combined with a filter on the target.
    expect(await titles("required: true, where: {name: {eq: \"t1\"}}")).toEqual(["p1"]);
  });
});

describe("belongsToMany through — plain mode", () => {
  it("a join model hidden by permission.model offers no through, but still hides scoped links", async () => {
    const schema = await createSchema(await build(true, {scope: hideMarked}), {permission: {model: (n: string) => n !== "PostTag"}});
    const list = schema.getType("PostTagBelongsToManyTagsList");
    expect(list).toBeUndefined();
    const tags = await tagsOf(schema, "p1", "orderBy: nameASC", "node { name }");
    expect(names(tags.edges)).toEqual(["t1", "t2"]);
  });

  it("an implicit join table offers no through", async () => {
    const schema = await createSchema(await build(false), {});
    expect(schema.getType("PostTagBelongsToManyTagsList")).toBeUndefined();
    const tags = await tagsOf(schema, "p1", "orderBy: nameASC", "node { name }");
    expect(names(tags.edges)).toEqual(["t1", "t2", "t3"]);
    await expect(run(schema, `{ models { Post { edges { node { tags(throughWhere: {}) { total } } } } } }`)).rejects.toThrow(/throughWhere/);
  });
});
