import Sequelize from "sequelize";
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  graphql,
  parse,
  isEnumType,
  printSchema,
  subscribe,
  type GraphQLSchema,
} from "graphql";
import {describe, it, expect} from "@jest/globals";

import {createInstance} from "../helper";
import {createSchema} from "../../src";
import {resolveExternalType} from "../../src/graphql/external-types";
import {createLedger, getLedger, recordExternalType, setLedger} from "../../src/graphql/snapshot/ledger";
import {materializeSchema, snapshotSchema} from "../../src/snapshot";

/**
 * gqlize#16 — "importing a schema with custom types fails".
 *
 * The snapshot splits types into *serialized* (rebuilt from the IR at load) and
 * *live* (user-authored, so the instance is re-derived or re-supplied). Every
 * case here is one where a single user type reaches the schema through both a
 * live and a serialized path: the live build uses one instance for both, and
 * before the fix the artifact carried a clone, so `new GraphQLSchema` saw two
 * types with one name and refused to build.
 */

function typeNames(artifact: any): string[] {
  return artifact.types.map((t: any) => t.name);
}

function enumValues(schema: GraphQLSchema, name: string) {
  const type = schema.getTypeMap()[name];
  return isEnumType(type) ? type.getValues().map((v) => [v.name, v.value]) : undefined;
}

/** through JSON, so this proves the *artifact* works, not the live object graph */
async function roundtrip(definitions: any[], options: any = {}, loadOptions: any = options) {
  const instance = await createInstance(definitions);
  const live = await createSchema(instance, options);
  const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));
  const rebuilt = await materializeSchema(artifact, instance, loadOptions);
  return {live, rebuilt, artifact, instance};
}

