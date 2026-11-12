// The root `csvImport` mutation: several CSV files, each a create or an update
// on its own model, applied as one unit, rows linked across files (and within
// one) by `@ref` labels.
import {graphql} from "graphql";
import type {GraphQLEnumType, GraphQLSchema} from "graphql";
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
  count(): Promise<number>;
};

const NO_JOIN_MODEL = (n: string) => n !== "PostTag";

async function build(permission: Permission = {}, csv: boolean | {maxFiles?: number} = true) {
  const bag: Permission = {model: NO_JOIN_MODEL, ...permission};
  const db = new Ormize({csv, permission: bag});
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
    define: {
      body: {type: Sequelize.STRING, allowNull: false},
      // Writable so a reference can fill the foreign key itself.
      postId: {type: Sequelize.INTEGER, allowNull: true, writable: true},
    },
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
  await db.addDefinition({
    name: "Category",
    define: {name: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "belongsTo", model: "Category", name: "parent", options: {foreignKey: "parentId"}}],
  });
  await db.initialise();
  await db.sync();
  const schema = await createSchema(db, {permission: bag});
  const models: {[name: string]: ModelCtor} = db.models;
  return {db, schema, models};
}

type FileArg = {model: string; operation: "create" | "update"; file: string; name?: string; keys?: string[]};
type ImportResult = {
  files: {name: string; model: string; operation: string; count: number; ids: string[]}[];
  refs: {[label: string]: string};
};

async function run(schema: GraphQLSchema, files: FileArg[]) {
  return graphql({
    schema,
    source: `mutation($files: [CsvImportFile!]!) { csvImport(files: $files) {
      files { name model operation count ids } refs
    } }`,
    variableValues: {files},
  });
}

async function imported(schema: GraphQLSchema, files: FileArg[]): Promise<ImportResult> {
  const result = await run(schema, files);
  validateResult(result);
  return resultData<{csvImport: ImportResult}>(result).csvImport;
}

async function refused(schema: GraphQLSchema, files: FileArg[]) {
  const result = await run(schema, files);
  expect(result.errors?.length).toBeGreaterThan(0);
  return result.errors![0];
}

type PostView = {title: string; author: {name: string} | null; tags: string[]; comments: string[]};

async function posts(schema: GraphQLSchema): Promise<PostView[]> {
  const result = await graphql({schema, source: `query { models { Post(orderBy: [titleASC]) { edges { node {
    title author { name } tags { edges { node { name } } } comments { edges { node { body } } }
  } } } } }`});
  validateResult(result);
  type Raw = {title: string; author: {name: string} | null; tags: {edges: {node: {name: string}}[]}; comments: {edges: {node: {body: string}}[]}};
  return resultData<{models: {Post: {edges: {node: Raw}[]}}}>(result).models.Post.edges.map(({node}) => ({
    title: node.title,
    author: node.author,
    tags: node.tags.edges.map((e) => e.node.name).sort(),
    comments: node.comments.edges.map((e) => e.node.body).sort(),
  }));
}

const AUTHORS: FileArg = {model: "Author", operation: "create", file: "@ref,name\na1,Ann\na2,Bob\n"};
const TAGS: FileArg = {model: "Tag", operation: "create", file: "@ref,name\nt1,red\nt2,blue\n"};

