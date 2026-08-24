import {describe, expect, it} from "@jest/globals";
import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  parse,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLResolveInfo,
  type OperationDefinitionNode,
} from "graphql";
import {JSONType} from "@azerothian/graphql-types";
import buildIncludeFromSelection, {
  buildIncludeMapFromSelection,
  flattenFieldNodes,
  getChildSelectionSet,
  isConnectionRowsSelected,
  mergeIncludeMaps,
  normaliseExplicitInclude,
} from "../../src/graphql/utils/build-include-from-selection";
import {toCursor} from "../../src/graphql/objects/cursor";
import type GQLManager from "../../src/manager";
import type {IncludeMap} from "../../src/types";

// This module decides, per request, which relationships fold into the parent
// query as a JOIN and which are fetched separately — and it does the cursor
// arithmetic for the nested ones. It was reached only transitively through the
// functional suites, which exercise the happy path and nothing else. The tests
// here drive it directly off a parsed document and a fake manager, so the
// pagination arithmetic and the separate-vs-JOIN policy can be stated exactly.

const WhereInput = new GraphQLInputObjectType({
  name: "WhereInput",
  fields: {name: {type: GraphQLString}},
});

/** The argument set every relationship field carries in a real gqlize schema. */
const relationshipArgs = {
  required: {type: GraphQLBoolean},
  separate: {type: GraphQLBoolean},
  where: {type: WhereInput},
  orderBy: {type: new GraphQLList(GraphQLString)},
  first: {type: GraphQLInt},
  last: {type: GraphQLInt},
  // JSON rather than String because a cursor reaches this builder in either of
  // two shapes — opaque base64, or the `{index}` object an adapter's relay arg
  // handling leaves behind once it has decoded one.
  after: {type: JSONType},
  before: {type: JSONType},
  include: {type: new GraphQLList(JSONType)},
};

// Type names are the definition names: `info.schema.getType(association.target)`
// is how the builder finds a child's fields, so the two cannot diverge.
const Item = new GraphQLObjectType({name: "Item", fields: () => ({id: {type: GraphQLID}})});
const User = new GraphQLObjectType({name: "User", fields: () => ({id: {type: GraphQLID}})});
const Order = new GraphQLObjectType({
  name: "Order",
  fields: () => ({id: {type: GraphQLID}, items: {type: new GraphQLList(Item), args: relationshipArgs}}),
});
const Task = new GraphQLObjectType({
  name: "Task",
  fields: () => ({
    id: {type: GraphQLID},
    name: {type: GraphQLString},
    orders: {type: new GraphQLList(Order), args: relationshipArgs},
    owner: {type: User, args: relationshipArgs},
    remote: {type: new GraphQLList(Item), args: relationshipArgs},
    unowned: {type: User, args: relationshipArgs},
    things: {type: new GraphQLList(Item), args: relationshipArgs},
  }),
});
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({name: "Query", fields: {tasks: {type: new GraphQLList(Task)}}}),
  types: [Item, User, Order, Task],
});

const ASSOCIATIONS: {[defName: string]: {[relName: string]: {target: string; associationType: string}}} = {
  Task: {
    orders: {target: "Order", associationType: "hasMany"},
    owner: {target: "User", associationType: "belongsTo"},
    // Target is registered as an association but has no adapter at all.
    unowned: {target: "Nowhere", associationType: "belongsTo"},
    // Lives on a different adapter, so it can never be part of one round trip.
    remote: {target: "Remote", associationType: "hasMany"},
  },
  Order: {items: {target: "Item", associationType: "hasMany"}},
  // A parent with no adapter of its own.
  Orphan: {things: {target: "Item", associationType: "hasMany"}},
};

// Adapter identity is all the builder compares, so a string stands in for one.
const ADAPTERS: {[defName: string]: string} = {
  Task: "sql", Order: "sql", Item: "sql", User: "sql", Remote: "other",
};

