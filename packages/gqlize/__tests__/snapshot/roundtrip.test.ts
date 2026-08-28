import {
  GraphQLInterfaceType,
  GraphQLObjectType,
  type GraphQLEnumType,
  GraphQLString,
  getNamedType,
  isEnumType,
  lexicographicSortSchema,
  printSchema,
  type GraphQLNamedType,
  type GraphQLSchema,
  type GraphQLType,
} from "graphql";
import Sequelize from "sequelize";
import {describe, it, expect} from "@jest/globals";

import {createInstance} from "../helper";
import {createSchema} from "../../src";
import {materializeSchema, snapshotSchema} from "../../src/snapshot";
import type {MaterializeOptions} from "../../src/graphql/snapshot/materialize";
import type {Definition, GqlizeOptions, SchemaHatch} from "../../src/types";

/** `$sql2gql` hangs off the schema instance rather than the type system. */
type BuiltSchema = GraphQLSchema & {$sql2gql?: SchemaHatch};

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

async function roundtrip(options: GqlizeOptions & MaterializeOptions = {}, extraDefinitions: Definition[] = []) {
  const instance = await createInstance(extraDefinitions);
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

  it("carries the soft-delete enum and its arguments across", async() => {
    // `GQLTDeletedFilter` is a module-level singleton shared by every paranoid
    // model's list field and include input, so it is the one enum whose identity
    // the IR could plausibly lose track of — the broad comparisons above would
    // still pass if it were rebuilt as several look-alike copies.
    const {live, rebuilt} = await roundtrip();

    const filter = rebuilt.getType("GQLTDeletedFilter");
    expect(isEnumType(filter)).toEqual(true);
    expect((filter as GraphQLEnumType).getValues().map((v) => v.name)).toEqual(["EXCLUDE", "INCLUDE", "ONLY"]);

    const argType = (schema: GraphQLSchema) => {
      const models = getNamedType(schema.getQueryType()!.getFields().models.type) as GraphQLObjectType;
      return models.getFields().Memo.args.find((a) => a.name === "deleted")?.type;
    };
    expect(argType(rebuilt)).toBeDefined();
    // The same instance for every field that names it, in the rebuilt schema as
    // in the live one — not a per-field clone that merely prints identically.
    expect(argType(rebuilt)).toBe(filter);
    expect(String(argType(rebuilt))).toEqual(String(argType(live)));
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

  it("reproduces a profile whose restrictions leave a model unreachable", async() => {
    // Issue #52. Denying both the query list field and the mutation entry makes
    // `Loner` an island — built, but referred to by nothing, so `new GraphQLSchema`
    // never walks it into the type map. The build must not record a model type
    // the schema does not publish, or the artifact is inconsistent at birth and
    // no rebuild can fix it.
    const {live, rebuilt, artifact} = await roundtrip({
      permission: {
        query: (defName: string) => defName !== "Loner",
        mutation: (defName: string) => defName !== "Loner",
      },
    }, [{name: "Loner", define: {name: {type: Sequelize.STRING}}, relationships: []}]);

    expect(printSchema(lexicographicSortSchema(rebuilt)))
      .toEqual(printSchema(lexicographicSortSchema(live)));
    expect(enumTable(rebuilt)).toEqual(enumTable(live));
    expect(fieldOrder(rebuilt)).toEqual(fieldOrder(live));

    expect(artifact.ledger.modelTypes).not.toContain("Loner");
    expect(artifact.ledger.modelTypes).not.toContain("Loner[]");
    // the ledger and the escape hatch are one key set, on both schemas
    expect(Object.keys((live as BuiltSchema).$sql2gql!.types)).toEqual(artifact.ledger.modelTypes);
    expect(Object.keys((rebuilt as BuiltSchema).$sql2gql!.types)).toEqual(artifact.ledger.modelTypes);

    // and the artifact is a fixpoint: snapshotting the rebuilt schema gives back
    // the same artifact, so nothing is lost or invented on the way through.
    expect(JSON.parse(JSON.stringify(snapshotSchema(rebuilt)))).toEqual(artifact);
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

  it("resolves every type reference to the schema's own instance", async() => {
    // The loader memoises decoded type refs, so one `[Task!]!` string is parsed
    // once and the resulting wrapper handed to every field that names it. That
    // is only safe while the thing inside the wrapper is *this* schema's named
    // type — a decode cached across materializations would hand out another
    // schema's instances, which is gqlize#16 with extra steps.
    const {rebuilt, artifact} = await roundtrip();

    // the memo only means anything if refs actually repeat — assert they do,
    // rather than passing vacuously if the IR ever stops sharing them
    const refCounts = new Map<string, number>();
    for (const type of artifact.types) {
      for (const field of [...(type.fields || [])]) {
        refCounts.set(field.type, (refCounts.get(field.type) || 0) + 1);
      }
    }
    expect([...refCounts.values()].filter((n) => n > 1).length).toBeGreaterThan(0);

    for (const [name, type] of Object.entries(rebuilt.getTypeMap())) {
      if (name.startsWith("__")) {
        continue;
      }
      // Only object/interface types carry fields with `args` — the other
      // `GraphQLNamedType` members (scalar, enum, union, input object) either
      // have no fields at all or fields without arguments to walk.
      if (!(type instanceof GraphQLObjectType) && !(type instanceof GraphQLInterfaceType)) {
        continue;
      }
      for (const field of Object.values(type.getFields())) {
        // `getNamedType` is overloaded on nullable input; annotate so the
        // non-nullable overload is the one selected for an `any` argument.
        const fieldType: GraphQLNamedType = getNamedType(field.type as GraphQLType);
        expect(fieldType).toBe(rebuilt.getType(fieldType.name));
        for (const arg of field.args) {
          const argType: GraphQLNamedType = getNamedType(arg.type as GraphQLType);
          expect(argType).toBe(rebuilt.getType(argType.name));
        }
      }
    }
  });

  it("rebuilds the relay model map exactly", async() => {
    const {live, rebuilt} = await roundtrip();

    expect(Object.keys((rebuilt as BuiltSchema).$sql2gql!.types))
      .toEqual(Object.keys((live as BuiltSchema).$sql2gql!.types));
    // `node(id:)` and __resolveType break silently if this diverges
    expect(String((rebuilt as BuiltSchema).$sql2gql!.types["Task[]"]))
      .toEqual(String((live as BuiltSchema).$sql2gql!.types["Task[]"]));
  });

  it("carries the ledger onto the rebuilt schema", async() => {
    const {rebuilt, artifact} = await roundtrip();
    expect(rebuilt.extensions.gqlize).toEqual(artifact.ledger);
  });

  it("is idempotent — a snapshot of a materialized schema equals the artifact", async() => {
    const {rebuilt, artifact} = await roundtrip();
    expect(JSON.parse(JSON.stringify(snapshotSchema(rebuilt)))).toEqual(artifact);
  });

  it("refuses an artifact from another format version", async() => {
    const {artifact} = await roundtrip();
    const instance = await createInstance();
    await expect(materializeSchema({...artifact, formatVersion: 99}, instance))
      .rejects.toThrow(/formatVersion 99 is not supported/);
  });
});