describe("csvImport", () => {
  it("is offered only when CSV is on", async() => {
    const {schema} = await build({}, false);
    expect(schema.getMutationType()?.getFields().csvImport).toBeUndefined();
    const on = await build();
    expect(on.schema.getMutationType()?.getFields().csvImport).toBeDefined();
  });

  it("links rows across files by label, writing the referenced files first", async() => {
    const {schema} = await build();
    // Given referencing-first: the order comes from the references, not the list.
    const result = await imported(schema, [
      {model: "Post", operation: "create", file: "@ref,title,author.@ref,tags.@ref\np1,Hello,a1,t1|t2\np2,Bye,a2,\n"},
      TAGS,
      AUTHORS,
    ]);
    expect(result.files.map((f) => [f.name, f.count])).toEqual([["Post.create", 2], ["Tag.create", 2], ["Author.create", 2]]);
    expect(Object.keys(result.refs).sort()).toEqual(["a1", "a2", "p1", "p2", "t1", "t2"]);
    expect(result.files[0].ids).toEqual([result.refs.p1, result.refs.p2]);
    expect(await posts(schema)).toEqual([
      {title: "Bye", author: {name: "Bob"}, tags: [], comments: []},
      {title: "Hello", author: {name: "Ann"}, tags: ["blue", "red"], comments: []},
    ]);
  });

  it("links a through-mode belongsToMany by label, its join columns in the same entry", async() => {
    // PostTag visible: `tags.@ref` fills the `where` of a `{ where, through }`
    // add entry, and `tags.add.through.sortOrder` the `through` beside it.
    const {schema, models} = await build({model: () => true});
    await imported(schema, [
      {model: "Post", operation: "create", file: "title,tags.@ref,tags.add.through.sortOrder\nHello,t1|t2,4\n"},
      TAGS,
    ]);
    expect((await posts(schema))[0].tags).toEqual(["blue", "red"]);
    const joins = await models.PostTag.findAll();
    expect(joins.map((j) => j.get({plain: true}).sortOrder)).toEqual([4, 4]);
  });

  it("fills a foreign key or a verb's filter from a reference", async() => {
    const {schema} = await build();
    await imported(schema, [
      {model: "Post", operation: "create", file: "@ref,title\np1,One\np2,Two\n"},
      {model: "Comment", operation: "create", file: "body,postId.@ref\nby-key,p1\n"},
      {model: "Comment", operation: "create", file: "body,post.set.@ref\nby-verb,p2\n"},
    ]);
    expect((await posts(schema)).map((p) => [p.title, p.comments])).toEqual([["One", ["by-key"]], ["Two", ["by-verb"]]]);
  });

  it("labels the rows an update matched, for later files to point at", async() => {
    const {schema} = await build();
    await imported(schema, [{model: "Post", operation: "create", file: "title\nexisting\n"}]);
    await imported(schema, [
      {model: "Post", operation: "update", file: "@ref,where.title,title\np1,existing,renamed\n"},
      {model: "Comment", operation: "create", file: "body,post.@ref\nnew comment,p1\n"},
    ]);
    expect(await posts(schema)).toEqual([{title: "renamed", author: null, tags: [], comments: ["new comment"]}]);
  });

  it("lets a row point at an earlier row of its own file, but not a later one", async() => {
    const {schema, models} = await build();
    await imported(schema, [{model: "Category", operation: "create", file: "@ref,name,parent.@ref\nc1,root,\nc2,child,c1\n"}]);
    const rows = (await models.Category.findAll()).map((c) => c.get({plain: true}));
    const root = rows.find((r) => r.name === "root");
    expect(rows.find((r) => r.name === "child")?.parentId).toBe(root?.id);

    const error = await refused(schema, [{model: "Category", operation: "create", file: "@ref,name,parent.@ref\nx2,child,x1\nx1,root,\n"}]);
    expect(error.extensions).toMatchObject({code: "CSV_ROW_INVALID", row: 1, column: "parent.@ref", file: "Category.create"});
  });

  it("refuses an unknown or repeated label, and files that refer to each other", async() => {
    const {schema} = await build();
    expect((await refused(schema, [{model: "Post", operation: "create", file: "title,author.@ref\nx,nobody\n"}])).extensions)
      .toMatchObject({code: "CSV_ROW_INVALID", column: "author.@ref", file: "Post.create"});
    expect((await refused(schema, [AUTHORS, {model: "Author", operation: "create", name: "more", file: "@ref,name\na1,Again\n"}])).extensions)
      .toMatchObject({code: "CSV_ROW_INVALID", column: "@ref", file: "more"});
    const cycle = await refused(schema, [
      {model: "Author", operation: "create", file: "@ref,name,posts.@ref\na1,Ann,p1\n"},
      {model: "Post", operation: "create", file: "@ref,title,author.@ref\np1,Hello,a1\n"},
    ]);
    expect(cycle.extensions).toMatchObject({code: "CSV_HEADER"});
    expect(cycle.message).toMatch(/cycle/);
    expect(await posts(schema)).toEqual([]);
  });

  it("writes nothing when a later file fails", async() => {
    const {schema, models} = await build();
    const error = await refused(schema, [
      AUTHORS,
      {model: "Post", operation: "create", file: "title,author.@ref\nok,a1\n"},
      {model: "Comment", operation: "create", file: "body\n\\N\n"},
    ]);
    expect(error.extensions).toMatchObject({file: "Comment.create", row: 1});
    expect(await models.Author.count()).toBe(0);
    expect(await models.Post.count()).toBe(0);
  });

  it("refuses a reference outside an import, and a reference used as a match column", async() => {
    const {schema} = await build();
    const single = await graphql({schema, source: `mutation($f: GQLTUpload!) { models { Post(createCsv: $f) { id } } }`, variableValues: {f: "title,author.@ref\nx,a1\n"}});
    expect(single.errors?.[0].extensions).toMatchObject({code: "CSV_HEADER", column: "author.@ref"});
    expect((await refused(schema, [AUTHORS, {model: "Post", operation: "update", keys: ["author.@ref"], file: "author.@ref,title\na1,x\n"}])).extensions)
      .toMatchObject({code: "CSV_HEADER", file: "Post.update"});
  });

  it("holds to the file limit", async() => {
    const {schema} = await build({}, {maxFiles: 1});
    expect((await refused(schema, [AUTHORS, TAGS])).extensions).toMatchObject({code: "CSV_TOO_MANY_FILES"});
  });
});