const instance = {
  getAssociations: (defName: string) => ASSOCIATIONS[defName] || {},
  getModelAdapter: (defName: string) => {
    const adapter = ADAPTERS[defName];
    if (!adapter) {
      throw new Error(`no adapter for ${defName}`);
    }
    return adapter;
  },
} as unknown as GQLManager;

/** Parse a document and hand back its first root field plus a matching `info`. */
function parseQuery(query: string): {field: FieldNode; info: GraphQLResolveInfo} {
  const document = parse(query);
  const fragments: {[name: string]: FragmentDefinitionNode} = {};
  let operation: OperationDefinitionNode | undefined;
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments[definition.name.value] = definition;
    } else if (definition.kind === Kind.OPERATION_DEFINITION) {
      operation = definition;
    }
  }
  const info = {
    schema,
    fragments,
    variableValues: {coerced: {}, sources: {}},
  } as unknown as GraphQLResolveInfo;
  return {field: operation!.selectionSet.selections[0] as FieldNode, info};
}

/** The include map for a `tasks { edges { node { … } } }` document. */
function planFor(query: string, explicitInclude?: unknown): IncludeMap {
  const {field, info} = parseQuery(query);
  const node = getChildSelectionSet(field.selectionSet, true, info);
  const plan = buildIncludeMapFromSelection(instance, "Task", node, Task, info);
  return explicitInclude ? mergeIncludeMaps(plan, normaliseExplicitInclude(explicitInclude)) : plan;
}

describe("flattenFieldNodes", () => {
  it("expands inline fragments and named spreads into one field list", () => {
    const {field, info} = parseQuery(`
      query { tasks { id ... on Task { name } ...Rest } }
      fragment Rest on Task { orders { id } }
    `);
    expect(flattenFieldNodes(field.selectionSet, info).map((f) => f.name.value))
      .toEqual(["id", "name", "orders"]);
  });

  it("stops a fragment cycle rather than recursing forever", () => {
    const {field, info} = parseQuery(`
      query { tasks { ...A } }
      fragment A on Task { id ...B }
      fragment B on Task { name ...A }
    `);
    expect(flattenFieldNodes(field.selectionSet, info).map((f) => f.name.value))
      .toEqual(["id", "name"]);
  });

  it("skips a spread whose fragment is not in the document", () => {
    const {field, info} = parseQuery(`query { tasks { id ...Missing } }`);
    expect(flattenFieldNodes(field.selectionSet, info).map((f) => f.name.value)).toEqual(["id"]);
  });

  it("memoizes per AST node, so a repeated walk reuses the same array", () => {
    const {field, info} = parseQuery(`query { tasks { id name } }`);
    expect(flattenFieldNodes(field.selectionSet, info)).toBe(flattenFieldNodes(field.selectionSet, info));
  });

  it("returns an empty list for a missing selection set", () => {
    const {info} = parseQuery(`query { tasks { id } }`);
    expect(flattenFieldNodes(undefined, info)).toEqual([]);
  });
});

describe("getChildSelectionSet", () => {
  it("returns the set unchanged for a single-valued relation", () => {
    const {field, info} = parseQuery(`query { tasks { id } }`);
    expect(getChildSelectionSet(field.selectionSet, false, info)).toBe(field.selectionSet);
  });

  it("digs through edges/node for a connection, following fragments", () => {
    const {field, info} = parseQuery(`
      query { tasks { edges { ...E } } }
      fragment E on TaskEdge { node { id } }
    `);
    const node = getChildSelectionSet(field.selectionSet, true, info);
    expect(flattenFieldNodes(node, info).map((f) => f.name.value)).toEqual(["id"]);
  });

  it("returns undefined when the connection selects no edges, and for no set at all", () => {
    const {field, info} = parseQuery(`query { tasks { total } }`);
    expect(getChildSelectionSet(field.selectionSet, true, info)).toBeUndefined();
    expect(getChildSelectionSet(undefined, true, info)).toBeUndefined();
  });
});

