import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { graphql } from "graphql";
import type { GqlizeOptions } from "@azerothian/gqlize";
import { createSchema, prefixIdCodec, plainCursorCodec } from "@azerothian/gqlize";
import { Ormize } from "@azerothian/ormize";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import { toGlobalId } from "graphql-relay";
import ValkeyAdapter from "../src";
import { makeClient, flush, shutdown } from "./helper/redis";

type QueryResult = { data?: unknown; errors?: readonly { message: string }[] };

/** the result of a query, read as the shape it selected */
function data<T>(result: QueryResult): T {
  return result.data as T;
}

/** a row as these tests need it — `AdapterRow` is `unknown` by contract */
type Row = { id: string };

/** the shapes these queries select */
type ThingPage = {models: {Thing: {total: number; edges: {node: {id: string; label: string; ownerId: string}}[]}}};
type OwnerConnection = {total: number; edges: {cursor: string; node: {label: string}}[]};

let client: Awaited<ReturnType<typeof makeClient>>;

/**
 * The id codec reaches this adapter through `replaceIdInArgs` / `replaceIdInWhere`,
 * which is also where the cross-type check lives — see #42.
 */
const OwnerDef = {
  name: "Owner",
  define: {
    id: { type: DataTypes.UUID, primaryKey: true },
    label: { type: DataTypes.String, index: true },
  },
  relationships: [{ type: "hasMany", model: "Thing", name: "things", options: { foreignKey: "ownerId" } }],
  options: {},
};

const ThingDef = {
  name: "Thing",
  define: {
    id: { type: DataTypes.UUID, primaryKey: true },
    label: { type: DataTypes.String, index: true },
  },
  relationships: [{ type: "belongsTo", model: "Owner", name: "owner", options: { foreignKey: "ownerId" } }],
  options: {},
};

async function build(options: GqlizeOptions = {}) {
  const orm = new Ormize();
  orm.registerAdapter(new ValkeyAdapter({ prefix: "gql" }, client), "valkey");
  await orm.addDefinition(OwnerDef);
  await orm.addDefinition(ThingDef);
  await orm.initialise();
  await orm.sync();
  return { orm, schema: await createSchema(orm, options) };
}

beforeAll(async () => { client = await makeClient(); });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await flush(client); });

describe("valkey adapter — id codecs", () => {
  it("round-trips the default relay id through a where filter", async () => {
    const { orm, schema } = await build();
    const owner = (await orm.processCreate("Owner", null, { input: { label: "o" } }, {}, undefined))[0] as Row;
    await orm.processCreate("Thing", null, { input: { label: "t", ownerId: owner.id } }, {}, undefined);

    const r = await graphql({ schema, source:
      `query { models { Thing(where: { ownerId: { eq: "${toGlobalId("Owner", owner.id)}" } }) { total edges { node { label ownerId } } } } }`,
    }) as QueryResult;
    expect(r.errors).toBeUndefined();
    const { Thing } = data<ThingPage>(r).models;
    expect(Thing.total).toBe(1);
    expect(Thing.edges[0].node.ownerId).toEqual(toGlobalId("Owner", owner.id));
  });

  // bug 2 in #42: the type half was decoded and discarded.
  it("refuses a global id minted for another type", async () => {
    const { orm, schema } = await build();
    const owner = (await orm.processCreate("Owner", null, { input: { label: "o" } }, {}, undefined))[0] as Row;
    await orm.processCreate("Thing", null, { input: { label: "t", ownerId: owner.id } }, {}, undefined);

    const r = await graphql({ schema, source:
      `query { models { Thing(where: { ownerId: { eq: "${toGlobalId("Thing", owner.id)}" } }) { total } } }`,
    }) as QueryResult;
    expect(r.errors).toBeUndefined();
    expect(data<ThingPage>(r).models.Thing.total).toBe(0);
  });

  it("uses a configured id codec on both sides of the wire", async () => {
    const id = prefixIdCodec({ prefixes: { Owner: "own_", Thing: "thg_" } });
    const { orm, schema } = await build({ id });
    const owner = (await orm.processCreate("Owner", null, { input: { label: "o" } }, {}, undefined))[0] as Row;
    await orm.processCreate("Thing", null, { input: { label: "t", ownerId: owner.id } }, {}, undefined);

    const r = await graphql({ schema, source:
      `query { models { Thing(where: { ownerId: { eq: "own_${owner.id}" } }) { total edges { node { id ownerId } } } } }`,
    }) as QueryResult;
    expect(r.errors).toBeUndefined();
    const { Thing } = data<ThingPage>(r).models;
    expect(Thing.total).toBe(1);
    expect(Thing.edges[0].node.ownerId).toEqual(`own_${owner.id}`);
    expect(Thing.edges[0].node.id).toMatch(/^thg_/);
  });
});

describe("valkey adapter — cursor codecs", () => {
  it("pages with a configured cursor codec", async () => {
    const cursor = plainCursorCodec();
    const { orm, schema } = await build({ cursor });
    for (const label of ["a", "b", "c"]) {
      await orm.processCreate("Owner", null, { input: { label } }, {}, undefined);
    }
    const page = async (args: string) => {
      const r = await graphql({ schema, source:
        `query { models { Owner(${args}, orderBy: labelASC) { total edges { cursor node { label } } } } }`,
      }) as QueryResult;
      expect(r.errors).toBeUndefined();
      return data<{models: {Owner: OwnerConnection}}>(r).models.Owner;
    };
    const first = await page("first: 2");
    expect(first.edges.map((e) => e.node.label)).toEqual(["a", "b"]);
    const connection = cursor.decode({ value: first.edges[0].cursor })!.connection;
    expect(first.edges[1].cursor).toEqual(cursor.encode({ connection, index: 1 }));

    const next = await page(`first: 2, after: "${first.edges[1].cursor}"`);
    expect(next.edges.map((e) => e.node.label)).toEqual(["c"]);
  });

  it("rejects a malformed cursor", async () => {
    const { schema } = await build({ cursor: plainCursorCodec() });
    const r = await graphql({ schema, source:
      `query { models { Owner(first: 1, after: "@@@") { total } } }`,
    }) as QueryResult;
    expect(r.errors?.[0]?.message).toEqual("Invalid cursor");
  });
});