describe("csvImport under permissions", () => {
  it("leaves out a model without CSV, and refuses an operation its field does not take", async() => {
    const {schema, models} = await build({mutationCsv: (d) => d !== "Tag", mutationUpdate: (d) => d !== "Author"});
    const values = (schema.getType("CsvImportModel") as GraphQLEnumType).getValues().map((v) => v.name);
    expect(values).not.toContain("Tag");
    expect(values).toContain("Author");
    const error = await refused(schema, [AUTHORS, {model: "Author", operation: "update", file: "id,name\nx,y\n"}]);
    expect(error.extensions).toMatchObject({code: "CSV_UNSUPPORTED", file: "Author.update"});
    expect(await models.Author.count()).toBe(0);
  });

  it("refuses a reference through a relationship the input does not offer", async() => {
    const {schema, models} = await build({mutationCreateInput: (d, f) => !(d === "Post" && f === "author")});
    const error = await refused(schema, [AUTHORS, {model: "Post", operation: "create", file: "title,author.@ref\nx,a1\n"}]);
    expect(error.extensions).toMatchObject({code: "CSV_HEADER", column: "author.@ref", file: "Post.create"});
    expect(await models.Author.count()).toBe(0);
  });

  it("does not link a labelled row the caller's scope hides from the target", async() => {
    const {schema, models} = await build({scope: (d, op) => (d === "Author" && op !== "create" ? {name: {eq: "Ann"}} : undefined)});
    await run(schema, [AUTHORS, {model: "Post", operation: "create", file: "title,author.@ref\nby-bob,a2\n"}]);
    const bob = (await models.Author.findAll()).map((a) => a.get({plain: true})).find((a) => a.name === "Bob");
    const linked = (await models.Post.findAll()).map((p) => p.get({plain: true}).authorId);
    expect(linked).not.toContain(bob?.id);
  });
});
