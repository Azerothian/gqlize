// `required` where no JOIN can apply it: every relationship on Valkey (which
// has no joins), and a relationship between two adapters. The engine turns it
// into a key filter on the parent, under the target's read scope, so it means
// the same as on SQL: only parents with a visible matching related row.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { graphql, type GraphQLSchema } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { dialectConfig, trackConnection, testDialect } from "@azerothian/test-fixtures/dialect";
import type IORedis from "ioredis";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

const sqlName = testDialect();
let client: IORedis;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- result trees are read dynamically by field name
type Data = any;

// Owner/Pet on Valkey; Item on Valkey and File on SQL, related across them.
async function build(prefix: string, scope?: (model: string) => object | undefined) {
  // A read scope only, so the seed rows are written whatever it says.
  const orm = new Ormize(scope ? { permission: { scope: (model: string, operation: string) => (operation === "read" ? scope(model) : undefined) } } : {});
  orm.registerAdapter(new ValkeyAdapter({ prefix }, client), "valkey");
  const sqlAdapter = new SequelizeAdapter({}, await dialectConfig());
  trackConnection(sqlAdapter);
  orm.registerAdapter(sqlAdapter, sqlName);
  await orm.addDefinition({
    name: "Owner",
    define: { id: { type: DataTypes.UUID, primaryKey: true }, name: { type: DataTypes.String, index: true } },
    options: {},
    relationships: [{ type: "hasMany", model: "Pet", name: "pets", options: { foreignKey: "ownerId" } }],
  }, "valkey");
  await orm.addDefinition({
    name: "Pet",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      name: { type: DataTypes.String, index: true },
      ownerId: { type: DataTypes.UUID, index: true, writable: true },
    },
    options: {},
    relationships: [{ type: "belongsTo", model: "Owner", name: "owner", options: { foreignKey: "ownerId" } }],
  }, "valkey");
  await orm.addDefinition({
    name: "Item",
    define: { id: { type: DataTypes.UUID, primaryKey: true }, label: { type: DataTypes.String, index: true } },
    options: {},
    relationships: [{ type: "hasMany", model: "File", name: "files", options: { foreignKey: "itemId" } }],
  }, "valkey");
  await orm.addDefinition({
    name: "File",
    define: {
      name: { type: Sequelize.STRING, allowNull: false },
      itemId: { type: Sequelize.STRING, allowNull: true },
    },
    options: { timestamps: false },
    relationships: [{ type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } }],
  }, sqlName);
  await orm.initialise();
  await orm.sync();
  const schema = await createSchema(orm);
  const create = async (model: string, input: Record<string, unknown>) =>
    (await orm.processCreate(model, null, { input }, {}, undefined))[0] as Record<string, unknown>;
  const ann = await create("Owner", { name: "ann" });
  await create("Owner", { name: "bob" });
  await create("Pet", { name: "rex", ownerId: ann.id });
  await create("Pet", { name: "stray" });
  const box = await create("Item", { label: "box" });
  await create("Item", { label: "bag" });
  await create("File", { name: "f1", itemId: box.id });
  await create("File", { name: "loose" });
  return { orm, schema };
}

async function q(schema: GraphQLSchema, source: string): Promise<Data> {
  const r = await graphql({ schema, source });
  expect(r.errors).toBeUndefined();
  return r.data;
}

const names = (data: Data, model: string, field: string): string[] =>
  (data.models[model].edges as { node: Record<string, string> }[]).map((e) => e.node[field]).sort();

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await flush(client); });

describe("required on Valkey", () => {
  it("keeps only parents with a related row (hasMany)", async () => {
    const { schema } = await build("req-hm");
    const data = await q(schema, "{ models { Owner { edges { node { name pets(required: true) { edges { node { name } } } } } } } }");
    expect(names(data, "Owner", "name")).toEqual(["ann"]);
  });

  it("applies the relation's where", async () => {
    const { schema } = await build("req-where");
    const none = await q(schema, "{ models { Owner { edges { node { name pets(required: true, where: {name: {eq: \"nope\"}}) { total } } } } } }");
    expect(names(none, "Owner", "name")).toEqual([]);
    const some = await q(schema, "{ models { Owner { edges { node { name pets(required: true, where: {name: {eq: \"rex\"}}) { total } } } } } }");
    expect(names(some, "Owner", "name")).toEqual(["ann"]);
  });

  it("keeps only children with a parent (belongsTo)", async () => {
    const { schema } = await build("req-bt");
    const data = await q(schema, "{ models { Pet { edges { node { name owner(required: true) { name } } } } } }");
    expect(names(data, "Pet", "name")).toEqual(["rex"]);
  });

  it("counts a related row the target's read scope hides as absent", async () => {
    const { schema } = await build("req-scope", (model) => (model === "Pet" ? { where: { name: { eq: "stray" } } } : undefined));
    const data = await q(schema, "{ models { Owner { edges { node { name pets(required: true) { total } } } } } }");
    expect(names(data, "Owner", "name")).toEqual([]);
  });
});

describe("required across adapters", () => {
  it("keeps only Valkey parents with a SQL child (hasMany)", async () => {
    const { schema } = await build("req-xhm");
    const data = await q(schema, "{ models { Item { edges { node { label files(required: true) { edges { node { name } } } } } } } }");
    expect(names(data, "Item", "label")).toEqual(["box"]);
  });

  it("keeps only SQL children with a Valkey parent (belongsTo)", async () => {
    const { schema } = await build("req-xbt");
    const data = await q(schema, "{ models { File { edges { node { name item(required: true) { label } } } } } }");
    expect(names(data, "File", "name")).toEqual(["f1"]);
  });

  it("applies the relation's where across adapters", async () => {
    const { schema } = await build("req-xwhere");
    const data = await q(schema, "{ models { File { edges { node { name item(required: true) { label } } } } } }");
    expect(names(data, "File", "name")).toEqual(["f1"]);
    const none = await q(schema, "{ models { Item { edges { node { label files(required: true, where: {name: {eq: \"zzz\"}}) { total } } } } } }");
    expect(names(none, "Item", "label")).toEqual([]);
  });
});
