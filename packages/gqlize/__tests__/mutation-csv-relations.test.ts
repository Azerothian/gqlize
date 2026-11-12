// CSV uploads reaching relationships and filters through dotted headers
// (`author.set.name`, `tags.add.name[in]`, `where.title[startsWith]`): how a
// header resolves against the input types, and how the columns under one verb
// merge into a single entry.
import {graphql} from "graphql";
import type {GraphQLSchema} from "graphql";
import Sequelize from "sequelize";
import {describe, it, expect} from "@jest/globals";
import {Ormize} from "@azerothian/ormize";

import {registerDialectAdapter} from "./helper/dialect";
import {resultData, validateResult} from "./helper";
import {createSchema} from "../src";
import type {Permission} from "../src/types/index";

type Row = {[key: string]: unknown};
type ModelCtor = {
  create(values: Row): Promise<{get(key: string): unknown}>;
  findAll(options?: Row): Promise<{get(options?: Row): Row}[]>;
};

const NO_JOIN_MODEL = (n: string) => n !== "PostTag";

async function build(permission: Permission = {}) {
  // The bag goes to both halves, as a host wires it: `createSchema` reads the
  // build-time gates that shape the input types, the instance holds the
  // resolution-time `scope` every write is checked against.
  const bag: Permission = {model: NO_JOIN_MODEL, ...permission};
  const db = new Ormize({csv: true, permission: bag});
  await registerDialectAdapter(db);
  await db.addDefinition({
    name: "Author",
    define: {name: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "hasMany", model: "Post", name: "posts", options: {foreignKey: "authorId"}}],
  });
  await db.addDefinition({
    name: "Tag",
    define: {name: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "belongsToMany", model: "Post", name: "posts", options: {through: {model: "PostTag"}, foreignKey: "tagId", otherKey: "postId"}}],
  });
  await db.addDefinition({name: "PostTag", define: {sortOrder: {type: Sequelize.INTEGER, allowNull: true}}});
  await db.addDefinition({
    name: "Comment",
    define: {body: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "belongsTo", model: "Post", name: "post", options: {foreignKey: "postId"}}],
  });
  await db.addDefinition({
    name: "Post",
    define: {title: {type: Sequelize.STRING, allowNull: false}},
    relationships: [
      {type: "belongsTo", model: "Author", name: "author", options: {foreignKey: "authorId"}},
      {type: "belongsToMany", model: "Tag", name: "tags", options: {through: {model: "PostTag"}, foreignKey: "postId", otherKey: "tagId"}},
      {type: "hasMany", model: "Comment", name: "comments", options: {foreignKey: "postId"}},
    ],
  });
  await db.initialise();
  await db.sync();
  const schema = await createSchema(db, {permission: bag});
  const models: {[name: string]: ModelCtor} = db.models;
  return {db, schema, models};
}

type Op = "createCsv" | "updateCsv" | "deleteCsv";

async function upload(schema: GraphQLSchema, arg: Op, file: string, csv?: {keys?: string[]}) {
  return graphql({
    schema,
    source: `mutation($file: GQLTUpload!, $csv: GQLTCsvOptions) { models { Post(${arg}: $file, csv: $csv) { id title } } }`,
    variableValues: {file, csv},
  });
}

async function uploaded(schema: GraphQLSchema, arg: Op, file: string, csv?: {keys?: string[]}) {
  const result = await upload(schema, arg, file, csv);
  validateResult(result);
  return resultData<{models: {Post: {id: string; title: string}[]}}>(result).models.Post;
}

async function headerError(schema: GraphQLSchema, arg: Op, file: string) {
  const result = await upload(schema, arg, file);
  expect(result.errors?.length).toBeGreaterThan(0);
  return result.errors![0].extensions;
}

type PostView = {title: string; author: {name: string} | null; tags: {name: string}[]; comments: {body: string}[]};

