import {printSchema, isEnumType, GraphQLSchema} from "graphql";
import {describe, it, expect} from "@jest/globals";

import {createInstance} from "./helper";
import {createSchema} from "../src";
import type {SchemaHatch} from "../src/types";
import {GQLIZE_EXT} from "../src/graphql/resolvers/types";
import type {GqlizeBuildLedger} from "../src/graphql/snapshot/ledger";

/** The two escape hatches a built schema carries, neither in the graphql type system. */
type BuiltSchema = GraphQLSchema & {$sql2gql?: SchemaHatch};

/**
 * The refactor gate.
 *
 * `printSchema` pins the shape of the generated type system, and the enum table
 * pins the part `printSchema` cannot see: enum *internal* values. Those carry
 * real payloads — `TaskOrderBy.nameASC` holds `["name","ASC"]` and goes straight
 * to the backend's `order` — and an SDL round-trip destroys them silently, so
 * they need asserting separately or a regression here reads as green.
 *
 * The ledger snapshot pins which user-authored types entered the schema and
 * where from; those are the types a serialized schema must re-derive from the
 * live definitions rather than store.
 *
 * If a change here is intended, re-run with `-u` and read the diff.
 */

function enumTable(schema: GraphQLSchema) {
  const out: Record<string, [string, unknown][]> = {};
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (isEnumType(type)) {
      out[name] = type.getValues().map((v) => [v.name, v.value]);
    }
  }
  return out;
}

describe("golden schema", () => {
  it("default profile", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);

    expect(printSchema(schema)).toMatchSnapshot("sdl");
    expect(enumTable(schema)).toMatchSnapshot("enum internal values");
  });

  it("records a build ledger of user-supplied types", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const ledger = schema.extensions[GQLIZE_EXT] as GqlizeBuildLedger;

    expect(ledger.modelTypes).toEqual(Object.keys((schema as BuiltSchema).$sql2gql!.types));
    expect(ledger.externalTypes).toMatchSnapshot("external types");
    // every recorded name must actually be in the schema
    for (const name of Object.keys(ledger.externalTypes)) {
      expect(schema.getType(name)).toBeDefined();
    }
  });

  it("restrictive permission profile", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        model: (defName) => defName !== "Parent",
        field: (defName, fieldName) => !(defName === "Task" && fieldName === "mutationCheck"),
        mutation: (defName) => defName !== "Child",
        relationship: (defName, relName) => !(defName === "Task" && relName === "items"),
        queryClassMethods: (defName, methodName) => methodName !== "getHiddenData",
      },
    });

    expect(printSchema(schema)).toMatchSnapshot("sdl");
    expect(enumTable(schema)).toMatchSnapshot("enum internal values");
  });

  it("extend fields are recorded in the ledger and gated by permission", async() => {
    const instance = await createInstance();
    const {GraphQLString} = await import("graphql");
    const extend = {
      query: {
        health: {type: GraphQLString, resolve: () => "ok"},
        secret: {type: GraphQLString, resolve: () => "nope"},
      },
    };
    const schema = await createSchema(instance, {
      extend,
      permission: {queryExtension: (key) => key !== "secret"},
    });
    const ledger = schema.extensions[GQLIZE_EXT] as GqlizeBuildLedger;

    expect(ledger.extendFields).toEqual({query: ["health"], mutation: []});
    expect(schema.getQueryType()?.getFields().health).toBeDefined();
    expect(schema.getQueryType()?.getFields().secret).not.toBeDefined();
  });
});