describe("live types shared with the artifact", () => {
  it("keeps one instance when a whereOperatorTypes type is also inside an expose type", async() => {
    // The reported shape: the enum reaches the filter input straight off the
    // definition (a path no gqlize builder sees) and is *also* a field of an
    // `expose` output type, which the ledger does record.
    const SharedStatus = new GraphQLEnumType({
      name: "SharedStatus",
      values: {ON: {value: "on"}, OFF: {value: "off"}},
    });
    const StatusPayload = new GraphQLObjectType({
      name: "StatusPayload",
      fields: () => ({state: {type: SharedStatus}}),
    });
    const {live, rebuilt, artifact} = await roundtrip([{
      name: "Device",
      define: {name: {type: Sequelize.STRING, allowNull: true}},
      whereOperators: {
        statusIs: async() => ({}),
      },
      whereOperatorTypes: {
        statusIs: SharedStatus,
      },
      expose: {
        classMethods: {
          query: {
            getStatus: {type: StatusPayload, args: {}},
          },
        },
      },
      options: {
        tableName: "devices",
        classMethods: {
          getStatus: () => ({state: "on"}),
        },
      },
    }]);

    expect(printSchema(rebuilt)).toEqual(printSchema(live));
    // the user's instance, not a rebuilt lookalike — so its internal values live
    expect(rebuilt.getTypeMap().SharedStatus).toBe(SharedStatus);
    expect(rebuilt.getTypeMap().StatusPayload).toBe(StatusPayload);
    expect(enumValues(rebuilt, "SharedStatus")).toEqual([["ON", "on"], ["OFF", "off"]]);
    // and the artifact no longer carries a clone to collide with
    expect(typeNames(artifact)).not.toContain("SharedStatus");
  });

  it("resolves a custom scalar declared on whereOperatorTypes live, coercion intact", async() => {
    // A scalar cannot be serialized at all — parseValue/serialize are code — so
    // before it was recorded, an artifact with one in a filter input either
    // threw at snapshot time or lost its coercion.
    const Slug = new GraphQLScalarType({
      name: "Slug",
      serialize: (value: any) => `slug:${value}`,
      parseValue: (value: any) => String(value).replace(/^slug:/, ""),
    });
    const {live, rebuilt} = await roundtrip([{
      name: "Page",
      define: {name: {type: Sequelize.STRING, allowNull: true}},
      whereOperators: {slugIs: async() => ({})},
      whereOperatorTypes: {slugIs: Slug},
      options: {tableName: "pages"},
    }]);

    expect(printSchema(rebuilt)).toEqual(printSchema(live));
    const scalar = rebuilt.getTypeMap().Slug as GraphQLScalarType;
    expect(scalar).toBe(Slug);
    expect(scalar.serialize("a")).toEqual("slug:a");
  });

  it("records and re-derives a type declared on a model field's args", async() => {
    // `create-basic-fields` passes `define[field].args` to graphql verbatim, so
    // those types are user-authored and invisible to every other recording site.
    // Only adapters that carry `args` through `getFields` reach this (the
    // sequelize adapter rebuilds its field meta from `rawAttributes` and drops
    // it), so record and resolve are exercised against the same contract here.
    const Casing = new GraphQLEnumType({
      name: "Casing",
      values: {UPPER: {value: "upper"}, LOWER: {value: "lower"}},
    });
    const schemaCache: any = {};
    setLedger(schemaCache, createLedger());
    const ref = {
      via: "definitionField", defName: "Note", fieldName: "body", use: "arg", argName: "casing",
    } as const;
    recordExternalType(schemaCache, Casing, ref);
    expect(getLedger(schemaCache)?.externalTypes.Casing).toEqual(ref);

    const instance: any = {
      getDefinition: () => ({name: "Note"}),
      getFields: () => ({body: {args: {casing: {type: Casing}}}}),
    };
    expect(resolveExternalType("Casing", ref, instance, schemaCache)).toBe(Casing);

    // and a definition that no longer declares the arg says so, rather than
    // failing later inside `new GraphQLSchema`
    const stale: any = {
      getDefinition: () => ({name: "Note"}),
      getFields: () => ({body: {args: {}}}),
    };
    expect(() => resolveExternalType("Casing", ref, stale, schemaCache))
      .toThrow(/argument "casing" on Note\.body/);
  });

  it("does not record types for a permission-denied instance method", async() => {
    const HiddenPayload = new GraphQLObjectType({
      name: "HiddenPayload",
      fields: () => ({secret: {type: GraphQLString}}),
    });
    const permission = {
      queryInstanceMethods: () => false,
    };
    const {rebuilt, artifact} = await roundtrip([{
      name: "Vault",
      define: {name: {type: Sequelize.STRING, allowNull: true}},
      expose: {
        instanceMethods: {
          query: {peek: {type: HiddenPayload, args: {}}},
        },
      },
      options: {
        tableName: "vaults",
        instanceMethods: {peek: () => ({secret: "no"})},
      },
    }], {permission});

    // A denied method contributes no field, so the loader must not be asked to
    // re-derive its types — which it would do eagerly, and could fail on.
    expect(artifact.ledger.externalTypes.HiddenPayload).toBeUndefined();
    expect(rebuilt.getTypeMap().HiddenPayload).toBeUndefined();
  });
});

describe("extend fields through loadSchema", () => {
  const buildExtend = () => {
    const Health = new GraphQLObjectType({
      name: "Health",
      fields: () => ({
        status: {type: GraphQLString, resolve: () => "green"},
        checked: {type: GraphQLBoolean, resolve: () => true},
      }),
    });
    return {
      Health,
      extend: {
        query: {
          health: {
            type: Health,
            resolve: () => ({}),
          },
        },
      },
    };
  };

  it("runs the extend field's own resolvers after a materialize", async() => {
    const {Health, extend} = buildExtend();
    const {rebuilt} = await roundtrip([], {extend});

    expect(rebuilt.getTypeMap().Health).toBe(Health);
    const result: any = await graphql({
      schema: rebuilt,
      source: "{ health { status checked } }",
    });
    expect(result.errors).toBeUndefined();
    // both the root resolver and the nested field resolvers are the user's
    expect(result.data.health).toEqual({status: "green", checked: true});
  });

  it("shares one instance when an extend type is also reachable from a definition", async() => {
    const Grade = new GraphQLEnumType({
      name: "Grade",
      values: {A: {value: "a"}, B: {value: "b"}},
    });
    const Report = new GraphQLObjectType({
      name: "Report",
      fields: () => ({grade: {type: Grade, resolve: () => "a"}}),
    });
    const extend = {
      query: {
        report: {type: Report, resolve: () => ({})},
      },
    };
    // `Grade` reaches the artifact through the filter input as well as through
    // the extend type — the extend form of the reported bug.
    const {live, rebuilt} = await roundtrip([{
      name: "Student",
      define: {name: {type: Sequelize.STRING, allowNull: true}},
      whereOperators: {gradeIs: async() => ({})},
      whereOperatorTypes: {gradeIs: Grade},
      options: {tableName: "students"},
    }], {extend});

    expect(printSchema(rebuilt)).toEqual(printSchema(live));
    expect(rebuilt.getTypeMap().Grade).toBe(Grade);
    const result: any = await graphql({schema: rebuilt, source: "{ report { grade } }"});
    expect(result.errors).toBeUndefined();
    expect(result.data.report).toEqual({grade: "A"});
  });

  it("refuses to load when the artifact's extend fields are not supplied", async() => {
    const {extend} = buildExtend();
    const instance = await createInstance();
    const live = await createSchema(instance, {extend});
    const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));

    await expect(materializeSchema(artifact, instance, {}))
      .rejects.toThrow(/extend\.query\.health/);
    await expect(materializeSchema(artifact, instance, {}))
      .rejects.toThrow(/never serialized/);
  });

  it("accepts the same fields supplied through extendFactory instead", async() => {
    const {extend} = buildExtend();
    const instance = await createInstance();
    const live = await createSchema(instance, {extend});
    const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));

    const rebuilt = await materializeSchema(artifact, instance, {
      extendFactory: () => extend,
    });
    expect(printSchema(rebuilt)).toEqual(printSchema(live));
  });
});