async function posts(schema: GraphQLSchema): Promise<PostView[]> {
  const result = await graphql({schema, source: `query { models { Post(orderBy: [titleASC]) { edges { node {
    title author { name } tags { edges { node { name } } } comments { edges { node { body } } }
  } } } } }`});
  validateResult(result);
  type Raw = {title: string; author: {name: string} | null; tags: {edges: {node: {name: string}}[]}; comments: {edges: {node: {body: string}}[]}};
  return resultData<{models: {Post: {edges: {node: Raw}[]}}}>(result).models.Post.edges.map(({node}) => ({
    title: node.title,
    author: node.author,
    tags: node.tags.edges.map((e) => e.node).sort((a, b) => a.name.localeCompare(b.name)),
    comments: node.comments.edges.map((e) => e.node).sort((a, b) => a.body.localeCompare(b.body)),
  }));
}

describe("csv mutations: relationship headers", () => {
  it("sets a belongsTo by filter, with or without the `where` segment", async() => {
    const {schema, models} = await build();
    await models.Author.create({name: "ann"});
    await models.Author.create({name: "bob"});
    await uploaded(schema, "createCsv", "title,author.set.name\np1,ann\np2,\n");
    await uploaded(schema, "createCsv", "title,author.set.where?name\np3,bob\n");
    expect((await posts(schema)).map((p) => [p.title, p.author?.name ?? null])).toEqual([
      ["p1", "ann"], ["p2", null], ["p3", "bob"],
    ]);
  });

  it("creates related rows, one entry per index, an empty entry left out", async() => {
    const {schema} = await build();
    await uploaded(schema, "createCsv", [
      "title,author.create.name,comments.create.body,comments.create[1].body",
      "p1,new-author,first,second",
      "p2,,,only",
    ].join("\n"));
    const [p1, p2] = await posts(schema);
    expect(p1).toMatchObject({author: {name: "new-author"}, comments: [{body: "first"}, {body: "second"}]});
    expect(p2).toMatchObject({author: null, comments: [{body: "only"}]});
  });

  it("merges the columns under one verb into one entry, list operators taking a|b", async() => {
    const {schema, models} = await build();
    for (const name of ["red", "green", "blue"]) {
      await models.Tag.create({name});
    }
    // PostTag is hidden here, so `tags` is a plain many-to-many: the add
    // entry is a bare filter and there is no `through` to reach.
    await uploaded(schema, "createCsv", "title,tags.add.name[in]\np1,red|blue\n");
    const [p1] = await posts(schema);
    expect(p1.tags.map((t) => t.name)).toEqual(["blue", "red"]);
    expect(await models.PostTag.findAll()).toHaveLength(2);
    expect(await headerError(schema, "createCsv", "title,tags.add.name,tags.add.through.sortOrder\np2,red,3\n"))
      .toMatchObject({code: "CSV_HEADER", column: "tags.add.through.sortOrder"});
  });

  it("writes join-row columns through tags.add.through.<column> in through mode", async() => {
    // PostTag visible: `{ where, through }` entries, `through` typed by PostTag.
    const {schema, models} = await build({model: () => true});
    for (const name of ["red", "green", "blue"]) {
      await models.Tag.create({name});
    }
    await uploaded(schema, "createCsv", "title,tags.add.name[in],tags.add.through.sortOrder\np1,red|blue,3\n");
    const [p1] = await posts(schema);
    expect(p1.tags.map((t) => t.name)).toEqual(["blue", "red"]);
    const joins = await models.PostTag.findAll();
    expect(joins.map((j) => j.get({plain: true}).sortOrder)).toEqual([3, 3]);
    // The join keys are no `through` field, so a CSV can't point a link elsewhere.
    expect(await headerError(schema, "createCsv", "title,tags.add.name,tags.add.through.tagId\np2,red,1\n"))
      .toMatchObject({code: "CSV_HEADER"});
  });

  it("checks through-mode join columns against the join model's mutationCreateInput", async() => {
    const {schema, models} = await build({
      model: () => true,
      mutationCreateInput: (model: string, field: string) => !(model === "PostTag" && field === "sortOrder"),
    });
    await models.Tag.create({name: "red"});
    expect(await headerError(schema, "createCsv", "title,tags.add.name,tags.add.through.sortOrder\np1,red,3\n"))
      .toMatchObject({code: "CSV_HEADER"});
    expect(await models.PostTag.findAll()).toEqual([]);
  });

  it("applies two operators on one field as one filter", async() => {
    const {schema, models} = await build();
    for (const name of ["ra", "rb", "x"]) {
      await models.Tag.create({name});
    }
    await uploaded(schema, "createCsv", "title,tags.set.name[Op.startsWith],tags.set.name[ne]\np1,r,rb\n");
    expect((await posts(schema))[0].tags).toEqual([{name: "ra"}]);
  });

  it("updates related rows: the where under the verb, the fields beside it", async() => {
    const {schema} = await build();
    await uploaded(schema, "createCsv", "title,comments.create.body,comments.create[1].body\np1,draft one,kept\n");
    await uploaded(schema, "updateCsv", "where.title,comments.update.where.body[like],comments.update.body\np1,draft%,edited\n");
    expect((await posts(schema))[0].comments).toEqual([{body: "edited"}, {body: "kept"}]);
  });

  it("matches the rows to update or delete on any filter, `or` included", async() => {
    const {schema} = await build();
    await uploaded(schema, "createCsv", "title\nalpha\nbeta\ngamma\n");
    const updated = await uploaded(schema, "updateCsv", "where.title[startsWith],title\nal,alpha2\n");
    expect(updated.map((p) => p.title)).toEqual(["alpha2"]);
    const deleted = await uploaded(schema, "deleteCsv", "where.or[0].title,where.or[1].title[in]\nbeta,gamma|nope\n");
    expect(deleted.map((p) => p.title).sort()).toEqual(["beta", "gamma"]);
    expect((await posts(schema)).map((p) => p.title)).toEqual(["alpha2"]);
  });

  it("refuses a header that does not resolve, before any write", async() => {
    const {schema} = await build();
    expect(await headerError(schema, "createCsv", "title,author.adopt.name\nx,y\n")).toMatchObject({code: "CSV_HEADER", column: "author.adopt.name"});
    expect(await headerError(schema, "createCsv", "title,author.create.name[in]\nx,y\n")).toMatchObject({code: "CSV_HEADER"});
    expect(await headerError(schema, "createCsv", "title,author.set.name[sounds]\nx,y\n")).toMatchObject({code: "CSV_HEADER"});
    expect(await headerError(schema, "createCsv", "title,author.set.name,author.set.where.name\nx,y,z\n")).toMatchObject({code: "CSV_HEADER"});
    expect(await headerError(schema, "createCsv", "title,where.title\nx,y\n")).toMatchObject({code: "CSV_HEADER", column: "where.title"});
    expect(await headerError(schema, "createCsv", "title,title.x\nx,y\n")).toMatchObject({code: "CSV_HEADER"});
    expect(await headerError(schema, "createCsv", "title,author..name\nx,y\n")).toMatchObject({code: "CSV_HEADER"});
    expect((await posts(schema))).toEqual([]);
  });

  it("rolls everything back when a related write fails", async() => {
    const {schema} = await build();
    const result = await upload(schema, "createCsv", "title,comments.create.body\np1,ok\np2,\\N\n");
    expect(result.errors?.[0].extensions).toMatchObject({row: 2});
    expect(await posts(schema)).toEqual([]);
  });
});

