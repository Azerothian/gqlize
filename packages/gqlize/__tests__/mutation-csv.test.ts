// CSV uploads on the model mutation field (`createCsv` / `updateCsv` /
// `deleteCsv`, issue #81): when the arguments exist, how cells become typed
// input, and that an upload is one all-or-nothing unit.
//
// The upload is passed as a plain string variable. The `GQLTUpload` scalar
// hands a resolver whatever the host's multipart layer produced, and ormize
// accepts text as well as streams — so this exercises everything below the
// multipart layer without one.
import {graphql, GraphQLObjectType} from "graphql";
import type {GraphQLSchema} from "graphql";
import Sequelize from "sequelize";
import {toGlobalId} from "graphql-relay";
import {Readable} from "node:stream";
import {describe, it, expect} from "@jest/globals";
import {Ormize} from "@azerothian/ormize";

import {registerDialectAdapter} from "./helper/dialect";
import {resultData, validateResult} from "./helper";
import {createSchema} from "../src";
import type {Definition, GqlizeOptions} from "../src/types/index";

const owner: Definition = {
  name: "CsvOwner",
  define: {
    name: {type: Sequelize.STRING, allowNull: false},
  },
};
const task: Definition = {
  name: "CsvTask",
  define: {
    name: {type: Sequelize.STRING, allowNull: false},
    rank: {type: Sequelize.INTEGER, allowNull: true},
    done: {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false},
    note: {type: Sequelize.TEXT, allowNull: true},
    // Opted in so a CSV can carry a foreign key, as a global id.
    ownerId: {type: Sequelize.INTEGER, allowNull: true, writable: true},
  },
  relationships: [
    {type: "belongsTo", model: "CsvOwner", name: "owner", options: {foreignKey: "ownerId"}},
  ],
};

type TaskRow = {id: string; name: string; rank: number | null; done: boolean; note: string | null; ownerId: string | null};

async function build(
  csv: GqlizeOptions["csv"] = true,
  taskOverrides: Partial<Definition> = {},
  schemaOptions?: GqlizeOptions,
) {
  const db = new Ormize({csv});
  await registerDialectAdapter(db);
  await db.addDefinition(owner);
  await db.addDefinition({...task, ...taskOverrides});
  await db.initialise();
  await db.sync();
  return {db, schema: await createSchema(db, schemaOptions)};
}

function mutationArgs(schema: GraphQLSchema): string[] {
  const models = schema.getMutationType()?.getFields().models.type as GraphQLObjectType;
  return models.getFields().CsvTask.args.map((a) => a.name);
}

const FIELDS = "id name rank done note ownerId";

function csvMutation(arg: "createCsv" | "updateCsv" | "deleteCsv") {
  return `mutation($file: GQLTUpload!, $csv: GQLTCsvOptions) {
    models { CsvTask(${arg}: $file, csv: $csv) { ${FIELDS} } }
  }`;
}

async function upload(schema: GraphQLSchema, arg: "createCsv" | "updateCsv" | "deleteCsv", file: unknown, csv?: {keys?: string[]; delimiter?: string}) {
  return graphql({schema, source: csvMutation(arg), variableValues: {file, csv}});
}

async function uploaded(schema: GraphQLSchema, arg: "createCsv" | "updateCsv" | "deleteCsv", file: unknown, csv?: {keys?: string[]; delimiter?: string}) {
  const result = await upload(schema, arg, file, csv);
  validateResult(result);
  return resultData<{models: {CsvTask: TaskRow[]}}>(result).models.CsvTask;
}

