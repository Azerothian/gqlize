import {describe, expect, it} from "@jest/globals";
import {GraphQLEnumType, GraphQLInputObjectType, GraphQLList, GraphQLString} from "graphql";
import type {Definition, Permission} from "@azerothian/utilize/types/index";
import {
  getDefaultListArgs,
  getFilterGraphQLType,
  getIncludeGraphQLType,
  getOrderByGraphQLType,
  type AdapterArgsHost,
  type HostRelationship,
} from "../src/adapter-args";
import type {QueryTypeConfig} from "../src/query";

// These four builders carry the permission guards for `where`/`orderBy`/`include`,
// so the tests below are as much about what does NOT come out as what does: a
// denied field must not become sortable, and a denied model must not become a
// join target. The host is hand-rolled rather than a real adapter — that is the
// point of the structural interface, and it keeps the graph small enough to
// state the expected output exactly.

type FakeModel = {
  /** What `orderableFields` returns, before permission filtering. */
  order: string[];
  relationships: HostRelationship[];
};

/** Task -> User -> Task, plus a relationship to a model this adapter does not own. */
const MODELS: {[name: string]: FakeModel} = {
  Task: {
    order: ["name", "createdAt"],
    relationships: [{name: "owner", model: "User"}, {name: "remote", model: "Elsewhere"}],
  },
  User: {
    order: ["email"],
    relationships: [{name: "tasks", model: "Task"}],
  },
};

type FakeHost = AdapterArgsHost & {
  /** Every `queryConfigFor` call, in order — this is how memoization is observed. */
  configCalls: {defName: string; permission?: Permission}[];
  meta: {[key: string]: unknown};
};

function makeHost(opts: {
  models?: {[name: string]: FakeModel};
  includeIsList?: boolean;
  buildPermission?: Permission;
} = {}): FakeHost {
  const models = opts.models || MODELS;
  const meta: {[key: string]: unknown} = {};
  const configCalls: {defName: string; permission?: Permission}[] = [];
  return {
    _buildPermission: opts.buildPermission,
    configCalls,
    meta,
    includeIsList: opts.includeIsList || false,
    getMetaObj: (defName, key) => meta[`${defName}.${key}`],
    setMetaObj: (defName, key, value) => {
      meta[`${defName}.${key}`] = value;
    },
    queryConfigFor(defName: string, _definition?: Definition, permission?: Permission): QueryTypeConfig {
      configCalls.push({defName, permission});
      return {
        modelName: defName,
        fields: {id: GraphQLString, name: GraphQLString},
        valueFuncs: ["eq"],
        arrayValues: ["in"],
        arrayFuncs: ["or"],
      };
    },
    orderableFields: (defName) => models[defName]?.order || [],
    relationshipsOf: (defName) => models[defName]?.relationships || [],
    // A model absent from `models` is another adapter's, so it has no target here.
    targetOf: (modelName) => (models[modelName] ? {name: modelName, definition: {} as Definition} : undefined),
  };
}

/** Unwrap whichever of the two include shapes the host asked for. */
function includeObject(type: unknown): GraphQLInputObjectType {
  const object = type instanceof GraphQLList ? type.ofType : type;
  expect(object).toBeInstanceOf(GraphQLInputObjectType);
  return object as GraphQLInputObjectType;
}

const denyAll = (): boolean => false;

describe("getFilterGraphQLType", () => {
  it("builds the query type once and memoizes it on the meta store", () => {
    const host = makeHost();
    const first = getFilterGraphQLType(host, "Task");
    const second = getFilterGraphQLType(host, "Task");
    expect(first.name).toBe("GQLTQueryTaskWhere");
    expect(second).toBe(first);
    expect(host.configCalls).toHaveLength(1);
    expect(host.meta["Task.queryType"]).toBe(first);
  });

  it("passes an explicit permission in preference to the build-time one", () => {
    const buildPermission: Permission = {options: "build"};
    const explicit: Permission = {options: "explicit"};
    const host = makeHost({buildPermission});
    getFilterGraphQLType(host, "Task", undefined, explicit);
    expect(host.configCalls[0].permission).toBe(explicit);
  });

  it("falls back to the build-time permission when none is passed", () => {
    const buildPermission: Permission = {options: "build"};
    const host = makeHost({buildPermission});
    getFilterGraphQLType(host, "Task");
    expect(host.configCalls[0].permission).toBe(buildPermission);
  });
});

