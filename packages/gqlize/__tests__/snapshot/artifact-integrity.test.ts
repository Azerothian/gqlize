import {GraphQLString, isObjectType} from "graphql";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import {Ormize} from "@azerothian/ormize";
import {describe, it, expect} from "@jest/globals";

import {createSchema} from "../../src";
import {materializeSchema, snapshotSchema} from "../../src/snapshot";
import type {ObjectTypeIR, ScalarTypeIR, SchemaSnapshot} from "../../src/graphql/snapshot/ir";

/**
 * The materializer's inconsistency guards.
 *
 * Everything else in this directory exercises artifacts the builder produced, so
 * it only ever proves the happy path. These guards exist for the artifact that
 * is *wrong* — hand-edited, half-migrated, or built against a schema that has
 * since moved — and the whole point of them is that such an artifact must not
 * boot. An unguarded one boots into a schema that is quietly missing a type, and
 * `node(id:)` starts returning null for a model that plainly exists.
 *
 * Each test takes a real artifact and breaks exactly one thing in it.
 */

function defs(): any[] {
  return [
    {
      name: "Parent",
      define: {name: {type: Sequelize.STRING, allowNull: false}},
      relationships: [{
        type: "hasMany", model: "Child", name: "children",
        options: {as: "children", foreignKey: "parentId"},
      }],
    },
    {
      name: "Child",
      define: {name: {type: Sequelize.STRING, allowNull: true}},
      relationships: [{
        type: "belongsTo", model: "Parent", name: "parent",
        options: {foreignKey: "parentId"},
      }],
    },
  ];
}

async function orm(extra: any[] = []) {
  const db = new Ormize();
  db.registerAdapter(new SequelizeAdapter({}, {dialect: "sqlite", logging: false}), "db");
  [...defs(), ...extra].forEach((def) => db.addDefinition(def));
  await db.initialise();
  return db;
}

/** A real artifact, through JSON exactly as it would sit on disk. */
async function artifact(options?: any): Promise<SchemaSnapshot> {
  return JSON.parse(JSON.stringify(snapshotSchema(await createSchema(await orm(), options))));
}

/** Build an artifact, break one thing in it, and try to load it. */
async function loadBroken(breakIt: (snapshot: any) => void, options?: any) {
  const snapshot = await artifact(options);
  breakIt(snapshot);
  return materializeSchema(snapshot as SchemaSnapshot, await orm(), options);
}

/** Make a type reachable from the query root, so its lazy thunks actually run. */
function referenceFromQuery(snapshot: any, typeName: string) {
  const query = snapshot.types.find((t: any) => t.name === snapshot.query) as ObjectTypeIR;
  query.fields.push({name: "ghost", type: typeName});
}