describe("isConnectionRowsSelected", () => {
  it("is true when rows are selected, directly or through a fragment", () => {
    const {field, info} = parseQuery(`query { tasks { edges { node { id } } } }`);
    expect(isConnectionRowsSelected(field, info)).toBe(true);
    const viaFragment = parseQuery(`
      query { tasks { ...Rows } }
      fragment Rows on TaskConnection { edges { node { id } } }
    `);
    expect(isConnectionRowsSelected(viaFragment.field, viaFragment.info)).toBe(true);
  });

  it("is false for a count-only selection", () => {
    const {field, info} = parseQuery(`query { tasks { total pageInfo { hasNextPage } } }`);
    expect(isConnectionRowsSelected(field, info)).toBe(false);
  });

  it("defaults to true when the shape is unknown", () => {
    const {field, info} = parseQuery(`query { tasks { id } }`);
    expect(isConnectionRowsSelected(undefined, info)).toBe(true);
    expect(isConnectionRowsSelected({...field, selectionSet: undefined}, info)).toBe(true);
  });
});

describe("mergeIncludeMaps", () => {
  it("unions disjoint relations", () => {
    const merged = mergeIncludeMaps(
      {a: {target: "A", associationType: "hasMany"}},
      {b: {target: "B", associationType: "belongsTo"}},
    );
    expect(Object.keys(merged)).toEqual(["a", "b"]);
  });

  it("ORs the flags, ANDs the wheres, and lets b win on orderBy", () => {
    const merged = mergeIncludeMaps(
      {a: {target: "A", associationType: "hasMany", required: true, where: {x: 1}, orderBy: [["x", "ASC"]]}},
      {a: {target: "", associationType: "", separate: true, where: {y: 2}, orderBy: [["y", "DESC"]]}},
    );
    expect(merged.a.required).toBe(true);
    expect(merged.a.separate).toBe(true);
    // Two wheres for the same relation are additive, not last-wins: dropping one
    // would silently widen the result set.
    expect(merged.a.where).toEqual({and: [{x: 1}, {y: 2}]});
    expect(merged.a.orderBy).toEqual([["y", "DESC"]]);
    // One-sided wheres pass straight through rather than being wrapped.
    expect(mergeIncludeMaps({a: {target: "A", associationType: "hasMany", where: {x: 1}}},
      {a: {target: "A", associationType: "hasMany"}}).a.where).toEqual({x: 1});
    // b's empty target/associationType must not erase a's.
    expect(merged.a.target).toBe("A");
    expect(merged.a.associationType).toBe("hasMany");
  });

  it("merges nested include maps recursively", () => {
    const merged = mergeIncludeMaps(
      {a: {target: "A", associationType: "hasMany", include: [{x: {target: "X", associationType: "hasMany"}}]}},
      {a: {target: "A", associationType: "hasMany", include: [{y: {target: "Y", associationType: "hasMany"}}]}},
    );
    expect(Object.keys(merged.a.include![0])).toEqual(["x", "y"]);
  });

  it("defaults both sides to empty", () => {
    expect(mergeIncludeMaps()).toEqual({});
  });
});

describe("normaliseExplicitInclude", () => {
  it("folds an array of relation-keyed entries into one map", () => {
    const map = normaliseExplicitInclude([
      {orders: {target: "Order", associationType: "hasMany", required: true}},
      {owner: {target: "User", associationType: "belongsTo"}},
    ]);
    expect(Object.keys(map)).toEqual(["orders", "owner"]);
  });

  it("treats anything that is not an array as no include", () => {
    expect(normaliseExplicitInclude(undefined)).toEqual({});
    expect(normaliseExplicitInclude({orders: {}})).toEqual({});
  });
});

