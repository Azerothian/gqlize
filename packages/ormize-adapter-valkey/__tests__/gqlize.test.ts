import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { graphql, GraphQLString, type GraphQLObjectType } from "graphql";
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

  it("relationships to permission-denied models are excluded from the include type", async () => {
    const orm: any = new Ormize();
    orm.registerAdapter(new ValkeyAdapter({ prefix: "gqlperm" }, client), "valkey");
    await orm.addDefinition({
      name: "Basket",
      define: { id: { type: DataTypes.UUID, primaryKey: true }, name: { type: DataTypes.String, index: true } },
      options: {},
      relationships: [
        { type: "hasMany", model: "Widget", name: "widgets", options: { foreignKey: "basketId" } },
        { type: "hasMany", model: "Secret", name: "secrets", options: { foreignKey: "basketId" } },
      ],
    });
    await orm.addDefinition({
      name: "Widget",
      define: { id: { type: DataTypes.UUID, primaryKey: true }, label: { type: DataTypes.String, index: true } },
      options: {},
    });
    await orm.addDefinition({
      name: "Secret",
      define: { id: { type: DataTypes.UUID, primaryKey: true }, value: { type: DataTypes.String, index: true } },
      options: {},
    });
    await orm.initialise();
    await orm.sync();
    const schema = await createSchema(orm, {
      permission: { model: (modelName: string) => modelName !== "Secret" },
    });
    // A denied datatype has no output type in the schema, so it must not remain
    // reachable as a join target on an include argument either.
    const includeType: any = schema.getType("GQLTBasketInclude");
    expect(includeType).toBeDefined();
    const keys = Object.keys(includeType.getFields());
    expect(keys).toContain("widgets");
    expect(keys).not.toContain("secrets");
  });

  it("a later build with a stricter permission re-gates the cached types", async () => {
    const { orm } = await buildSchema();
    const open = await createSchema(orm);
    expect(Object.keys((open.getType("GQLTQueryItemWhere") as any).getFields())).toContain("label");

    // Filter/order/include types are cached on the adapter by model name, so a
    // second build off the same instance must not reuse the first build's types.
    const locked = await createSchema(orm, {
      permission: { field: (_modelName: string, fieldName: string) => fieldName !== "label" },
    });
    expect(Object.keys((locked.getType("GQLTQueryItemWhere") as any).getFields())).not.toContain("label");
    expect((locked.getType("ItemOrderBy") as any).getValues().map((v: any) => v.name)).not.toContain("labelASC");
  });

  it("carries a define field's args/resolve/description into the schema", async () => {
    // gqlize#20 — `ValkeyModel` rebuilds its field map from `def.define`, and
    // used to drop all three, which made them inert on this adapter.
    const orm = new Ormize();
    orm.registerAdapter(new ValkeyAdapter({ prefix: "gqlargs" }, client), "valkey");
    await orm.addDefinition({
      name: "Doc",
      define: {
        id: { type: DataTypes.UUID, primaryKey: true },
        title: { type: DataTypes.String, description: "the title" },
        body: {
          type: DataTypes.String,
          args: { suffix: { type: GraphQLString } },
          resolve: (source: { body: string }, args: { suffix?: string }) =>
            `${source.body}${args.suffix || ""}`,
        },
      },
      options: {},
    });
    await orm.initialise();
    await orm.sync();
    const schema = await createSchema(orm);

    const fields = (schema.getType("Doc") as GraphQLObjectType).getFields();
    expect(fields.title.description).toEqual("the title");
    expect(fields.body.args.map((a) => a.name)).toEqual(["suffix"]);
    expect(fields.body.args[0].type).toBe(GraphQLString);
    // `title` authors neither, so it keeps graphql's default property resolver.
    expect(fields.title.args).toEqual([]);
    expect(fields.title.resolve).toBeUndefined();

    await orm.processCreate("Doc", null, { input: { title: "t", body: "abc" } }, {}, undefined);
    const r = await graphql({
      schema,
      source: `query { models { Doc { edges { node { title body(suffix: "!") } } } } }`,
    });
    expect(r.errors).toBeUndefined();
    const data = r.data as unknown as {
      models: { Doc: { edges: { node: { body: string } }[] } };
    };
    expect(data.models.Doc.edges[0].node.body).toBe("abc!");
  });
});
