import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { graphql, GraphQLEnumType, GraphQLInputObjectType, GraphQLString, type GraphQLObjectType } from "graphql";
import { createSchema } from "@azerothian/gqlize";
import { Ormize } from "@azerothian/ormize";
import type { Definition } from "@azerothian/utilize/types/index";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

/**
 * `graphql()` types every field value as `unknown`; the assertions here walk the
 * result tree by name, so results are read through one deliberately loose alias.
 */
type QueryResult = { data?: any; errors?: readonly { message: string }[] };

/** One connection edge, as these assertions read it. */
type Edge = { node: Record<string, any> };

let client: Awaited<ReturnType<typeof makeClient>>;

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
  const orm = new Ormize();
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
    const r = await graphql({ schema, source: `query { models { Item { total edges { node { id label } } } } }` }) as QueryResult;
    expect(r.errors).toBeUndefined();
    expect(r.data.models.Item.total).toBe(2);
    expect(r.data.models.Item.edges.map((e: Edge) => e.node.label).sort()).toEqual(["a", "b"]);
  });

  it("filters on an indexed field", async () => {
    const { orm, schema } = await buildSchema();
    await orm.processCreate("Item", null, { input: { label: "a" } }, {}, undefined);
    await orm.processCreate("Item", null, { input: { label: "b" } }, {}, undefined);
    const r = await graphql({ schema, source: `query { models { Item(where: { label: { eq: "a" } }) { total edges { node { label } } } } }` }) as QueryResult;
    expect(r.errors).toBeUndefined();
    expect(r.data.models.Item.total).toBe(1);
    expect(r.data.models.Item.edges[0].node.label).toBe("a");
  });

  it("the generated where type exposes only indexed fields (not `note`)", async () => {
    const { schema } = await buildSchema();
    const whereType = schema.getType("GQLTQueryItemWhere") as GraphQLInputObjectType;
    const keys = whereType && whereType.getFields ? Object.keys(whereType.getFields()) : [];
    expect(keys).toContain("label");
    expect(keys).not.toContain("note");
  });

  it("relationships to permission-denied models are excluded from the include type", async () => {
    const orm = new Ormize();
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
    const includeType = schema.getType("GQLTBasketInclude") as GraphQLInputObjectType;
    expect(includeType).toBeDefined();
    const keys = Object.keys(includeType.getFields());
    expect(keys).toContain("widgets");
    expect(keys).not.toContain("secrets");
  });

  it("a later build with a stricter permission re-gates the cached types", async () => {
    const { orm } = await buildSchema();
    const open = await createSchema(orm);
    expect(Object.keys((open.getType("GQLTQueryItemWhere") as GraphQLInputObjectType).getFields())).toContain("label");

    // Filter/order/include types are cached on the adapter by model name, so a
    // second build off the same instance must not reuse the first build's types.
    const locked = await createSchema(orm, {
      permission: { field: (_modelName: string, fieldName: string) => fieldName !== "label" },
    });
    expect(Object.keys((locked.getType("GQLTQueryItemWhere") as GraphQLInputObjectType).getFields())).not.toContain("label");
    expect((locked.getType("ItemOrderBy") as GraphQLEnumType).getValues().map((v) => v.name)).not.toContain("labelASC");
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

describe("valkey adapter — exposed instance methods", () => {
  // The declarative half of `expose.instanceMethods` is adapter-agnostic by
  // construction (shared readers in utilize, order expansion in the ormize
  // manager), so it has to hold up on a backend that is not SQL.
  const MethodDef: Definition = {
    name: "Person",
    define: {
      id: { type: DataTypes.UUID, primaryKey: true },
      firstName: { type: DataTypes.String, index: true },
      lastName: { type: DataTypes.String, index: true },
      secret: { type: DataTypes.String },
    },
    expose: {
      instanceMethods: {
        query: {
          // No implementation: `output` produces the value from the row.
          fullName: {
            type: GraphQLString,
            fields: ["firstName", "lastName"],
            output: (_v, { source }) => `${source.firstName} ${source.lastName}`,
            orderBy: ["lastName"],
            where: "lastName",
          },
        },
        mutations: {
          redact: {},
          rename: { args: {} },
        },
      },
    },
    options: {
      instanceMethods: {
        redact() {
          this.secret = null;
        },
        rename() {
          return { firstName: `${this.firstName}x` };
        },
      },
    },
  };

  async function buildMethodSchema() {
    const orm = new Ormize();
    orm.registerAdapter(new ValkeyAdapter({ prefix: "gqlim" }, client), "valkey");
    await orm.addDefinition(MethodDef);
    await orm.initialise();
    await orm.sync();
    return { orm, schema: await createSchema(orm) };
  }

  it("resolves a field with no implementation and sorts by its declared columns", async () => {
    const { orm, schema } = await buildMethodSchema();
    await orm.processCreate("Person", null, { input: { firstName: "John", lastName: "Smith" } }, {}, undefined);
    await orm.processCreate("Person", null, { input: { firstName: "Ada", lastName: "Lovelace" } }, {}, undefined);
    const r = await graphql({ schema, source: `query { models { Person(orderBy: fullNameASC) { edges { node { fullName } } } } }` }) as QueryResult;
    expect(r.errors).toBeUndefined();
    expect(r.data.models.Person.edges.map((e: Edge) => e.node.fullName)).toEqual(["Ada Lovelace", "John Smith"]);
  });

  it("filters by a computed field, pushed into the index lookup", async () => {
    const { orm, schema } = await buildMethodSchema();
    await orm.processCreate("Person", null, { input: { firstName: "John", lastName: "Smith" } }, {}, undefined);
    await orm.processCreate("Person", null, { input: { firstName: "Ada", lastName: "Lovelace" } }, {}, undefined);
    const r = await graphql({ schema, source: `query { models { Person(where: { fullName: { eq: "Smith" } }) { total edges { node { fullName } } } } }` }) as QueryResult;
    expect(r.errors).toBeUndefined();
    // `where: "lastName"` rewrites onto an indexed field, so this is an index
    // lookup rather than the keyspace scan the adapter refuses to run.
    expect(r.data.models.Person.edges.map((e: Edge) => e.node.fullName)).toEqual(["John Smith"]);
    expect(r.data.models.Person.total).toBe(1);
  });

  it("contributes to the orderBy enum and the where input", async () => {
    const { schema } = await buildMethodSchema();
    expect((schema.getType("PersonOrderBy") as GraphQLEnumType).getValues().map((v) => v.name))
      .toEqual(expect.arrayContaining(["fullNameASC", "fullNameDESC"]));
    expect(Object.keys((schema.getType("GQLTQueryPersonWhere") as GraphQLInputObjectType).getFields())).toContain("fullName");
  });

  it("runs pre-commit transforms on create and update", async () => {
    const { schema } = await buildMethodSchema();
    const created = await graphql({ schema, source: `mutation {
      models { Person(create: [{ firstName: "Grace", lastName: "Hopper", secret: "s" }], apply: { redact: true }) { firstName secret } }
    }` }) as QueryResult;
    expect(created.errors).toBeUndefined();
    expect(created.data.models.Person[0].secret).toBeNull();

    const updated = await graphql({ schema, source: `mutation {
      models { Person(update: [{ where: { lastName: { eq: "Hopper" } }, input: {} }], apply: { rename: true }) { firstName } }
    }` }) as QueryResult;
    expect(updated.errors).toBeUndefined();
    expect(updated.data.models.Person[0].firstName).toBe("Gracex");

    const reread = await graphql({ schema, source: `query { models { Person { edges { node { firstName } } } } }` }) as QueryResult;
    expect(reread.data.models.Person.edges[0].node.firstName).toBe("Gracex");
  });
});
