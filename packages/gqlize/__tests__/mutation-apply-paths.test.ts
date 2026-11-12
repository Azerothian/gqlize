// Instance-method transforms (`apply`) reached from every write path that can
// run them: an `update` with no `input`, a CSV update with only key columns,
// and a file of a `csvImport`. Plus the engine's own check, for a host that
// calls the write methods directly.
import {graphql, GraphQLString} from "graphql";
import type {GraphQLInputObjectType, GraphQLObjectType, GraphQLSchema} from "graphql";
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

/**
 * `Badge` has a `stamp` transform (no args) and a `label` transform (with an
 * argument), and a `posts` relationship to `Post`.
 */
async function build(permission: Permission = {}) {
  const db = new Ormize({csv: true, permission});
  await registerDialectAdapter(db);
  await db.addDefinition({
    name: "Badge",
    define: {
      name: {type: Sequelize.STRING, allowNull: false},
      note: {type: Sequelize.STRING, allowNull: true},
    },
    relationships: [{type: "hasMany", model: "Post", name: "posts", options: {foreignKey: "badgeId"}}],
    expose: {instanceMethods: {mutations: {
      stamp: {},
      label: {args: {text: {type: GraphQLString}}},
    }}},
    instanceMethods: {
      stamp() {
        return {note: "stamped"};
      },
      label(args: {text?: string}) {
        return {note: `label:${args.text}`};
      },
    },
  });
  await db.addDefinition({
    name: "Post",
    define: {title: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "belongsTo", model: "Badge", name: "badge", options: {foreignKey: "badgeId"}}],
  });
  await db.initialise();
  await db.sync();
  const schema = await createSchema(db, {permission});
  const models: {[name: string]: ModelCtor} = db.models;
  return {db, schema, models};
}

const fieldArgs = (schema: GraphQLSchema, model: string) =>
  (schema.getMutationType()?.getFields().models.type as GraphQLObjectType).getFields()[model].args.map((a) => a.name);

const notes = async(models: {[name: string]: ModelCtor}) =>
  (await models.Badge.findAll({order: [["id", "ASC"]]})).map((r) => r.get({plain: true}).note);

// Badge may be updated, but none of its columns or its relationship may be
// written by hand: its only writes are its transforms.
const transformOnly: Permission = {
  mutationCreate: (d: string) => d !== "Badge",
  mutationUpdateInput: (d: string) => d !== "Badge",
  mutationCreateInput: (d: string) => d !== "Badge",
};

describe("apply: a model whose only writes are its transforms", () => {
  it("keeps `update`, with where and limit but no input, and no `select`", async() => {
    const {schema} = await build(transformOnly);
    const args = fieldArgs(schema, "Badge");
    expect(args).toEqual(expect.arrayContaining(["update", "apply"]));
    expect(args).not.toContain("select");
    expect(args).not.toContain("create");
    const update = schema.getType("BadgeUpdateInput") as GraphQLInputObjectType;
    expect(Object.keys(update.getFields()).sort()).toEqual(["limit", "where"]);
  });

  it("runs the transforms on the matched rows", async() => {
    const {schema, models} = await build(transformOnly);
    await models.Badge.create({name: "a"});
    await models.Badge.create({name: "b"});
    const result = await graphql({schema, source: `mutation { models {
      Badge(update: [{where: {name: {eq: "b"}}}], apply: {label: {text: "hi"}}) { name note }
    } }`});
    validateResult(result);
    expect(resultData<{models: {Badge: Row[]}}>(result).models.Badge).toEqual([{name: "b", note: "label:hi"}]);
    expect(await notes(models)).toEqual([null, "label:hi"]);
  });

  it("drops `update` and `apply` when every transform is denied too", async() => {
    const {schema} = await build({...transformOnly, mutationInstanceMethods: () => false});
    const args = fieldArgs(schema, "Badge");
    expect(args).not.toContain("update");
    expect(args).not.toContain("apply");
  });

  it("offers no `apply` without a create or update to run it on", async() => {
    const {schema} = await build({mutationCreate: (d: string) => d !== "Badge", mutationUpdate: (d: string) => d !== "Badge"});
    expect(fieldArgs(schema, "Badge")).not.toContain("apply");
  });
});

describe("apply: CSV updates", () => {
  it("runs a transform on rows picked by key columns alone", async() => {
    const {schema, models} = await build(transformOnly);
    await models.Badge.create({name: "a"});
    await models.Badge.create({name: "b"});
    const result = await graphql({
      schema,
      source: `mutation($file: GQLTUpload) { models { Badge(updateCsv: $file, csv: {keys: ["name"]}, apply: {stamp: true}) { name note } } }`,
      variableValues: {file: "name\na\n"},
    });
    validateResult(result);
    expect(await notes(models)).toEqual(["stamped", null]);
  });

  it("still refuses a key-only update that runs no transform", async() => {
    const {schema} = await build();
    const result = await graphql({
      schema,
      source: `mutation($file: GQLTUpload) { models { Badge(updateCsv: $file, csv: {keys: ["name"]}) { name } } }`,
      variableValues: {file: "name\na\n"},
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("CSV_HEADER");
  });
});

describe("apply: csvImport files", () => {
  const run = (schema: GraphQLSchema, files: Row[]) => graphql({
    schema,
    source: `mutation($files: [CsvImportFile!]!) { csvImport(files: $files) { files { count } } }`,
    variableValues: {files},
  });

  it("runs a file's transforms on each of its rows", async() => {
    const {schema, models} = await build();
    const result = await run(schema, [{model: "Badge", operation: "create", file: "name\na\nb\n", apply: {label: {text: "x"}}}]);
    validateResult(result);
    expect(await notes(models)).toEqual(["label:x", "label:x"]);
  });

  it("holds a file's apply to the model field's own apply argument", async() => {
    const {schema, models} = await build({mutationInstanceMethods: (_d: string, m: string) => m !== "stamp"});
    for (const apply of [{stamp: true}, {nope: true}, {label: {text: 1, extra: true}}, ["stamp"]]) {
      const result = await run(schema, [{model: "Badge", operation: "create", file: "name\na\n", apply}]);
      expect([JSON.stringify(apply), result.errors?.[0]?.extensions?.code]).toEqual([JSON.stringify(apply), "CSV_UNSUPPORTED"]);
    }
    expect(await notes(models)).toEqual([]);
  });

  it("refuses apply on a model whose field offers no transforms", async() => {
    const {schema} = await build({mutationInstanceMethods: () => false});
    const result = await run(schema, [{model: "Badge", operation: "create", file: "name\na\n", apply: {stamp: true}}]);
    expect(result.errors?.[0]?.extensions?.code).toBe("CSV_UNSUPPORTED");
  });
});

describe("apply: the engine's own check", () => {
  it("refuses a denied transform from a direct call", async() => {
    const {db, models} = await build({mutationInstanceMethods: (_d: string, m: string) => m !== "stamp"});
    await models.Badge.create({name: "a"});
    await expect(db.processUpdate("Badge", null, {where: {name: {eq: "a"}}, apply: {stamp: true}}, {}))
      .rejects.toThrow(/not allowed/);
    await expect(db.processCreate("Badge", null, {input: {name: "b"}, apply: {stamp: true}}, {}))
      .rejects.toThrow(/not allowed/);
    expect(await notes(models)).toEqual([null]);
    await db.processUpdate("Badge", null, {where: {name: {eq: "a"}}, apply: {label: {text: "ok"}}}, {});
    expect(await notes(models)).toEqual(["label:ok"]);
  });
});
