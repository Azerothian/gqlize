import {
  GraphQLEnumType,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  isEnumType,
  type GraphQLFieldConfigMap,
} from "graphql";
import {describe, it, expect} from "@jest/globals";

import {createInstance} from "../helper";
import {createSchema} from "../../src";
import {createLedger} from "../../src/graphql/snapshot/ledger";
import {snapshotSchema} from "../../src/graphql/snapshot/snapshot";
import {SNAPSHOT_FORMAT_VERSION, type ObjectTypeIR} from "../../src/graphql/snapshot/ir";

/** minimal gqlize-shaped schema: a ledger in `extensions` is what makes it snapshottable */
function bare(fields: GraphQLFieldConfigMap<any, any>) {
  return new GraphQLSchema({
    query: new GraphQLObjectType({name: "RootQuery", fields}),
    extensions: {gqlize: createLedger()},
  });
}

describe("snapshotSchema — guards", () => {
  it("refuses a schema that gqlize did not build", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({name: "RootQuery", fields: {a: {type: GraphQLString}}}),
    });
    expect(() => snapshotSchema(schema)).toThrow(/no build ledger/);
  });

  it("throws on a resolver with no binding descriptor", () => {
    expect(() => snapshotSchema(bare({bare: {type: GraphQLString, resolve: () => "x"}})))
      .toThrow(/RootQuery\.bare has a resolver but no binding descriptor/);
  });

  it("throws on isTypeOf", () => {
    const Thing = new GraphQLObjectType({
      name: "Thing",
      fields: {a: {type: GraphQLString}},
      isTypeOf: () => true,
    });
    expect(() => snapshotSchema(bare({thing: {type: Thing}}))).toThrow(/Thing defines isTypeOf/);
  });

  it("throws on a non-node interface with resolveType", () => {
    const Named = new GraphQLInterfaceType({
      name: "Named",
      fields: {a: {type: GraphQLString}},
      resolveType: () => "Thing",
    });
    expect(() => snapshotSchema(bare({named: {type: Named}}))).toThrow(
      /interface Named defines resolveType/,
    );
  });

  it("throws on a non-JSON enum internal value", () => {
    const Bad = new GraphQLEnumType({name: "Bad", values: {a: {value: new Date(0)}}});
    expect(() => snapshotSchema(bare({bad: {type: Bad}})))
      .toThrow(/enum value Bad\.a carries a non-JSON internal value \(Date instance\)/);
  });
});

describe("snapshotSchema — scalars", () => {
  const Money = new GraphQLScalarType({name: "Money"});

  it("throws on an unregistered scalar at both ends", () => {
    expect(() => snapshotSchema(bare({m: {type: Money}}))).toThrow(
      /scalar "Money" is not in the scalar registry/,
    );
  });

  it("accepts it once supplied, and records the registry key", () => {
    const snap = snapshotSchema(bare({m: {type: Money}}), {scalars: {Money}});
    expect(snap.ledger.scalars).toEqual({Money: "Money"});
    expect(snap.types.find((t) => t.name === "Money")).toMatchObject({
      kind: "scalar",
      registryKey: "Money",
    });
  });

  it("carries specifiedByURL", () => {
    const Odd = new GraphQLScalarType({name: "Odd", specifiedByURL: "https://example.com/odd"});
    const snap = snapshotSchema(bare({o: {type: Odd}}), {scalars: {Odd}});
    expect(snap.types.find((t) => t.name === "Odd")).toMatchObject({
      specifiedByURL: "https://example.com/odd",
    });
  });
});