describe("buildIncludeMapFromSelection", () => {
  it("includes relationships and ignores scalar fields", () => {
    const plan = planFor(`query { tasks { edges { node { id name owner { id } } } } }`);
    expect(Object.keys(plan)).toEqual(["owner"]);
    expect(plan.owner).toEqual({target: "User", associationType: "belongsTo", required: false});
  });

  it("leaves a cross-adapter relationship out — it is its own root query", () => {
    const plan = planFor(`query { tasks { edges { node { remote { edges { node { id } } } } } } }`);
    expect(plan.remote).toBeUndefined();
  });

  it("skips a connection that selects only a count", () => {
    // The nested resolver runs a count-only query instead, which is what fires
    // beforeCount/afterCount; eager-loading the rows would skip those.
    const plan = planFor(`query { tasks { edges { node { orders { total } } } } }`);
    expect(plan.orders).toBeUndefined();
  });

  it("carries where, orderBy and required through from the field arguments", () => {
    const plan = planFor(`query { tasks { edges { node {
      owner(required: true, where: {name: "bob"}, orderBy: ["nameASC"]) { id }
    } } } }`);
    expect(plan.owner.required).toBe(true);
    expect(plan.owner.where).toEqual({name: "bob"});
    expect(plan.owner.orderBy).toEqual(["nameASC"]);
  });

  it("recurses into a nested connection, digging through its own edges/node", () => {
    const plan = planFor(`query { tasks { edges { node {
      orders { edges { node { id items { edges { node { id } } } } } }
    } } } }`);
    expect(plan.orders.include![0].items.target).toBe("Item");
  });

  it("returns an empty plan for a missing selection set", () => {
    const {info} = parseQuery(`query { tasks { id } }`);
    expect(buildIncludeMapFromSelection(instance, "Task", undefined, Task, info)).toEqual({});
  });

  it("still plans includes when the parent definition has no adapter", () => {
    const {field, info} = parseQuery(`query { tasks { things { edges { node { id } } } } }`);
    // With no parent adapter there is nothing to compare a target against, so
    // the relation is assumed loadable rather than silently dropped.
    const plan = buildIncludeMapFromSelection(instance, "Orphan", field.selectionSet, Task, info);
    expect(plan.things.target).toBe("Item");
  });

  it("keeps a relationship whose target adapter cannot be resolved", () => {
    const plan = planFor(`query { tasks { edges { node { unowned { id } } } } }`);
    expect(plan.unowned.target).toBe("Nowhere");
  });

  it("ignores arguments that fail to coerce rather than faulting the query", () => {
    const plan = planFor(`query { tasks { edges { node {
      orders(first: "not-an-int") { edges { node { id } } }
    } } } }`);
    expect(plan.orders).toEqual({
      target: "Order", associationType: "hasMany", required: false, separate: false,
    });
  });

  it("builds nothing when the type has no fields to read arguments from", () => {
    const {field, info} = parseQuery(`query { tasks { edges { node { owner(required: true) { id } } } } }`);
    const node = getChildSelectionSet(field.selectionSet, true, info);
    // A definition name can resolve to a scalar or enum, which has no `getFields`.
    const plan = buildIncludeMapFromSelection(instance, "Task", node, undefined, info);
    expect(plan.owner).toEqual({target: "User", associationType: "belongsTo", required: false});
  });
});

describe("separate-vs-JOIN policy", () => {
  it("folds an unpaginated hasMany into the parent query as a JOIN", () => {
    const plan = planFor(`query { tasks { edges { node { orders { edges { node { id } } } } } } }`);
    expect(plan.orders.separate).toBe(false);
    expect(plan.orders.limit).toBeUndefined();
  });

  it("goes separate when the relation is paginated, since a JOIN cannot express it", () => {
    const plan = planFor(`query { tasks { edges { node { orders(first: 5) { edges { node { id } } } } } } }`);
    expect(plan.orders.separate).toBe(true);
    expect(plan.orders.limit).toBe(5);
  });

  it("goes separate on request, and then bounds the per-parent fetch", () => {
    const plan = planFor(`query { tasks { edges { node { orders(separate: true) { edges { node { id } } } } } } }`);
    expect(plan.orders.separate).toBe(true);
    // No explicit page size, so the default applies: a separate fetch runs once
    // per parent, and unbounded it would pull the whole child table each time.
    expect(plan.orders.limit).toBe(100);
  });

  it("never marks a belongsTo separate — only hasMany supports it", () => {
    const plan = planFor(`query { tasks { edges { node { owner(first: 5) { id } } } } }`);
    expect(plan.owner.separate).toBeUndefined();
    expect(plan.owner.limit).toBeUndefined();
  });

  it("clamps an over-large nested page size", () => {
    // A nested `first` is written straight onto the descriptor and never passes
    // back through `processListArgsToOptions`, so this is the only clamp it gets.
    const plan = planFor(`query { tasks { edges { node { orders(first: 10000000) { edges { node { id } } } } } } }`);
    expect(plan.orders.limit).toBe(1000);
  });

  it("falls back to the default page size for a non-positive one", () => {
    const plan = planFor(`query { tasks { edges { node { orders(last: 0) { edges { node { id } } } } } } }`);
    expect(plan.orders.limit).toBe(100);
  });
});