async function allTasks(schema: GraphQLSchema): Promise<TaskRow[]> {
  const result = await graphql({schema, source: `query { models { CsvTask { edges { node { ${FIELDS} } } } } }`});
  validateResult(result);
  return resultData<{models: {CsvTask: {edges: {node: TaskRow}[]}}}>(result).models.CsvTask.edges
    .map((e) => e.node)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function firstError(result: {errors?: readonly {message: string; extensions?: Record<string, unknown>}[]}) {
  expect(result.errors?.length).toBeGreaterThan(0);
  return result.errors![0];
}

describe("csv mutations: schema", () => {
  it("adds no arguments unless the instance turns CSV on", async() => {
    const {schema} = await build(false);
    expect(mutationArgs(schema)).not.toContain("createCsv");
    expect(schema.getType("GQLTCsvOptions")).toBeUndefined();
    expect(schema.getType("GQLTUpload")).toBeUndefined();
  });

  it("adds one upload argument per operation, and the shared options", async() => {
    const {schema} = await build();
    expect(mutationArgs(schema)).toEqual(expect.arrayContaining(["createCsv", "updateCsv", "deleteCsv", "csv"]));
    expect(String(schema.getType("GQLTCsvOptions"))).toBe("GQLTCsvOptions");
  });

  it("keeps a model out with `csv: false`", async() => {
    const {schema} = await build(true, {csv: false});
    expect(mutationArgs(schema)).not.toContain("createCsv");
    expect(mutationArgs(schema)).not.toContain("csv");
  });

  it("is gated by `permission.mutationCsv`", async() => {
    const {schema} = await build(true, {}, {permission: {mutationCsv: (defName) => defName !== "CsvTask"}});
    expect(mutationArgs(schema)).toContain("create");
    expect(mutationArgs(schema)).not.toContain("createCsv");
  });

  it("follows the operation's own gate", async() => {
    const {schema} = await build(true, {}, {permission: {mutationCreate: () => false}});
    expect(mutationArgs(schema)).not.toContain("createCsv");
    expect(mutationArgs(schema)).toEqual(expect.arrayContaining(["updateCsv", "deleteCsv", "csv"]));
  });
});

describe("csv mutations: createCsv", () => {
  it("creates one row per line, typed by the input fields", async() => {
    const {schema} = await build();
    const rows = await uploaded(schema, "createCsv", [
      "name,rank,done,note",
      "alpha,1,true,plain",
      "beta,2,no,\"quoted, with a comma\nand a newline\"",
      "gamma,,FALSE,\\N",
    ].join("\r\n"));
    expect(rows.map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(await allTasks(schema)).toEqual([
      expect.objectContaining({name: "alpha", rank: 1, done: true, note: "plain"}),
      expect.objectContaining({name: "beta", rank: 2, done: false, note: "quoted, with a comma\nand a newline"}),
      expect.objectContaining({name: "gamma", rank: null, done: false, note: null}),
    ]);
  });

  it("decodes a foreign key given as a global id", async() => {
    const {db, schema} = await build();
    const [o] = await db.processCreate("CsvOwner", null, {input: {name: "o"}}, {});
    const ownerId = toGlobalId("CsvOwner", `${(o as {id: number}).id}`);
    const [row] = await uploaded(schema, "createCsv", `name,ownerId\nowned,${ownerId}\n`);
    expect(row.ownerId).toBe(ownerId);
  });

  it("reads another delimiter and a leading BOM", async() => {
    const {schema} = await build();
    await uploaded(schema, "createCsv", "﻿name;rank\nsemi;7\n", {delimiter: ";"});
    expect(await allTasks(schema)).toEqual([expect.objectContaining({name: "semi", rank: 7})]);
  });

  it("accepts the shapes multipart layers hand over", async() => {
    const {schema} = await build();
    // graphql-upload's `Upload`: a `promise` of a `FileUpload`.
    await uploaded(schema, "createCsv", {
      promise: Promise.resolve({filename: "a.csv", createReadStream: () => Readable.from(["name\n", "streamed\n"])}),
    });
    // A web `File`/`Blob`.
    await uploaded(schema, "createCsv", new Blob(["name\nblob\n"]));
    expect((await allTasks(schema)).map((r) => r.name)).toEqual(["blob", "streamed"]);
  });

  it("refuses a column the input type does not have", async() => {
    const {schema} = await build();
    const error = firstError(await upload(schema, "createCsv", "name,colour\nx,red\n"));
    expect(error.extensions).toMatchObject({code: "CSV_HEADER", column: "colour"});
  });

  it("refuses the primary key: the mass-assignment guard holds for CSV too", async() => {
    const {schema} = await build();
    const error = firstError(await upload(schema, "createCsv", `id,name\n${toGlobalId("CsvTask", "99")},forged\n`));
    expect(error.extensions).toMatchObject({code: "CSV_HEADER", column: "id"});
    expect(await allTasks(schema)).toEqual([]);
  });

  it("refuses a column denied by `mutationCreateInput`", async() => {
    const {schema} = await build(true, {}, {
      permission: {mutationCreateInput: (defName, field) => !(defName === "CsvTask" && field === "note")},
    });
    const error = firstError(await upload(schema, "createCsv", "name,note\nx,secret\n"));
    expect(error.extensions).toMatchObject({code: "CSV_HEADER", column: "note"});
  });
});

describe("csv mutations: updateCsv and deleteCsv", () => {
  async function seeded() {
    const built = await build();
    const rows = await uploaded(built.schema, "createCsv", "name,rank\none,1\ntwo,2\nthree,3\n");
    return {...built, ids: Object.fromEntries(rows.map((r) => [r.name, r.id]))};
  }

  it("updates rows matched on the primary key, leaving empty cells alone", async() => {
    const {schema, ids} = await seeded();
    const rows = await uploaded(schema, "updateCsv", `id,rank,note\n${ids.one},10,\n${ids.two},,second\n`);
    expect(rows.map((r) => r.name)).toEqual(["one", "two"]);
    expect(await allTasks(schema)).toEqual([
      expect.objectContaining({name: "one", rank: 10, note: null}),
      expect.objectContaining({name: "three", rank: 3}),
      expect.objectContaining({name: "two", rank: 2, note: "second"}),
    ]);
  });

  it("matches on other key columns", async() => {
    const {schema} = await seeded();
    await uploaded(schema, "updateCsv", "name,done\nthree,true\n", {keys: ["name"]});
    expect((await allTasks(schema)).filter((r) => r.done).map((r) => r.name)).toEqual(["three"]);
  });

  it("deletes rows by key, and takes nothing but keys", async() => {
    const {schema, ids} = await seeded();
    const deleted = await uploaded(schema, "deleteCsv", `id\n${ids.one}\n${ids.three}\n`);
    expect(deleted).toHaveLength(2);
    expect((await allTasks(schema)).map((r) => r.name)).toEqual(["two"]);

    const error = firstError(await upload(schema, "deleteCsv", `id,name\n${ids.two},two\n`));
    expect(error.extensions).toMatchObject({code: "CSV_HEADER", column: "name"});
  });

  it("refuses an update with no key column, or a blank key cell", async() => {
    const {schema, ids} = await seeded();
    expect(firstError(await upload(schema, "updateCsv", "rank\n5\n")).extensions)
      .toMatchObject({code: "CSV_HEADER", column: "id"});
    expect(firstError(await upload(schema, "updateCsv", `id,rank\n${ids.one},5\n,6\n`)).extensions)
      .toMatchObject({code: "CSV_ROW_INVALID", row: 2, column: "id"});
    expect((await allTasks(schema)).map((r) => r.rank)).toEqual([1, 3, 2]);
  });

  it("reports a key that names another model's id with its cause", async() => {
    const {schema} = await seeded();
    const error = firstError(await upload(schema, "updateCsv", `id,rank\n${toGlobalId("CsvOwner", "1")},5\n`));
    expect(error.extensions).toMatchObject({code: "CSV_ROW_FAILED", row: 1, causeCode: "GLOBAL_ID_TYPE_MISMATCH"});
  });
});

describe("csv mutations: all-or-nothing", () => {
  it("writes nothing when a later cell does not convert", async() => {
    const {schema} = await build();
    const error = firstError(await upload(schema, "createCsv", "name,rank\nok,1\nbad,one\n"));
    expect(error.extensions).toMatchObject({code: "CSV_ROW_INVALID", row: 2, column: "rank"});
    expect(await allTasks(schema)).toEqual([]);
  });

  it("writes nothing when a row misses a required field", async() => {
    const {schema} = await build();
    const error = firstError(await upload(schema, "createCsv", "name,rank\nok,1\n,2\n"));
    expect(error.extensions).toMatchObject({code: "CSV_ROW_INVALID", row: 2});
    expect(await allTasks(schema)).toEqual([]);
  });

  it("rolls earlier rows back when a later write matches nothing", async() => {
    const {schema} = await build();
    const [row] = await uploaded(schema, "createCsv", "name,rank\nkept,1\n");
    const error = firstError(await upload(schema, "updateCsv", `id,rank\n${row.id},50\n${toGlobalId("CsvTask", "424242")},60\n`));
    expect(error.extensions).toMatchObject({code: "CSV_ROW_NO_MATCH", row: 2});
    expect(await allTasks(schema)).toEqual([expect.objectContaining({name: "kept", rank: 1})]);
  });

  it("refuses an upload over the row or byte limit before writing", async() => {
    const {schema} = await build({maxRows: 2, maxBytes: 64});
    expect(firstError(await upload(schema, "createCsv", "name\na\nb\nc\n")).extensions)
      .toMatchObject({code: "CSV_TOO_MANY_ROWS"});
    expect(firstError(await upload(schema, "createCsv", `name\n${"x".repeat(80)}\n`)).extensions)
      .toMatchObject({code: "CSV_TOO_LARGE"});
    expect(await allTasks(schema)).toEqual([]);
  });

  it("reports malformed CSV", async() => {
    const {schema} = await build();
    expect(firstError(await upload(schema, "createCsv", "name,rank\n\"unclosed,1\n")).extensions)
      .toMatchObject({code: "CSV_PARSE"});
    expect(firstError(await upload(schema, "createCsv", "name,rank\na,1,extra\n")).extensions)
      .toMatchObject({code: "CSV_PARSE"});
  });
});
