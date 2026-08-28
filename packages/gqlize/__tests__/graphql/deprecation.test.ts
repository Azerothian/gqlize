import Sequelize from "sequelize";
import {printSchema, type GraphQLObjectType, type GraphQLEnumType, type GraphQLInputObjectType, type GraphQLSchema} from "graphql";
import {describe, it, expect} from "@jest/globals";

import {createInstance} from "../helper";
import {createSchema} from "../../src";
import {materializeSchema, snapshotSchema} from "../../src/snapshot";
import type {Definition} from "../../src/types";

/**
 * `@deprecated` is the one schema-evolution tool GraphQL gives a server, and it
 * is the only way a definition can retire a column without breaking every client
 * at once. These tests pin the three declaration forms (`define[x].deprecated`,
 * `deprecations.*`, model-level `deprecated`), where each one lands, and the two
 * places it must NOT land — a required input field, which graphql rejects.
 */

const RETIRED: Definition = {
  name: "Retired",
  define: {
    name: {type: Sequelize.STRING, allowNull: true},
    // authored on the column
    legacyCode: {type: Sequelize.STRING, allowNull: true, deprecated: "use `name`"},
    // NOT NULL, so the create input types it `String!` — it cannot be deprecated
    // there, only on the optional update input.
    required: {type: Sequelize.STRING, allowNull: false, deprecated: "going away in v8"},
  },
  deprecations: {
    // wins over nothing here, but proves the central map reaches a column
    fields: {name: "renamed to `title`"},
  },
  relationships: [],
};

/**
 * The two groups a *field* cannot reach: `deprecations.classMethods` names class-method
 * query fields, and `deprecations.instanceMethods` names the `apply` input fields for
 * instance-method transforms — the same set `comments.instanceMethods` describes. A
 * relationship is here too, because it has no declaration of its own to write
 * `deprecated` on and the central map is the only way to reach it.
 */
const SUNSET: Definition = {
  name: "Sunset",
  define: {name: {type: Sequelize.STRING, allowNull: true}},
  relationships: [{type: "hasMany", model: "SunsetLeaf", name: "leaves", options: {foreignKey: "sunsetId"}}],
  deprecations: {
    fields: {leaves: "query SunsetLeaf directly"},
    classMethods: {oldSearch: "use `Sunset(where:)`"},
    instanceMethods: {trimName: "the server trims on write now"},
  },
  expose: {
    classMethods: {query: {oldSearch: {type: "Sunset[]"}}},
    instanceMethods: {mutations: {trimName: {}, keepName: {}}},
  },
  classMethods: {oldSearch: () => []},
  instanceMethods: {
    trimName(this: {name: string}) { this.name = this.name.trim(); },
    keepName() { /* no-op */ },
  },
};

const SUNSET_LEAF: Definition = {
  name: "SunsetLeaf",
  define: {label: {type: Sequelize.STRING, allowNull: true}},
  relationships: [{type: "belongsTo", model: "Sunset", name: "sunset", options: {foreignKey: "sunsetId"}}],
};

const GHOSTED: Definition = {
  name: "Ghosted",
  deprecated: "merged into Retired",
  define: {
    name: {type: Sequelize.STRING, allowNull: true},
  },
  relationships: [],
};

function objectField(schema: GraphQLSchema, typeName: string, fieldName: string) {
  return (schema.getType(typeName) as GraphQLObjectType).getFields()[fieldName];
}

function inputField(schema: GraphQLSchema, typeName: string, fieldName: string) {
  return (schema.getType(typeName) as GraphQLInputObjectType).getFields()[fieldName];
}

