import {graphql} from "graphql";
import Sequelize from "sequelize";
import { Ormize as Database } from "@azerothian/ormize";
import {createSchema} from "../src";
import {validateResult} from "./helper";
import {createAdapterForDialect, registerTeardown} from "./helper/dialect";
import {describe, it, expect} from "@jest/globals";

async function build() {
  const db = new Database();
  const {adapter, name, teardown} = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
  db.addDefinition({
    name: "Widget",
    define: {
      name: {type: Sequelize.STRING, allowNull: false},
      qty: {type: Sequelize.INTEGER, allowNull: true},
      data: {type: Sequelize.JSONB, allowNull: true},
    },
    relationships: [{type: "hasMany", model: "Part", name: "parts", options: {foreignKey: "widgetId"}}],
  });
  db.addDefinition({
    name: "Part",
    define: {name: {type: Sequelize.STRING, allowNull: false}},
    relationships: [{type: "belongsTo", model: "Widget", name: "widget", options: {foreignKey: "widgetId"}}],
  });
  await db.initialise();
  await db.sync();
  return db;
}

describe("variables inside a where object", () => {
  it("string field: variable in top-level where", async () => {
    const db = await build();
    const {Widget} = db.models;
    await Widget.create({name: "alpha"});
    await Widget.create({name: "beta"});
    const schema = await createSchema(db);
    const result = (await graphql({
      schema,
      source: `query ($n: String) { models { Widget(where: { name: { eq: $n } }) { edges { node { name } } } } }`,
      variableValues: {n: "alpha"},
    })) as any;
    validateResult(result);
    expect(result.data.models.Widget.edges.map((e: any) => e.node.name)).toEqual(["alpha"]);
  });

  it("int field: variable in top-level where", async () => {
    const db = await build();
    const {Widget} = db.models;
    await Widget.create({name: "a", qty: 1});
    await Widget.create({name: "b", qty: 2});
    const schema = await createSchema(db);
    const result = (await graphql({
      schema,
      source: `query ($q: Int) { models { Widget(where: { qty: { eq: $q } }) { edges { node { name qty } } } } }`,
      variableValues: {q: 2},
    })) as any;
    validateResult(result);
    expect(result.data.models.Widget.edges.map((e: any) => e.node.name)).toEqual(["b"]);
  });

  it("nested relationship where: variable", async () => {
    const db = await build();
    const {Widget, Part} = db.models;
    const w = await Widget.create({name: "w1"});
    await Part.create({name: "keep", widgetId: w.get("id")});
    await Part.create({name: "drop", widgetId: w.get("id")});
    const schema = await createSchema(db);
    const result = (await graphql({
      schema,
      source: `query ($p: String) { models { Widget { edges { node { name parts(where: { name: { eq: $p } }) { edges { node { name } } } } } } } }`,
      variableValues: {p: "keep"},
    })) as any;
    validateResult(result);
    const parts = result.data.models.Widget.edges[0].node.parts.edges;
    expect(parts.map((e: any) => e.node.name)).toEqual(["keep"]);
  });

  it("mutation update: variable in where", async () => {
    const db = await build();
    const {Widget} = db.models;
    await Widget.create({name: "x"});
    await Widget.create({name: "y"});
    const schema = await createSchema(db);
    const result = (await graphql({
      schema,
      source: `mutation ($n: String) { models { Widget(update: { where: { name: { eq: $n } }, input: { name: "updated" } }) { id name } } }`,
      variableValues: {n: "x"},
    })) as any;
    validateResult(result);
    expect(result.data.models.Widget.map((w: any) => w.name)).toEqual(["updated"]);
    expect(await Widget.count({where: {name: "updated"}})).toEqual(1);
  });

  it("string field: variable as the field-filter object inside an inline where", async () => {
    const db = await build();
    const {Widget} = db.models;
    await Widget.create({name: "alpha"});
    await Widget.create({name: "beta"});
    const schema = await createSchema(db);
    // the `name` field's filter object is supplied as a variable
    const result = (await graphql({
      schema,
      source: `query ($nf: GQLTQueryWidgetWherename) { models { Widget(where: { name: $nf }) { edges { node { name } } } } }`,
      variableValues: {nf: {eq: "alpha"}},
    })) as any;
    validateResult(result);
    expect(result.data.models.Widget.edges.map((e: any) => e.node.name)).toEqual(["alpha"]);
  });

  it("string field: the whole where supplied as a variable", async () => {
    const db = await build();
    const {Widget} = db.models;
    await Widget.create({name: "alpha"});
    await Widget.create({name: "beta"});
    const schema = await createSchema(db);
    const result = (await graphql({
      schema,
      source: `query ($w: GQLTQueryWidgetWhere) { models { Widget(where: $w) { edges { node { name } } } } }`,
      variableValues: {w: {name: {eq: "beta"}}},
    })) as any;
    validateResult(result);
    expect(result.data.models.Widget.edges.map((e: any) => e.node.name)).toEqual(["beta"]);
  });

  it("JSON field: variable nested inside a where literal", async () => {
    const db = await build();
    const {Widget} = db.models;
    await Widget.create({name: "j1", data: {kind: "a"}});
    await Widget.create({name: "j2", data: {kind: "b"}});
    const schema = await createSchema(db);
    const result = (await graphql({
      schema,
      source: `query ($k: String) { models { Widget(where: { data: { eq: { kind: $k } } }) { edges { node { name data } } } } }`,
      variableValues: {k: "a"},
    })) as any;
    validateResult(result);
    expect(result.data.models.Widget.edges.map((e: any) => e.node.name)).toEqual(["j1"]);
  });
});