describe("getOrderByGraphQLType", () => {
  it("emits an ASC/DESC pair per field, in field order, as a list of enum values", () => {
    const host = makeHost();
    const type = getOrderByGraphQLType(host, "Task");
    expect(type).toBeInstanceOf(GraphQLList);
    const enumType = (type as GraphQLList<GraphQLEnumType>).ofType;
    expect(enumType.name).toBe("TaskOrderBy");
    expect(enumType.getValues().map((v) => v.name)).toEqual([
      "nameASC", "nameDESC", "createdAtASC", "createdAtDESC",
    ]);
    expect(enumType.getValue("createdAtDESC")?.value).toEqual(["createdAt", "DESC"]);
  });

  it("memoizes, so a second call returns the same list instance", () => {
    const host = makeHost();
    expect(getOrderByGraphQLType(host, "Task")).toBe(getOrderByGraphQLType(host, "Task"));
  });

  it("returns undefined and leaves the meta unset when every field is denied", () => {
    // An enum with no values is an invalid GraphQL type, so the argument has to
    // disappear rather than be built empty.
    const host = makeHost({buildPermission: {field: denyAll}});
    expect(getOrderByGraphQLType(host, "Task")).toBeUndefined();
    expect(host.meta["Task.orderByType"]).toBeUndefined();
    expect(getOrderByGraphQLType(host, "Task")).toBeUndefined();
  });

  it("keeps `id` orderable even when the field predicate denies everything", () => {
    // `isFieldAllowed` special-cases `id`; ordering follows it, so a deny-all
    // permission still leaves a stable sort key rather than no orderBy at all.
    const host = makeHost({
      models: {Task: {order: ["id", "name"], relationships: []}},
      buildPermission: {field: denyAll},
    });
    const type = getOrderByGraphQLType(host, "Task");
    expect((type as GraphQLList<GraphQLEnumType>).ofType.getValues().map((v) => v.name))
      .toEqual(["idASC", "idDESC"]);
  });
});

describe("getIncludeGraphQLType", () => {
  it("returns undefined for a model with no relationships", () => {
    const host = makeHost({models: {Task: {order: ["name"], relationships: []}}});
    expect(getIncludeGraphQLType(host, "Task")).toBeUndefined();
  });

  it("skips a relationship whose target belongs to another adapter", () => {
    // `remote` points at `Elsewhere`, which `targetOf` does not resolve: it
    // cannot be eager-loaded in one round trip, so it is not includable.
    const host = makeHost();
    expect(Object.keys(includeObject(getIncludeGraphQLType(host, "Task")).getFields()))
      .toEqual(["owner"]);
  });

  it("skips a denied relationship", () => {
    const host = makeHost({
      buildPermission: {relationship: (_def, relName) => relName !== "owner"},
    });
    expect(getIncludeGraphQLType(host, "Task")).toBeUndefined();
  });

  it("passes the target model name to the relationship predicate", () => {
    const seen: string[] = [];
    const host = makeHost({
      buildPermission: {
        relationship: (defName, relName, targetName) => {
          seen.push(`${defName}.${relName}->${targetName}`);
          return true;
        },
      },
    });
    getIncludeGraphQLType(host, "Task");
    expect(seen).toEqual(["Task.owner->User", "Task.remote->Elsewhere"]);
  });

  it("skips a relationship whose target model is denied", () => {
    // A denied model has no output type in the schema, so including it would
    // expose a restricted datatype as a join target.
    const host = makeHost({buildPermission: {model: (defName) => defName !== "User"}});
    expect(getIncludeGraphQLType(host, "Task")).toBeUndefined();
  });

  it("wraps the include object in a list and renames it when the host joins", () => {
    const list = getIncludeGraphQLType(makeHost({includeIsList: true}), "Task");
    expect(list).toBeInstanceOf(GraphQLList);
    expect(includeObject(list).name).toBe("GQLTTaskIncludeObject");
  });

  it("leaves the include object unwrapped when the host takes one object", () => {
    const object = getIncludeGraphQLType(makeHost(), "Task");
    expect(object).toBeInstanceOf(GraphQLInputObjectType);
    expect(includeObject(object).name).toBe("GQLTTaskInclude");
  });

  it("gives each entry where/orderBy/include from the target, and recurses", () => {
    const host = makeHost();
    const owner = includeObject(getIncludeGraphQLType(host, "Task")).getFields().owner;
    const entry = owner.type as GraphQLInputObjectType;
    expect(entry.name).toBe("GQLTTaskIncludeownerObject");
    expect(Object.keys(entry.getFields())).toEqual(["required", "separate", "where", "orderBy", "include"]);
    expect((entry.getFields().where.type as GraphQLInputObjectType).name).toBe("GQLTQueryUserWhere");
    // The nested include is User's, and its own `tasks` entry resolves back to
    // the memoized Task include rather than recursing forever.
    const nested = includeObject(entry.getFields().include.type);
    expect(nested.name).toBe("GQLTUserInclude");
    expect(Object.keys(nested.getFields())).toEqual(["tasks"]);
  });

  it("omits orderBy and include for a leaf target that has neither", () => {
    const host = makeHost({
      models: {
        Task: {order: ["name"], relationships: [{name: "tag", model: "Tag"}]},
        Tag: {order: [], relationships: []},
      },
    });
    const tag = includeObject(getIncludeGraphQLType(host, "Task")).getFields().tag;
    expect(Object.keys((tag.type as GraphQLInputObjectType).getFields()))
      .toEqual(["required", "separate", "where"]);
  });
});

describe("getDefaultListArgs", () => {
  it("always has where, and adds include when the model has one", () => {
    const args = getDefaultListArgs(makeHost(), "Task");
    expect(Object.keys(args)).toEqual(["where", "include"]);
    expect((args.where.type as GraphQLInputObjectType).name).toBe("GQLTQueryTaskWhere");
  });

  it("omits include entirely when there is nothing includable", () => {
    const host = makeHost({models: {Task: {order: ["name"], relationships: []}}});
    expect(Object.keys(getDefaultListArgs(host, "Task"))).toEqual(["where"]);
  });
});
