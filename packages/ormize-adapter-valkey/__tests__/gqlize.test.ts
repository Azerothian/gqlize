import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { graphql } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

let client: any;

const ItemDef = {
  name: "Item",
  define: {
    id: { type: DataTypes.UUID, primaryKey: true },
    label: { type: DataTypes.String, index: true },
    note: { type: DataTypes.String },
  },
  options: {},
};

async function buildSchema() {
  const orm: any = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix: "gql" }, client), "valkey");
  await orm.addDefinition(ItemDef);
  await orm.initialise();
  await orm.sync();
  const schema = await createSchema(orm);
  return { orm, schema };
}

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await flush(client); });

describe("valkey adapter — gqlize GraphQL", () => {
  it("generates a schema and runs a connection query", async () => {
    const { orm, schema } = await buildSchema();
    await orm.processCreate("Item", null, { input: { label: "a", note: "n1" } }, {}, undefined);
    await orm.processCreate("Item", null, { input: { label: "b", note: "n2" } }, {}, undefined);
    const r: any = await graphql({ schema, source: `query { models { Item { total edges { node { id label } } } } }` });
    expect(r.errors).toBeUndefined();
    expect(r.data.models.Item.total).toBe(2);
    expect(r.data.models.Item.edges.map((e: any) => e.node.label).sort()).toEqual(["a", "b"]);
  });

  it("filters on an indexed field", async () => {
    const { orm, schema } = await buildSchema();
    await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("Item", null, { input: { label: "b" } }, {}, undefined);
    const r: any = await graphql({ schema, source: `query { models { Item(where: { label: { eq: "a" } }) { total edges { node { label } } } } }` });
    expect(r.errors).toBeUndefined();
    expect(r.data.models.Item.total).toBe(1);
    expect(r.data.models.Item.edges[0].node.label).toBe("a");
  });

  it("the generated where type exposes only indexed fields (not `note`)", async () => {
    const { schema } = await buildSchema();
    const whereType: any = schema.getType("GQLTQueryItemWhere");
    const keys = whereType && whereType.getFields ? Object.keys(whereType.getFields()) : [];
    expect(keys).toContain("label");
    expect(keys).not.toContain("note");
  });
});
