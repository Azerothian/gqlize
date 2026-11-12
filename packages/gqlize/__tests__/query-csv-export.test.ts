// CSV export, the read side of CSV uploads: the `csv` field on a model's root
// list connection. When it is offered, what a file holds (columns, ids, NULLs,
// quoting), that it follows the list's own filter/order/paging, and that a file
// it writes reads back through `updateCsv`.
import {graphql, GraphQLObjectType} from "graphql";
import type {GraphQLSchema} from "graphql";
import Sequelize from "sequelize";
import {describe, it, expect} from "@jest/globals";
import {Ormize} from "@azerothian/ormize";

import {registerDialectAdapter} from "./helper/dialect";
import {resultData, validateResult} from "./helper";
import {createSchema} from "../src";
import type {Definition, GqlizeOptions, Permission} from "../src/types/index";

const owner: Definition = {
  name: "CsvOwner",
  define: {name: {type: Sequelize.STRING, allowNull: false}},
};
const task: Definition = {
  name: "CsvTask",
  define: {
    name: {type: Sequelize.STRING, allowNull: false},
    rank: {type: Sequelize.INTEGER, allowNull: true},
    done: {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false},
    note: {type: Sequelize.TEXT, allowNull: true},
    secret: {type: Sequelize.STRING, allowNull: true},
    ownerId: {type: Sequelize.INTEGER, allowNull: true, writable: true},
  },
  relationships: [
    {type: "belongsTo", model: "CsvOwner", name: "owner", options: {foreignKey: "ownerId"}},
  ],
};

async function build(csv: GqlizeOptions["csv"] = true, permission?: Permission, taskOverrides: Partial<Definition> = {}) {
  const db = new Ormize({csv});
  await registerDialectAdapter(db);
  await db.addDefinition(owner);
  await db.addDefinition({...task, ...taskOverrides});
  await db.initialise();
  await db.sync();
  const schema = await createSchema(db, permission ? {permission} : undefined);
  const models = db.models;
  return {db, schema, models};
}

function listFields(schema: GraphQLSchema): string[] {
  const models = schema.getQueryType()?.getFields().models.type as GraphQLObjectType;
  const list = models.getFields().CsvTask.type as GraphQLObjectType;
  return Object.keys(list.getFields());
}

async function exported(schema: GraphQLSchema, listArgs = "", csvArgs = "", extra = ""): Promise<string> {
  const args = listArgs ? `(${listArgs})` : "";
  const csvA = csvArgs ? `(${csvArgs})` : "";
  const result = await graphql({schema, source: `query { models { CsvTask${args} { csv${csvA} ${extra} } } }`});
  validateResult(result);
  return resultData<{models: {CsvTask: {csv: string}}}>(result).models.CsvTask.csv;
}

/** RFC 4180, enough for these files: quoted fields with doubled quotes and embedded line breaks. */
function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") {
        cell += "\"";
        i++;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === "\"") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else {
      cell += ch;
    }
  }
  return rows;
}