describe("cursor arithmetic", () => {
  it("turns `after` into the offset of the following row", () => {
    const plan = planFor(`query { tasks { edges { node {
      orders(first: 5, after: "${toCursor("Order", 4)}") { edges { node { id } } }
    } } } }`);
    expect(plan.orders.offset).toBe(5);
  });

  it("walks `before` back by a page", () => {
    const plan = planFor(`query { tasks { edges { node {
      orders(last: 3, before: "${toCursor("Order", 9)}") { edges { node { id } } }
    } } } }`);
    expect(plan.orders.offset).toBe(7);
  });

  it("floors a `before` that would run off the front at zero", () => {
    const plan = planFor(`query { tasks { edges { node {
      orders(last: 5, before: "${toCursor("Order", 1)}") { edges { node { id } } }
    } } } }`);
    expect(plan.orders.offset).toBe(0);
  });

  it("treats a malformed cursor as index -1 rather than throwing", () => {
    // Cursors are client-supplied; a bad one must not fault the whole query.
    const plan = planFor(`query { tasks { edges { node {
      orders(first: 5, after: "not-a-cursor") { edges { node { id } } }
    } } } }`);
    expect(plan.orders.offset).toBe(0);
  });

  it("accepts a cursor an adapter has already decoded", () => {
    const plan = planFor(`query { tasks { edges { node {
      orders(first: 5, after: {index: 4}) { edges { node { id } } }
    } } } }`);
    expect(plan.orders.offset).toBe(5);
  });

  it("treats a decoded cursor with no usable index as index -1", () => {
    const plan = planFor(`query { tasks { edges { node {
      orders(first: 5, after: {index: "four"}) { edges { node { id } } }
    } } } }`);
    expect(plan.orders.offset).toBe(0);
  });

  it("leaves the offset unset when neither cursor is given", () => {
    const plan = planFor(`query { tasks { edges { node { orders(first: 5) { edges { node { id } } } } } } }`);
    expect(plan.orders.offset).toBeUndefined();
  });
});

describe("explicit include arguments", () => {
  it("merges a nested include argument with what the selection asked for", () => {
    const plan = planFor(`query { tasks { edges { node {
      orders(include: [{items: {target: "Item", associationType: "hasMany", required: true}}]) {
        edges { node { id } }
      }
    } } } }`);
    expect(plan.orders.include![0].items.required).toBe(true);
  });
});

describe("buildIncludeFromSelection", () => {
  it("returns undefined when nothing is includable", () => {
    const {field, info} = parseQuery(`query { tasks { edges { node { id name } } } }`);
    expect(buildIncludeFromSelection(instance, "Task", field, info)).toBeUndefined();
  });

  it("returns a single merged map, combining the AST with an explicit include", () => {
    const {field, info} = parseQuery(`query { tasks { edges { node { owner { id } } } } }`);
    const result = buildIncludeFromSelection(instance, "Task", field, info, [
      {orders: {target: "Order", associationType: "hasMany", required: true}},
    ]);
    expect(result).toHaveLength(1);
    expect(Object.keys(result![0])).toEqual(["owner", "orders"]);
  });
});