describe("a live type that collides with one the artifact owns", () => {
  it("names both origins and points at extendFactory", async() => {
    const instance = await createInstance();
    const live = await createSchema(instance, {});
    const artifact = JSON.parse(JSON.stringify(snapshotSchema(live)));

    // A stale `Task` from another build: same name, different instance. Swapping
    // it in silently would replace the artifact's model type schema-wide.
    const staleTask = new GraphQLObjectType({
      name: "Task",
      fields: () => ({name: {type: GraphQLString}}),
    });
    const attempt = materializeSchema(artifact, instance, {
      extend: {query: {stale: {type: staleTask, resolve: () => ({})}}},
    });

    await expect(attempt).rejects.toThrow(/more than one type per name/);
    await expect(attempt).rejects.toThrow(/"Task"/);
    await expect(attempt).rejects.toThrow(/extendFactory/);
  });
});

describe("root slots", () => {
  const subscriptionFor = (taskType: any) => new GraphQLObjectType({
    name: "Subscription",
    fields: () => ({
      taskChanged: {
        type: taskType,
        subscribe: async function* () {
          yield {taskChanged: {id: 1, name: "sub"}};
        },
        resolve: (payload: any) => payload.taskChanged,
      },
    }),
  });

  it("builds a subscription root against the materialized types via extendFactory", async() => {
    const instance = await createInstance();
    const artifact = JSON.parse(JSON.stringify(
      snapshotSchema(await createSchema(instance, {})),
    ));

    const rebuilt = await materializeSchema(artifact, instance, {
      extendFactory: (types: any) => ({root: {subscription: subscriptionFor(types.Task)}}),
    });

    expect(rebuilt.getSubscriptionType()?.name).toEqual("Subscription");
    // one `Task`, shared between the query and subscription roots
    expect(rebuilt.getSubscriptionType()?.getFields().taskChanged.type)
      .toBe(rebuilt.getTypeMap().Task);

    // and the user's `subscribe` — a closure, so it only survives by reference
    const stream: any = await subscribe({
      schema: rebuilt,
      document: parse("subscription { taskChanged { name } }"),
    });
    const first = await stream.next();
    expect(first.value.errors).toBeUndefined();
    expect(first.value.data.taskChanged).toEqual({name: "sub"});
  });

  it("reports the collision when `root` supplies a stale copy of a model type", async() => {
    const instance = await createInstance();
    const artifact = JSON.parse(JSON.stringify(
      snapshotSchema(await createSchema(instance, {})),
    ));
    const staleTask = new GraphQLObjectType({
      name: "Task",
      fields: () => ({name: {type: GraphQLString}}),
    });

    await expect(materializeSchema(artifact, instance, {
      root: {subscription: subscriptionFor(staleTask)},
    } as any)).rejects.toThrow(/more than one type per name[\s\S]*"Task"/);
  });
});
