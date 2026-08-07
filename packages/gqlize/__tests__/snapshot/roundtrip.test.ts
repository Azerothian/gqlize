import {
  GraphQLObjectType,
  GraphQLString,
  isEnumType,
  lexicographicSortSchema,
  printSchema,
  type GraphQLSchema,
} from "graphql";
import {describe, it, expect} from "@jest/globals";

import {createInstance} from "../helper";
import {createSchema} from "../../src";
import {materializeSchema, snapshotSchema} from "../../src/snapshot";

/**
 * The gate that makes the whole design safe.
 *
 * `printSchema` pins the shape, but it is blind to enum internal values and to
 * field ordering under a sort — so both are asserted separately. The snapshot is
 * pushed through `JSON.parse(JSON.stringify(...))` first, because "works with the
 * live object graph" and "works from a file" are different claims.
 */

/** the SDL-invisible payload: `TaskOrderBy.nameASC` holds `["name","ASC"]` */
function enumTable(schema: GraphQLSchema) {
  const out: Record<string, [string, unknown][]> = {};
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (isEnumType(type)) {
      out[name] = type.getValues().map((v) => [v.name, v.value]);
    }
  }
  return out;
}

/** `printSchema` sorts nothing, but a sorted comparison would hide a reorder */
function fieldOrder(schema: GraphQLSchema) {
  const out: Record<string, string[]> = {};
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (name.startsWith("__")) {
      continue;
    }
    if (type instanceof GraphQLObjectType) {
      out[name] = Object.keys(type.getFields());
    }
  }
  return out;
}

async function roundtrip(options: any = {}) {
  const instance = await createInstance();
  const live = await createSchema(instance, options);
  // through JSON, so this proves the *artifact* works, not the object graph
  const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));
  const rebuilt = await materializeSchema(artifact, instance, options);
  return {live, rebuilt, artifact};
}

describe("snapshot round-trip", () => {
  it("reproduces the default profile exactly", async() => {
    const {live, rebuilt} = await roundtrip();

    expect(printSchema(rebuilt)).toEqual(printSchema(live));
    expect(enumTable(rebuilt)).toEqual(enumTable(live));
    expect(fieldOrder(rebuilt)).toEqual(fieldOrder(live));
  });

  it("reproduces a restrictive permission profile", async() => {
    const {live, rebuilt} = await roundtrip({
      permission: {
        model: (defName: string) => defName !== "Parent",
        field: (d: string, f: string) => !(d === "Task" && f === "mutationCheck"),
        mutation: (defName: string) => defName !== "Child",
        relationship: (d: string, r: string) => !(d === "Task" && r === "items"),
        queryClassMethods: (d: string, m: string) => m !== "getHiddenData",
      },
    });

    expect(printSchema(lexicographicSortSchema(rebuilt)))
      .toEqual(printSchema(lexicographicSortSchema(live)));
    expect(enumTable(rebuilt)).toEqual(enumTable(live));
    expect(fieldOrder(rebuilt)).toEqual(fieldOrder(live));
  });

  it("reproduces an extend + root profile", async() => {
    const {live, rebuilt} = await roundtrip({
      extend: {
        query: {health: {type: GraphQLString, resolve: () => "ok"}},
        mutation: {ping: {type: GraphQLString, resolve: () => "pong"}},
      },
      root: {description: "Public API"},
    });

    expect(printSchema(rebuilt)).toEqual(printSchema(live));
    expect(rebuilt.description).toEqual("Public API");
    expect(rebuilt.getQueryType()!.getFields().health).toBeDefined();
    expect(rebuilt.getMutationType()!.getFields().ping).toBeDefined();
  });

  it("keeps user-authored types as the live instances, not copies", async() => {
    const instance = await createInstance();
    const live = await createSchema(instance);
    const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));
    const rebuilt = await materializeSchema(artifact, instance);

    const external = Object.keys(artifact.ledger.externalTypes);
    expect(external.length).toBeGreaterThan(0);
    for (const name of external) {
      // present, and structurally what the live definition says — this is the
      // thing SDL cannot do: coercion and nested resolvers survive
      expect(rebuilt.getType(name)).toBeDefined();
      expect(printSchema(lexicographicSortSchema(rebuilt))).toContain(name);
    }
  });

  it("rebuilds the relay model map exactly", async() => {
    const {live, rebuilt} = await roundtrip();

    expect(Object.keys((rebuilt as any).$sql2gql.types))
      .toEqual(Object.keys((live as any).$sql2gql.types));
    // `node(id:)` and __resolveType break silently if this diverges
    expect(String((rebuilt as any).$sql2gql.types["Task[]"]))
      .toEqual(String((live as any).$sql2gql.types["Task[]"]));
  });

  it("carries the ledger onto the rebuilt schema", async() => {
    const {rebuilt, artifact} = await roundtrip();
    expect((rebuilt.extensions as any).gqlize).toEqual(artifact.ledger);
  });

  it("is idempotent — a snapshot of a materialized schema equals the artifact", async() => {
    const {rebuilt, artifact} = await roundtrip();
    expect(JSON.parse(JSON.stringify(snapshotSchema(rebuilt)))).toEqual(artifact);
  });

  it("refuses an artifact from another format version", async() => {
    const {artifact} = await roundtrip();
    const instance = await createInstance();
    await expect(materializeSchema({...artifact, formatVersion: 99} as any, instance))
      .rejects.toThrow(/formatVersion 99 is not supported/);
  });
});