describe("csv mutations: relationship headers under permissions", () => {
  // Each case denies one gate and checks both halves: the header is refused
  // before anything runs, and the related model is left as it was.

  async function authorIds(models: {[name: string]: ModelCtor}) {
    return (await models.Post.findAll()).map((p) => p.get({plain: true}).authorId ?? null);
  }

  it("refuses a relationship the create input does not offer", async() => {
    const {schema, models} = await build({mutationCreateInput: (d, f) => !(d === "Post" && f === "author")});
    await models.Author.create({name: "ann"});
    expect(await headerError(schema, "createCsv", "title,author.set.name\np1,ann\n")).toMatchObject({code: "CSV_HEADER", column: "author.set.name"});
    expect(await headerError(schema, "createCsv", "title,author.create.name\np1,new\n")).toMatchObject({code: "CSV_HEADER"});
    expect(await models.Post.findAll()).toEqual([]);
    expect((await models.Author.findAll()).map((a) => a.get({plain: true}).name)).toEqual(["ann"]);
  });

  it("refuses a relationship the update input does not offer", async() => {
    const {schema, models} = await build({mutationUpdateInput: (d, f) => !(d === "Post" && f === "comments")});
    await uploaded(schema, "createCsv", "title,comments.create.body\np1,original\n");
    expect(await headerError(schema, "updateCsv", "where.title,comments.update.body\np1,changed\n")).toMatchObject({code: "CSV_HEADER"});
    expect((await models.Comment.findAll()).map((c) => c.get({plain: true}).body)).toEqual(["original"]);
  });

  it("refuses creating a related model the caller may not create", async() => {
    const {schema, models} = await build({mutationCreate: (d) => d !== "Comment"});
    expect(await headerError(schema, "createCsv", "title,comments.create.body\np1,hello\n")).toMatchObject({code: "CSV_HEADER"});
    expect(await models.Comment.findAll()).toEqual([]);
    expect(await models.Post.findAll()).toEqual([]);
  });

  it("refuses updating or deleting a related model the caller may not", async() => {
    const {schema, models} = await build({mutationUpdate: (d) => d !== "Comment", mutationDelete: (d) => d !== "Comment"});
    await uploaded(schema, "createCsv", "title,comments.create.body\np1,original\n");
    expect(await headerError(schema, "updateCsv", "where.title,comments.update.where.body,comments.update.body\np1,original,changed\n")).toMatchObject({code: "CSV_HEADER"});
    expect(await headerError(schema, "updateCsv", "where.title,comments.delete.body\np1,original\n")).toMatchObject({code: "CSV_HEADER"});
    expect((await models.Comment.findAll()).map((c) => c.get({plain: true}).body)).toEqual(["original"]);
  });

  it("refuses a related model hidden from the schema", async() => {
    const {schema, models} = await build({model: (d) => d !== "Tag" && NO_JOIN_MODEL(d)});
    await models.Tag.create({name: "red"});
    expect(await headerError(schema, "createCsv", "title,tags.add.name\np1,red\n")).toMatchObject({code: "CSV_HEADER"});
    expect(await models.PostTag.findAll()).toEqual([]);
  });

  it("refuses filtering a related model on a field the caller may not see", async() => {
    const {schema, models} = await build({field: (d, f) => !(d === "Author" && f === "name")});
    await models.Author.create({name: "ann"});
    // Matching on a hidden field is reading it: a set that succeeded or not
    // would say whether an author by that name exists.
    expect(await headerError(schema, "createCsv", "title,author.set.name\np1,ann\n")).toMatchObject({code: "CSV_HEADER"});
    expect(await headerError(schema, "updateCsv", "where.author.name,title\nann,x\n")).toMatchObject({code: "CSV_HEADER"});
    expect(await models.Post.findAll()).toEqual([]);
  });

  it("does not link a related row outside the caller's scope", async() => {
    const {schema, models} = await build({
      scope: (d) => (d === "Author" ? {name: {eq: "ann"}} : undefined),
    });
    await models.Author.create({name: "ann"});
    const bob = await models.Author.create({name: "bob"});
    await upload(schema, "createCsv", "title,author.set.name\np1,bob\n");
    expect(await authorIds(models)).not.toContain(bob.get("id"));
  });

  it("does not update or delete related rows outside the caller's scope", async() => {
    const {schema, models} = await build({
      scope: (d) => (d === "Comment" ? {body: {notLike: "secret%"}} : undefined),
    });
    await uploaded(schema, "createCsv", "title,comments.create.body\np1,public\n");
    const [post] = await models.Post.findAll();
    await models.Comment.create({body: "secret note", postId: post.get({plain: true}).id});
    await upload(schema, "updateCsv", "where.title,comments.update.where.body[like],comments.update.body\np1,%,rewritten\n");
    await upload(schema, "updateCsv", "where.title,comments.delete.body[like]\np1,%\n");
    const bodies = (await models.Comment.findAll()).map((c) => c.get({plain: true}).body);
    expect(bodies).toContain("secret note");
  });
});