describe("a broken artifact refuses to boot", () => {
  it("rejects a scalar whose registry key no longer exists", async() => {
    await expect(loadBroken((snapshot) => {
      const scalar = snapshot.types.find((t: any) => t.kind === "scalar") as ScalarTypeIR;
      expect(scalar).toBeDefined();
      scalar.registryKey = "no-such-scalar";
    })).rejects.toThrow(/no-such-scalar|scalar/i);
  });

  it("names the referring type when a reference points at nothing", async() => {
    await expect(loadBroken((snapshot) => {
      snapshot.types.push({kind: "union", name: "Ghost", types: ["Nowhere"]});
      referenceFromQuery(snapshot, "Ghost");
    })).rejects.toThrow('gqlize: Ghost references unknown type "Nowhere"');
  });

  it("rejects a union member that is not an object type", async() => {
    // `new GraphQLSchema` would complain too, but its message names neither the
    // referring type nor the artifact it came out of.
    await expect(loadBroken((snapshot) => {
      const enumType = snapshot.types.find((t: any) => t.kind === "enum");
      snapshot.types.push({kind: "union", name: "Ghost", types: [enumType.name]});
      referenceFromQuery(snapshot, "Ghost");
    })).rejects.toThrow(/lists "\w+" as a member, but it is not an object type/);
  });

  it("rejects an implemented interface that is not an interface type", async() => {
    await expect(loadBroken((snapshot) => {
      const child = snapshot.types.find((t: any) => t.name === "Child") as ObjectTypeIR;
      child.interfaces = ["Parent"];
    })).rejects.toThrow('gqlize: Child implements "Parent", but it is not an interface type');
  });

  it("rejects a relay list type whose base model is missing", async() => {
    await expect(loadBroken((snapshot) => {
      snapshot.ledger.modelTypes.push("Ghost[]");
    })).rejects.toThrow('relay model type "Ghost[]" but "Ghost" is not in the schema');
  });

  it("rejects a model type with nothing behind it", async() => {
    // There is no legitimate version of this: a permission-denied model leaves
    // no entry at all rather than an `undefined` hole, so a name the type map
    // cannot answer is corruption. Admitting it used to defer the failure by
    // one line, to `nodeTypeMapper.mapTypes`, as a bare TypeError.
    await expect(loadBroken((snapshot) => {
      snapshot.ledger.modelTypes.push("Ghost");
    })).rejects.toThrow('relay model type "Ghost" but it is not in the schema');
  });

  it("says which extend fields the load-time options failed to supply", async() => {
    // `extend` fields carry live resolvers, so they are never serialized. The
    // build records which ones survived its permission gate precisely so the
    // loader can name them instead of producing a schema that silently lost one.
    const options = {extend: {query: {custom: {type: GraphQLString, resolve: () => "hi"}}}};
    const snapshot = await artifact(options);
    await expect(materializeSchema(snapshot, await orm())).rejects
      .toThrow(/built with extend\.query\.custom, which the load-time options do not supply/);
  });
});

describe("a model no root field reaches", () => {
  it("still round-trips, because the artifact carries it deliberately", async() => {
    // `permission.query` denies its list field, so nothing in the schema refers
    // to `Loner` — but the build still records it as a model type, and the
    // artifact has to carry the type itself or the loader cannot rebuild the map
    // `node(id:)` reads. This is the case the guard above must not reject.
    const loner = [{name: "Loner", define: {name: {type: Sequelize.STRING}}, relationships: []}];
    const options = {permission: {query: (defName: string) => defName !== "Loner"}};

    const snapshot = JSON.parse(JSON.stringify(
      snapshotSchema(await createSchema(await orm(loner), options)),
    ));
    expect(snapshot.ledger.modelTypes).toEqual(expect.arrayContaining(["Loner", "Loner[]"]));
    expect(snapshot.types.some((t: any) => t.name === "Loner")).toBe(true);

    const schema: any = await materializeSchema(snapshot as SchemaSnapshot, await orm(loner), options);
    expect(schema.$sql2gql.types.Loner).toBeDefined();
    // Nothing reaches it: `models` is the only route to a model's list field.
    expect(Object.keys(schema.getQueryType().getFields().models.type.getFields()))
      .toEqual(["Parent", "Child"]);
  });
});

describe("a materialized model type keeps its escape hatch", () => {
  it("partitions its fields the way the live builder did", async() => {
    const schema = await materializeSchema(await artifact(), await orm());
    const child = schema.getType("Child");
    expect(isObjectType(child)).toBe(true);
    const hatch = (child as any).$sql2gql;
    // The live builder stores the memoised partition thunks it happened to
    // build from; here the same partition is recovered from the binding kinds.
    expect(Object.keys(hatch.basicFields())).toEqual(expect.arrayContaining(["id", "name"]));
    expect(Object.keys(hatch.relatedFields())).toEqual(["parent"]);
    expect(Object.keys(hatch.complexFields())).toEqual([]);
    // A related field must not also show up as a basic one.
    expect(Object.keys(hatch.basicFields())).not.toContain("parent");
  });
});