describe("@deprecated", () => {
  it("marks a column deprecated from the field and from the central map", async() => {
    const instance = await createInstance([RETIRED]);
    const schema = await createSchema(instance);

    expect(objectField(schema, "Retired", "legacyCode").deprecationReason).toEqual("use `name`");
    expect(objectField(schema, "Retired", "name").deprecationReason).toEqual("renamed to `title`");
    expect(objectField(schema, "Retired", "required").deprecationReason).toEqual("going away in v8");
    // nothing else picked it up
    expect(objectField(schema, "Retired", "id").deprecationReason).toBeFalsy();
  });

  it("carries the reason onto both halves of the orderBy enum pair", async() => {
    const instance = await createInstance([RETIRED]);
    const schema = await createSchema(instance);
    const orderBy = schema.getType("RetiredOrderBy") as GraphQLEnumType;
    const byName = Object.fromEntries(orderBy.getValues().map((v) => [v.name, v.deprecationReason]));

    expect(byName.legacyCodeASC).toEqual("use `name`");
    expect(byName.legacyCodeDESC).toEqual("use `name`");
    expect(byName.idASC).toBeFalsy();
  });

  it("deprecates an optional input field but never a required one", async() => {
    const instance = await createInstance([RETIRED]);
    const schema = await createSchema(instance);

    // create input: `required` is `String!`, so the reason must be dropped —
    // graphql rejects "Required input field cannot be deprecated".
    expect(inputField(schema, "RetiredRequiredInput", "required").deprecationReason).toBeFalsy();
    expect(inputField(schema, "RetiredRequiredInput", "legacyCode").deprecationReason).toEqual("use `name`");
    // update input: everything is optional, so it can be marked
    expect(inputField(schema, "RetiredOptionalInput", "required").deprecationReason).toEqual("going away in v8");
  });

  it("deprecates a model through the root fields that lead to it", async() => {
    const instance = await createInstance([GHOSTED]);
    const schema = await createSchema(instance);

    // The roots are `RootQuery` / `Mutation`, each with a `models` container.
    const models = (schema.getType("QueryModels") as GraphQLObjectType).getFields();
    expect(models.Ghosted.deprecationReason).toEqual("merged into Retired");
    expect(models.Parent.deprecationReason).toBeFalsy();

    const mutations = (schema.getType("MutationModels") as GraphQLObjectType).getFields();
    expect(mutations.Ghosted.deprecationReason).toEqual("merged into Retired");
  });

  it("deprecates a relationship, a class-method query field and an `apply` transform", async() => {
    const instance = await createInstance([SUNSET, SUNSET_LEAF]);
    const schema = await createSchema(instance);

    // a relationship has no `deprecated` slot of its own — the map is the only way
    expect(objectField(schema, "Sunset", "leaves").deprecationReason)
      .toEqual("query SunsetLeaf directly");

    const classMethods = (schema.getType("QueryClassMethods") as GraphQLObjectType)
      .getFields().Sunset.type as GraphQLObjectType;
    expect(classMethods.getFields().oldSearch.deprecationReason).toEqual("use `Sunset(where:)`");

    // `deprecations.instanceMethods` names the `apply` input fields, mirroring
    // `comments.instanceMethods` — not the instance-method *query* fields.
    const apply = schema.getType("GQLTSunsetInstanceMutations") as GraphQLInputObjectType;
    expect(apply.getFields().trimName.deprecationReason).toEqual("the server trims on write now");
    expect(apply.getFields().keepName.deprecationReason).toBeFalsy();
  });

  it("survives the artifact round-trip", async() => {
    const instance = await createInstance([RETIRED, GHOSTED]);
    const live = await createSchema(instance);
    const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));
    const rebuilt = await materializeSchema(artifact, instance);

    // the SDL is where `@deprecated` actually shows up, so compare there first
    expect(printSchema(rebuilt)).toEqual(printSchema(live));
    expect(printSchema(live)).toContain('@deprecated(reason: "use `name`")');
    expect(objectField(rebuilt, "Retired", "legacyCode").deprecationReason).toEqual("use `name`");

    const orderBy = rebuilt.getType("RetiredOrderBy") as GraphQLEnumType;
    expect(orderBy.getValues().find((v) => v.name === "legacyCodeASC")?.deprecationReason)
      .toEqual("use `name`");
  });
});