function rowsOf(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

async function seed(models: Awaited<ReturnType<typeof build>>["models"]) {
  const ann = await models.CsvOwner.create({name: "ann"});
  await models.CsvTask.create({name: "alpha", rank: 1, done: true, note: "has, a comma and \"quotes\"\nand a newline", ownerId: ann.get("id")});
  await models.CsvTask.create({name: "beta", rank: null, done: false, note: null});
  await models.CsvTask.create({name: "gamma", rank: 3, done: false, note: "plain"});
  return {annId: ann.get("id")};
}

describe("csv export", () => {
  it("is offered on the root list only when CSV is on and queryCsv allows it", async() => {
    expect(listFields((await build(false)).schema)).not.toContain("csv");
    expect(listFields((await build()).schema)).toContain("csv");
    expect(listFields((await build(true, {queryCsv: (m) => m !== "CsvTask"})).schema)).not.toContain("csv");
    expect(listFields((await build(true, undefined, {csv: false})).schema)).not.toContain("csv");
  });

  it("writes every readable column, ids as global ids and NULL as \\N", async() => {
    const {schema, models} = await build();
    await seed(models);
    const text = await exported(schema, "orderBy: [nameASC]");
    expect(text.split("\r\n")[0]).toBe("id,name,rank,done,note,secret,ownerId,createdAt,updatedAt");
    const rows = rowsOf(text);
    expect(rows.map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(rows[0]).toMatchObject({rank: "1", done: "true", note: "has, a comma and \"quotes\"\nand a newline", secret: "\\N"});
    expect(rows[1]).toMatchObject({rank: "\\N", note: "\\N", ownerId: "\\N"});
    // The same ids a JSON read returns.
    const json = await graphql({schema, source: "query { models { CsvTask(orderBy: [nameASC]) { edges { node { id ownerId } } } } }"});
    validateResult(json);
    const nodes = resultData<{models: {CsvTask: {edges: {node: {id: string; ownerId: string}}[]}}}>(json).models.CsvTask.edges.map((e) => e.node);
    expect(rows[0].id).toBe(nodes[0].id);
    expect(rows[0].ownerId).toBe(nodes[0].ownerId);
  });

  it("follows the list's filter, order and paging", async() => {
    const {schema, models} = await build();
    await seed(models);
    const text = await exported(schema, "where: {done: {eq: false}}, orderBy: [nameDESC], first: 1");
    expect(rowsOf(text).map((r) => r.name)).toEqual(["gamma"]);
  });

  it("takes columns, a delimiter and no header", async() => {
    const {schema, models} = await build();
    await seed(models);
    const text = await exported(schema, "orderBy: [nameASC]", "columns: [\"rank\", \"name\"], delimiter: \";\", header: false");
    expect(text).toBe("1;alpha\r\n\\N;beta\r\n3;gamma\r\n");
  });

  it("refuses a column the caller cannot read, and a bad delimiter", async() => {
    const {schema} = await build(true, {field: (m, f) => !(m === "CsvTask" && f === "secret")});
    const hidden = await graphql({schema, source: "query { models { CsvTask { csv(columns: [\"secret\"]) } } }"});
    expect(hidden.errors?.[0].message).toMatch(/"secret" is not a column/);
    const text = await exported(schema);
    expect(text.split("\r\n")[0]).not.toContain("secret");
    const delim = await graphql({schema, source: "query { models { CsvTask { csv(delimiter: \"\\\"\") } } }"});
    expect(delim.errors?.[0].extensions?.code).toBe("CSV_UNSUPPORTED");
  });

  it("writes every column even when edges select only some", async() => {
    const {schema, models} = await build();
    await seed(models);
    const text = await exported(schema, "orderBy: [nameASC]", "", "edges { node { id } }");
    expect(rowsOf(text)[2]).toMatchObject({name: "gamma", rank: "3", note: "plain"});
  });

  it("writes a file that reads back through updateCsv", async() => {
    const {schema, models} = await build();
    await seed(models);
    const text = await exported(schema, "orderBy: [nameASC]", "columns: [\"id\", \"name\", \"rank\", \"note\"]");
    // The first column holds global ids, the key an update matches on by default.
    const edited = text.replace(",beta,\\N,", ",beta,7,").replace(",gamma,3,plain", ",gamma,3,edited");
    expect(edited).not.toBe(text);
    const result = await graphql({
      schema,
      source: "mutation($file: GQLTUpload!) { models { CsvTask(updateCsv: $file) { name } } }",
      variableValues: {file: edited},
    });
    validateResult(result);
    const after = rowsOf(await exported(schema, "orderBy: [nameASC]", "columns: [\"name\", \"rank\", \"note\"]"));
    expect(after).toEqual([
      {name: "alpha", rank: "1", note: "has, a comma and \"quotes\"\nand a newline"},
      {name: "beta", rank: "7", note: "\\N"},
      {name: "gamma", rank: "3", note: "edited"},
    ]);
  });
});