describe("snapshotSchema — defaults", () => {
  it("encodes runtime and literal defaults as const-literal source", () => {
    const snap = snapshotSchema(bare({
      f: {
        type: GraphQLString,
        args: {
          n: {type: GraphQLInt, default: {value: 10}},
          s: {type: GraphQLString, default: {literal: {kind: Kind.STRING, value: "hi"}}},
        },
      },
    }));
    const root = snap.types.find((t) => t.name === "RootQuery") as ObjectTypeIR;
    expect(root.fields[0].args).toEqual([
      {name: "n", type: "Int", defaultLiteral: "10"},
      {name: "s", type: "String", defaultLiteral: '"hi"'},
    ]);
  });

  it("throws with the coordinate on a default it cannot represent", () => {
    expect(() => snapshotSchema(bare({
      f: {type: GraphQLString, args: {n: {type: GraphQLInt, default: {value: () => 1}}}},
    }))).toThrow(/default value for RootQuery\.f\(n:\)/);
  });
});

describe("snapshotSchema — the real fixture", () => {
  it("survives JSON.stringify and keeps every enum internal value", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const snap = snapshotSchema(schema);

    expect(snap.formatVersion).toEqual(SNAPSHOT_FORMAT_VERSION);
    expect(snap.query).toEqual("RootQuery");
    expect(snap.mutation).toEqual("Mutation");
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);

    // the reason this is an IR and not SDL: printSchema drops all of these
    const live: Record<string, [string, unknown][]> = {};
    for (const type of Object.values(schema.getTypeMap())) {
      if (isEnumType(type) && !type.name.startsWith("__")) {
        live[type.name] = type.getValues().map((v) => [v.name, v.value]);
      }
    }
    const encoded = Object.fromEntries(
      snap.types
        .filter((t) => t.kind === "enum")
        .map((t: any) => [t.name, t.values.map((v: any) => [v.name, v.value ?? v.name])]),
    );
    expect(encoded).toEqual(live);
    expect(Object.keys(live).length).toBeGreaterThan(0);
  });

  it("excludes exactly the types the loader rebuilds live", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const snap = snapshotSchema(schema);

    const encoded = new Set(snap.types.map((t) => t.name));
    const missing = Object.keys(schema.getTypeMap()).filter((n) => !encoded.has(n));

    expect(missing.sort()).toEqual([
      // relay node interface — its resolveType closes over a live nodeTypeMapper
      "Node",
      // graphql seeds these itself
      "Boolean", "ID", "Int", "String",
      // user-authored, re-derived from the live definitions
      ...Object.keys(snap.ledger.externalTypes),
      // introspection
      "__Directive", "__DirectiveLocation", "__EnumValue", "__Field",
      "__InputValue", "__Schema", "__Type", "__TypeKind",
    ].sort());
  });

  it("stamps a binding on every field that carries a resolver", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const snap = snapshotSchema(schema);

    // the guard above already throws otherwise; this pins that bindings are
    // actually reaching the IR rather than the schema simply having no resolvers
    const bound = snap.types
      .filter((t): t is ObjectTypeIR => t.kind === "object")
      .flatMap((t) => t.fields)
      .filter((f) => f.binding);
    expect(bound.length).toBeGreaterThan(0);
    const kinds = new Set(bound.map((f) => f.binding!.kind));
    expect([...kinds].sort()).toEqual([
      "classMethod", "connection", "container", "globalId",
      "instanceMethod", "mutationModel", "nodeField", "overrideOutput", "singleRelationship",
    ]);
  });

  it("omits extend fields from the IR but records them in the ledger", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      extend: {query: {health: {type: GraphQLString, resolve: () => "ok"}}},
    });
    const snap = snapshotSchema(schema);
    const root = snap.types.find((t) => t.name === "RootQuery") as ObjectTypeIR;

    expect(root.fields.map((f) => f.name)).not.toContain("health");
    expect(snap.ledger.extendFields).toEqual({query: ["health"], mutation: []});
  });

  it("snapshots a restrictive permission profile", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        model: (defName: string) => defName !== "Parent",
        mutation: (defName: string) => defName !== "Child",
        relationship: (d: string, r: string) => !(d === "Task" && r === "items"),
        queryClassMethods: (d: string, m: string) => m !== "getHiddenData",
      },
    });
    const snap = snapshotSchema(schema);

    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(snap.types.map((t) => t.name)).not.toContain("Parent");
    expect(snap.types.length).toBeGreaterThan(0);
  });
});
