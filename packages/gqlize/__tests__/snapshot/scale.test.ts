import {
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfigMap,
} from "graphql";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import {Ormize} from "@azerothian/ormize";
import {describe, it, expect, jest} from "@jest/globals";

import {createSchema} from "../../src";
import {materializeSchema, snapshotSchema} from "../../src/snapshot";
import {
  enrichDuplicateTypeError,
  findDuplicateTypes,
} from "../../src/graphql/utils/duplicate-types";
import {syntheticDefinitions} from "../../scripts/synthetic-schema";

/**
 * Behaviour at a size no hand-written fixture reaches.
 *
 * Every walk over the type graph used to recurse, and a schema whose models
 * chain model-to-model is a schema whose type graph is as deep as the chain is
 * long — each link runs `Model -> Connection -> Edge -> Model`, so a few
 * hundred models is a few thousand frames. `createSchema` survived it;
 * `snapshotSchema` did not, which meant a schema you could serve was a schema
 * you could not build an artifact for.
 *
 * These are slow — they build a real schema of ~20k types — but the failure
 * they guard is invisible at any size a normal fixture reaches.
 */

/**
 * Measured threshold on the machine this was written on: the recursive walks
 * survived 400 chained models and overflowed at 600. Sitting on 600 keeps the
 * test a real guard without making it the slowest thing in the suite; the
 * frames-per-link are what varies between engines, not the shape.
 */
const MODELS = 600;

jest.setTimeout(120000);

async function chainedOrm(models: number) {
  const db = new Ormize();
  db.registerAdapter(new SequelizeAdapter({}, {dialect: "sqlite", logging: false}), "db");
  // two columns per model: the depth is what is under test, not the width, and
  // every extra column is another few thousand IR entries to serialize
  for (const definition of syntheticDefinitions({models, topology: "chain", fields: 2})) {
    db.addDefinition(definition);
  }
  await db.initialise();
  return db;
}

describe("a deeply chained schema", () => {
  it("snapshots and materializes instead of overflowing the stack", async() => {
    const db = await chainedOrm(MODELS);
    const live = await createSchema(db);

    // through JSON, so this is the artifact and not the live object graph
    const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));
    const rebuilt = await materializeSchema(artifact, db);

    // `printSchema` on ~20k types would be two 15MB strings to diff; the type
    // map is the claim that matters here — every type survived the walk, in
    // order — and the round-trip suites pin the field-level shape at normal size.
    expect(Object.keys(rebuilt.getTypeMap())).toEqual(Object.keys(live.getTypeMap()));

    // the far end of the chain specifically: a walk that quietly stopped short
    // would still produce a schema, just a smaller one
    const deepest = `Synth${MODELS - 1}`;
    expect(rebuilt.getType(deepest)).toBeDefined();
    expect(Object.keys((rebuilt.getType(`Synth${MODELS - 2}`) as any).getFields()))
      .toContain("children");
  });
});

/**
 * A hand-built chain rather than a generated one: this walk only ever runs on a
 * failed `new GraphQLSchema`, so what it needs is a controlled depth and a
 * planted collision, not a database.
 */
function chainOf(prefix: string, depth: number, tail: GraphQLObjectType): GraphQLObjectType {
  let current = tail;
  for (let i = depth; i > 0; i--) {
    const next = current;
    current = new GraphQLObjectType({
      // per-chain prefix: two chains sharing link names would plant 6000
      // collisions and prove nothing about the one under test
      name: `${prefix}Link${i}`,
      fields: (): GraphQLFieldConfigMap<any, any> => ({next: {type: next}}),
    });
  }
  return current;
}

describe("duplicate-type diagnostics at depth", () => {
  it("names the duplicate rather than reporting a stack overflow", async() => {
    // Two distinct instances of one name, each at the bottom of a long chain —
    // the shape a large schema fails with, where the diagnostic is the only
    // thing standing between the user and "multiple types named X" with no
    // indication of which X.
    const shared = (marker: string) => new GraphQLObjectType({
      name: "Shared",
      fields: {[marker]: {type: GraphQLString}},
    });
    const config = {
      query: chainOf("Q", 6000, shared("fromArtifact")),
      mutation: chainOf("M", 6000, shared("fromLive")),
    };

    const duplicates = findDuplicateTypes(config, new Map([["Shared", "options.extend.query.thing"]]));
    expect([...duplicates.keys()]).toEqual(["Shared"]);
    expect(duplicates.get("Shared")).toHaveLength(2);

    const enriched = enrichDuplicateTypeError(
      new Error('Schema must contain uniquely named types but contains multiple types named "Shared".'),
      config,
      new Map([["Shared", "options.extend.query.thing"]]),
    ) as Error;
    expect(enriched.message).toContain('"Shared" exists as 2 distinct instances');
    expect(enriched.message).toContain("options.extend.query.thing");
  });
});
