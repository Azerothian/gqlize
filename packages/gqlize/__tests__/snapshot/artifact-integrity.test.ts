import {graphql, GraphQLSchema, GraphQLString, isObjectType} from "graphql";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import {Ormize} from "@azerothian/ormize";
import {describe, it, expect} from "@jest/globals";

import {createSchema} from "../../src";
import {defaultIdCodec} from "../../src/codecs/id";
import {GQLIZE_EXT} from "../../src/graphql/resolvers/types";
import type {GqlizeBuildLedger} from "../../src/graphql/snapshot/ledger";
import {materializeSchema, snapshotSchema} from "../../src/snapshot";
import type {ScalarTypeIR, SchemaSnapshot} from "../../src/graphql/snapshot/ir";
import type {Definition, GqlizeOptions, ModelTypeHatch, SchemaHatch} from "../../src/types";
import type {MaterializeOptions} from "../../src/graphql/snapshot/materialize";

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

function defs(): Definition[] {
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

async function orm(extra: Definition[] = []) {
  const db = new Ormize();
  db.registerAdapter(new SequelizeAdapter({}, {dialect: "sqlite", logging: false}), "db");
  for (const def of [...defs(), ...extra]) {
    await db.addDefinition(def);
  }
  await db.initialise();
  return db;
}

/** A real artifact, through JSON exactly as it would sit on disk. */
async function artifact(options?: GqlizeOptions): Promise<SchemaSnapshot> {
  return JSON.parse(JSON.stringify(snapshotSchema(await createSchema(await orm(), options))));
}

/** Build an artifact, break one thing in it, and try to load it. */
async function loadBroken(breakIt: (snapshot: SchemaSnapshot) => void, options?: GqlizeOptions & MaterializeOptions) {
  const snapshot = await artifact(options);
  breakIt(snapshot);
  return materializeSchema(snapshot, await orm(), options);
}

/** Make a type reachable from the query root, so its lazy thunks actually run. */
function referenceFromQuery(snapshot: SchemaSnapshot, typeName: string) {
  const query = snapshot.types.find((t) => t.name === snapshot.query);
  if (!query || query.kind !== "object") {
    throw new Error(`Expected snapshot to have an object type named "${snapshot.query}" for its query root`);
  }
  query.fields.push({name: "ghost", type: typeName});
}

describe("a broken artifact refuses to boot", () => {
  it("rejects a scalar whose registry key no longer exists", async() => {
    await expect(loadBroken((snapshot) => {
      const scalar = snapshot.types.find((t): t is ScalarTypeIR => t.kind === "scalar");
      expect(scalar).toBeDefined();
      if (!scalar) {
        throw new Error("Expected the snapshot to contain a scalar type");
      }
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
      const enumType = snapshot.types.find((t) => t.kind === "enum");
      if (!enumType) {
        throw new Error("Expected the snapshot to contain an enum type");
      }
      snapshot.types.push({kind: "union", name: "Ghost", types: [enumType.name]});
      referenceFromQuery(snapshot, "Ghost");
    })).rejects.toThrow(/lists "\w+" as a member, but it is not an object type/);
  });

  it("rejects an implemented interface that is not an interface type", async() => {
    await expect(loadBroken((snapshot) => {
      const child = snapshot.types.find((t) => t.name === "Child");
      if (!child || child.kind !== "object") {
        throw new Error('Expected the snapshot to contain an object type named "Child"');
      }
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

/** The `Loner` fixture: no relationships, so only the roots can reach it. */
const LONER: Definition[] = [
  {name: "Loner", define: {name: {type: Sequelize.STRING}}, relationships: []},
];

/** The per-model fields hanging off a root's `models` container. */
function modelContainer(schema: GraphQLSchema, root: "query" | "mutation") {
  const rootType = root === "query" ? schema.getQueryType() : schema.getMutationType();
  if (!rootType) {
    throw new Error(`Expected the schema to have a ${root} type`);
  }
  const container = rootType.getFields().models;
  if (!container || !isObjectType(container.type)) {
    throw new Error(`Expected the ${root} root's "models" field to be an object type`);
  }
  return container.type.getFields();
}

describe("a model reachable only through the mutation root", () => {
  it("still round-trips, because the mutation field refers to it", async() => {
    // `permission.query` denies the list field, but the mutation container's
    // `Loner` field is typed off the same model type, so the schema does publish
    // it and the artifact has to carry it. This is the case the guards above
    // must not reject.
    const options = {permission: {query: (defName: string) => defName !== "Loner"}};

    const snapshot: SchemaSnapshot = JSON.parse(JSON.stringify(
      snapshotSchema(await createSchema(await orm(LONER), options)),
    ));
    expect(snapshot.ledger.modelTypes).toEqual(expect.arrayContaining(["Loner", "Loner[]"]));
    expect(snapshot.types.some((t) => t.name === "Loner")).toBe(true);

    const schema = await materializeSchema(snapshot, await orm(LONER), options);
    const hatch = (schema as GraphQLSchema & {$sql2gql?: SchemaHatch}).$sql2gql;
    expect(hatch?.types.Loner).toBeDefined();
    // The mutation root is what keeps it alive — the query container is the only
    // route to a model's list field, and that one is denied.
    expect(Object.keys(modelContainer(schema, "mutation"))).toContain("Loner");
    expect(Object.keys(modelContainer(schema, "query"))).toEqual(["Parent", "Child"]);
  });
});

describe("a model nothing in the schema reaches", () => {
  // Issue #52. Deny the list field *and* the mutation entry and `Loner` becomes
  // an island: the build still puts it in `schemaCache.types`, but no root
  // reaches it, so it is not in `schema.getTypeMap()` and the reachability walk
  // cannot put it in the artifact either. Recording a model type the schema does
  // not publish makes the artifact inconsistent at birth — which is why the
  // "rebuild it" the guard above suggests never helped.
  const options = {
    permission: {
      query: (defName: string) => defName !== "Loner",
      mutation: (defName: string) => defName !== "Loner",
    },
  };

  it("is left out of the live build's model map", async() => {
    const live = await createSchema(await orm(LONER), options);
    const ledger = live.extensions[GQLIZE_EXT] as GqlizeBuildLedger;

    expect(live.getType("Loner")).toBeUndefined();
    expect(ledger.modelTypes).not.toContain("Loner");
    expect(ledger.modelTypes).not.toContain("Loner[]");
    expect(ledger.modelTypes).toEqual(
      expect.arrayContaining(["Parent", "Parent[]", "Child", "Child[]"]),
    );
    // The invariant the fix establishes: the ledger and the escape hatch are one
    // key set, and every key names a type the schema publishes.
    const hatch = (live as GraphQLSchema & {$sql2gql?: SchemaHatch}).$sql2gql;
    expect(Object.keys(hatch!.types)).toEqual(ledger.modelTypes);
  });

  it("is left out of the artifact, which then loads", async() => {
    const snapshot: SchemaSnapshot = JSON.parse(JSON.stringify(
      snapshotSchema(await createSchema(await orm(LONER), options)),
    ));
    expect(snapshot.types.some((t) => t.name === "Loner")).toBe(false);
    expect(snapshot.ledger.modelTypes).not.toContain("Loner");
    expect(snapshot.ledger.modelTypes).not.toContain("Loner[]");

    const schema = await materializeSchema(snapshot, await orm(LONER), options);
    const hatch = (schema as GraphQLSchema & {$sql2gql?: SchemaHatch}).$sql2gql;
    expect(schema.getType("Loner")).toBeUndefined();
    expect(hatch?.types.Loner).toBeUndefined();
    expect(Object.keys(hatch!.types)).toEqual(snapshot.ledger.modelTypes);
    expect(Object.keys(modelContainer(schema, "query"))).toEqual(["Parent", "Child"]);
  });

  it("resolves node(id:) to null on both schemas, exactly as it did before", async() => {
    // The one thing dropping the entry could have changed, and it does not:
    // `id-fetcher` re-checks `permission.query` per request, and being an island
    // *requires* that predicate to have denied the model — so the lookup was
    // already refused before the node type mapper was ever consulted.
    const globalId = defaultIdCodec.encode({type: "Loner", id: "1", defName: "Loner", fieldName: "id"});
    const source = `query { node(id: "${globalId}") { id } }`;
    const live = await createSchema(await orm(LONER), options);
    const snapshot: SchemaSnapshot = JSON.parse(JSON.stringify(snapshotSchema(live)));
    const rebuilt = await materializeSchema(snapshot, await orm(LONER), options);

    for (const schema of [live, rebuilt]) {
      const result = await graphql({schema, source});
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({node: null});
    }
  });
});

describe("a materialized model type keeps its escape hatch", () => {
  it("partitions its fields the way the live builder did", async() => {
    const schema = await materializeSchema(await artifact(), await orm());
    const child = schema.getType("Child");
    expect(isObjectType(child)).toBe(true);
    if (!isObjectType(child)) {
      throw new Error('Expected "Child" to be a GraphQLObjectType');
    }
    const hatch = (child as typeof child & {$sql2gql?: ModelTypeHatch}).$sql2gql;
    if (!hatch) {
      throw new Error('Expected "Child" to carry its $sql2gql escape hatch');
    }
    // The live builder stores the memoised partition thunks it happened to
    // build from; here the same partition is recovered from the binding kinds.
    expect(Object.keys(hatch.basicFields())).toEqual(expect.arrayContaining(["id", "name"]));
    expect(Object.keys(hatch.relatedFields())).toEqual(["parent"]);
    expect(Object.keys(hatch.complexFields())).toEqual([]);
    // A related field must not also show up as a basic one.
    expect(Object.keys(hatch.basicFields())).not.toContain("parent");
  });
});
