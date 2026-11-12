/**
 * Relationship × depth × include × where test matrix.
 *
 * Generates all chains of length 1–3 over the four relationship types
 * (toB/oneB/manyB/linkB from Alpha, toA/oneA/manyA/linkA from Beta),
 * exercising each with multiple profiles (selection-only, where, required,
 * pagination, field args, etc.). The oracle computes the expected result
 * from the in-memory seed graph; the test runs the same query against
 * the real GraphQL layer and compares.
 *
 * Runs on sqlite, postgres (PGlite), and roundtrip projects.
 */

import {graphql, GraphQLSchema} from "graphql";
import {createInstance, resultData, validateResult} from "./helper";
import {createSchema} from "../src";
import {matrixDefs} from "./helper/models/matrix";
import {seedMatrix, SeedGraph} from "./helper/matrix-seed";
import {
  computeExpected,
  computeRootTotal,
  isSingular,
  targetModel,
  sourceModel,
  RelName,
  ChainLevel,
  OracleNode,
  OracleCollectionResult,
} from "./helper/matrix-oracle";
import {describe, it, expect, beforeAll} from "@jest/globals";

// ---- types ----

type Edge<T> = {node: T};

// ---- schema / instance ----

let schema: GraphQLSchema;
let graph: SeedGraph;

beforeAll(async () => {
  const instance = await createInstance(matrixDefs, {suite: true});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Ormize model bag is dynamically typed
  graph = await seedMatrix(instance.models as any);
  schema = await createSchema(instance);
}, 60000);

// ---- chain generation ----

const ALPHA_RELS: RelName[] = ["toB", "oneB", "manyB", "linkB"];
const BETA_RELS: RelName[] = ["toA", "oneA", "manyA", "linkA"];

function relsFor(model: "Alpha" | "Beta"): RelName[] {
  return model === "Alpha" ? ALPHA_RELS : BETA_RELS;
}

interface Chain {
  rels: RelName[];
  label: string;
}

function generateChains(maxDepth: number): Chain[] {
  const chains: Chain[] = [];

  function recurse(rels: RelName[], currentModel: "Alpha" | "Beta", depth: number) {
    if (depth > maxDepth) return;
    if (rels.length > 0) {
      chains.push({rels: [...rels], label: rels.join(" > ")});
    }
    if (depth < maxDepth) {
      for (const rel of relsFor(currentModel)) {
        const nextModel = targetModel(rel);
        // SQLite limitation: nested alias must not equal a model name case-insensitively.
        // Our aliases (toB, oneB, etc.) never collide with Alpha/Beta, so this is safe.
        rels.push(rel);
        recurse(rels, nextModel, depth + 1);
        rels.pop();
      }
    }
  }

  for (const rel of ALPHA_RELS) {
    recurse([rel], targetModel(rel), 1);
  }

  return chains;
}

const ALL_CHAINS = generateChains(3);

// ---- query builder ----

function buildSelectionFields(
  chain: ChainLevel[],
  depth: number,
  useFieldArgs: boolean,
): string {
  if (depth >= chain.length) {
    return "id name rank";
  }

  const level = chain[depth];
  const singular = isSingular(level.rel);
  const innerFields = buildSelectionFields(chain, depth + 1, useFieldArgs);

  if (singular) {
    // Singular relations: field args are `required: Boolean`
    const args: string[] = [];
    if (useFieldArgs && level.required) {
      args.push("required: true");
    }
    const argStr = args.length > 0 ? `(${args.join(", ")})` : "";
    return `id name rank ${level.rel}${argStr} { ${innerFields} }`;
  } else {
    // Collection relations: connection fields with where/required/first/orderBy
    const args: string[] = [];
    if (useFieldArgs) {
      if (level.required) args.push("required: true");
      if (level.where?.name?.in) {
        const names = level.where.name.in.map((n) => `"${n}"`).join(", ");
        args.push(`where: { name: { in: [${names}] } }`);
      }
      if (level.first != null) args.push(`first: ${level.first}`);
      if (level.orderBy) args.push(`orderBy: ${level.orderBy}`);
    }
    const argStr = args.length > 0 ? `(${args.join(", ")})` : "";
    return `id name rank ${level.rel}${argStr} { total edges { node { ${innerFields} } } }`;
  }
}

function buildIncludeArg(chain: ChainLevel[], depth: number): string | null {
  if (depth >= chain.length) return null;
  const level = chain[depth];
  const parts: string[] = [];

  if (level.required) parts.push("required: true");
  if (level.where?.name?.in) {
    const names = level.where.name.in.map((n) => `"${n}"`).join(", ");
    parts.push(`where: { name: { in: [${names}] } }`);
  }

  const nested = buildIncludeArg(chain, depth + 1);
  if (nested) {
    parts.push(`include: { ${nested} }`);
  }

  if (parts.length === 0 && !nested) return null;
  return `${level.rel}: { ${parts.join(", ")} }`;
}

function buildQuery(
  chain: ChainLevel[],
  opts: {
    rootOrderBy?: string;
    rootFirst?: number;
    useFieldArgs?: boolean;
    useIncludeArg?: boolean;
  } = {},
): string {
  const rootModel = sourceModel(chain[0].rel);
  const rootArgs: string[] = [];

  rootArgs.push(`orderBy: ${opts.rootOrderBy || "idASC"}`);
  if (opts.rootFirst != null) rootArgs.push(`first: ${opts.rootFirst}`);

  // Include arg at root level (for non-field-arg profiles)
  if (opts.useIncludeArg) {
    const includeStr = buildIncludeArg(chain, 0);
    if (includeStr) {
      rootArgs.push(`include: { ${includeStr} }`);
    }
  }

  const selection = buildSelectionFields(chain, 0, !!opts.useFieldArgs);
  const rootArgStr = rootArgs.length > 0 ? `(${rootArgs.join(", ")})` : "";

  return `query { models { ${rootModel}${rootArgStr} { total edges { node { ${selection} } } } } }`;
}

// ---- result normalizer ----

interface NormalizedNode {
  name: string;
  rank: number;
  [rel: string]: unknown;
}

interface NormalizedCollection {
  total: number;
  nodes: NormalizedNode[];
}

function normalizeOracleNode(node: OracleNode, chain: ChainLevel[], depth: number): NormalizedNode {
  const normalized: NormalizedNode = {name: node.name, rank: node.rank};

  if (depth < chain.length) {
    const rel = chain[depth].rel;
    const value = node[rel];

    if (isSingular(rel)) {
      if (value === null || value === undefined) {
        normalized[rel] = null;
      } else {
        normalized[rel] = normalizeOracleNode(value as OracleNode, chain, depth + 1);
      }
    } else {
      const coll = value as OracleCollectionResult;
      normalized[rel] = {
        total: coll.total,
        nodes: coll.nodes.map((n) => normalizeOracleNode(n, chain, depth + 1)),
      };
    }
  }

  return normalized;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- GraphQL result shapes are dynamic
function normalizeGqlNode(node: any, chain: ChainLevel[], depth: number): NormalizedNode {
  const normalized: NormalizedNode = {name: node.name, rank: node.rank};

  if (depth < chain.length) {
    const rel = chain[depth].rel;

    if (isSingular(rel)) {
      if (node[rel] === null || node[rel] === undefined) {
        normalized[rel] = null;
      } else {
        normalized[rel] = normalizeGqlNode(node[rel], chain, depth + 1);
      }
    } else {
      const conn = node[rel];
      normalized[rel] = {
        total: conn.total,
        nodes: (conn.edges || []).map((e: Edge<unknown>) =>
          normalizeGqlNode(e.node, chain, depth + 1)),
      };
    }
  }

  return normalized;
}

// ---- profile definitions ----

/**
 * Where filter names: pick a subset of existing rows so where actually filters
 * something out but still returns results.
 */
const ALPHA_WHERE_NAMES = ["a1", "a3", "a5", "a7"];
const BETA_WHERE_NAMES = ["b2", "b4", "b6", "b8"];

function whereNamesFor(model: "Alpha" | "Beta"): string[] {
  return model === "Alpha" ? ALPHA_WHERE_NAMES : BETA_WHERE_NAMES;
}

function hasCollection(chain: RelName[]): boolean {
  return chain.some((r) => !isSingular(r));
}

// ---- run helper ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- GraphQL result shape is generic
async function runQuery(query: string): Promise<any> {
  const result = await graphql({schema, source: query});
  validateResult(result);
  return resultData(result);
}

// ---- tests ----

describe("relationship matrix", () => {
  // Sanity check: verify chain count
  it("generates 84 chains (4 + 16 + 64)", () => {
    const depth1 = ALL_CHAINS.filter((c) => c.rels.length === 1).length;
    const depth2 = ALL_CHAINS.filter((c) => c.rels.length === 2).length;
    const depth3 = ALL_CHAINS.filter((c) => c.rels.length === 3).length;
    expect(depth1).toBe(4);
    expect(depth2).toBe(16);
    expect(depth3).toBe(64);
    expect(ALL_CHAINS.length).toBe(84);
  });

  // ---- P1: selection only (auto-include) ----
  describe("P1 selection only", () => {
    it.each(ALL_CHAINS.map((c) => [c.label, c.rels]))(
      "%s",
      async (label, rels) => {

        const chain: ChainLevel[] = (rels as RelName[]).map((r) => ({rel: r}));
        const query = buildQuery(chain);
        const data = await runQuery(query);

        const rootModel = sourceModel(chain[0].rel);
        const gqlRoot = data.models[rootModel];
        const gqlNodes = gqlRoot.edges.map((e: Edge<unknown>) =>
          normalizeGqlNode((e as Edge<Record<string, unknown>>).node, chain, 0));

        const expected = computeExpected(graph, chain);
        const expectedNodes = expected.map((n) => normalizeOracleNode(n, chain, 0));

        expect(sortCollection(gqlNodes, chain, 0)).toEqual(sortCollection(expectedNodes, chain, 0));
        expect(gqlRoot.total).toBe(computeRootTotal(graph, chain));
      },
    );
  });

  // ---- P2: leaf where via include arg ----
  describe("P2 leaf where", () => {
    it.each(ALL_CHAINS.map((c) => [c.label, c.rels]))(
      "%s",
      async (label, rels) => {

        const relArr = rels as RelName[];
        const leafModel = targetModel(relArr[relArr.length - 1]);
        const leafWhere = {name: {in: whereNamesFor(leafModel)}};

        const chain: ChainLevel[] = relArr.map((r, i) =>
          i === relArr.length - 1
            ? {rel: r, where: leafWhere}
            : {rel: r},
        );

        const query = buildQuery(chain, {useIncludeArg: true});
        const data = await runQuery(query);

        const rootModel = sourceModel(chain[0].rel);
        const gqlRoot = data.models[rootModel];
        const gqlNodes = gqlRoot.edges.map((e: Edge<unknown>) =>
          normalizeGqlNode((e as Edge<Record<string, unknown>>).node, chain, 0));

        const expected = computeExpected(graph, chain);
        const expectedNodes = expected.map((n) => normalizeOracleNode(n, chain, 0));

        expect(sortCollection(gqlNodes, chain, 0)).toEqual(sortCollection(expectedNodes, chain, 0));
      },
    );
  });

  // ---- P3: leaf required + where ----
  describe("P3 leaf required+where", () => {
    it.each(ALL_CHAINS.map((c) => [c.label, c.rels]))(
      "%s",
      async (label, rels) => {

        const relArr = rels as RelName[];
        const leafModel = targetModel(relArr[relArr.length - 1]);
        const leafWhere = {name: {in: whereNamesFor(leafModel)}};

        const chain: ChainLevel[] = relArr.map((r, i) =>
          i === relArr.length - 1
            ? {rel: r, where: leafWhere, required: true}
            : {rel: r},
        );

        const query = buildQuery(chain, {useIncludeArg: true});
        const data = await runQuery(query);

        const rootModel = sourceModel(chain[0].rel);
        const gqlRoot = data.models[rootModel];
        const gqlNodes = gqlRoot.edges.map((e: Edge<unknown>) =>
          normalizeGqlNode((e as Edge<Record<string, unknown>>).node, chain, 0));

        const expected = computeExpected(graph, chain);
        const expectedNodes = expected.map((n) => normalizeOracleNode(n, chain, 0));

        expect(sortCollection(gqlNodes, chain, 0)).toEqual(sortCollection(expectedNodes, chain, 0));
      },
    );
  });

  // ---- P4: required at every level + leaf where ----
  describe("P4 required everywhere", () => {
    it.each(ALL_CHAINS.map((c) => [c.label, c.rels]))(
      "%s",
      async (label, rels) => {

        const relArr = rels as RelName[];
        const leafModel = targetModel(relArr[relArr.length - 1]);
        const leafWhere = {name: {in: whereNamesFor(leafModel)}};

        const chain: ChainLevel[] = relArr.map((r, i) => ({
          rel: r,
          required: true,
          ...(i === relArr.length - 1 ? {where: leafWhere} : {}),
        }));

        const query = buildQuery(chain, {useIncludeArg: true});
        const data = await runQuery(query);

        const rootModel = sourceModel(chain[0].rel);
        const gqlRoot = data.models[rootModel];
        const gqlNodes = gqlRoot.edges.map((e: Edge<unknown>) =>
          normalizeGqlNode((e as Edge<Record<string, unknown>>).node, chain, 0));

        const expected = computeExpected(graph, chain);
        const expectedNodes = expected.map((n) => normalizeOracleNode(n, chain, 0));

        expect(sortCollection(gqlNodes, chain, 0)).toEqual(sortCollection(expectedNodes, chain, 0));
      },
    );
  });

  // ---- P5: where at every level, no required ----
  describe("P5 where everywhere", () => {
    it.each(ALL_CHAINS.map((c) => [c.label, c.rels]))(
      "%s",
      async (label, rels) => {

        const relArr = rels as RelName[];
        const chain: ChainLevel[] = relArr.map((r) => {
          const tm = targetModel(r);
          return {rel: r, where: {name: {in: whereNamesFor(tm)}}};
        });

        const query = buildQuery(chain, {useIncludeArg: true});
        const data = await runQuery(query);

        const rootModel = sourceModel(chain[0].rel);
        const gqlRoot = data.models[rootModel];
        const gqlNodes = gqlRoot.edges.map((e: Edge<unknown>) =>
          normalizeGqlNode((e as Edge<Record<string, unknown>>).node, chain, 0));

        const expected = computeExpected(graph, chain);
        const expectedNodes = expected.map((n) => normalizeOracleNode(n, chain, 0));

        expect(sortCollection(gqlNodes, chain, 0)).toEqual(sortCollection(expectedNodes, chain, 0));
      },
    );
  });

  // ---- P6: field args (required on single fields; required/where on collection fields) ----
  describe("P6 field args", () => {
    it.each(ALL_CHAINS.map((c) => [c.label, c.rels]))(
      "%s",
      async (label, rels) => {

        const relArr = rels as RelName[];

        // Singular fields accept only `required: Boolean`; where is not
        // available as a field arg on singular relations.
        const chain: ChainLevel[] = relArr.map((r, i) => {
          const singular = isSingular(r);
          const isLeaf = i === relArr.length - 1;
          if (singular) {
            return {rel: r, required: true};
          }
          const tm = targetModel(r);
          return {
            rel: r,
            required: true,
            ...(isLeaf ? {where: {name: {in: whereNamesFor(tm)}}} : {}),
          };
        });

        const query = buildQuery(chain, {useFieldArgs: true});
        const data = await runQuery(query);

        const rootModel = sourceModel(chain[0].rel);
        const gqlRoot = data.models[rootModel];
        const gqlNodes = gqlRoot.edges.map((e: Edge<unknown>) =>
          normalizeGqlNode((e as Edge<Record<string, unknown>>).node, chain, 0));

        const expected = computeExpected(graph, chain);
        const expectedNodes = expected.map((n) => normalizeOracleNode(n, chain, 0));

        expect(sortCollection(gqlNodes, chain, 0)).toEqual(sortCollection(expectedNodes, chain, 0));
      },
    );
  });

  // ---- P7: field args + overlapping include arg (where ANDed, required ORed) ----
  describe("P7 field+include overlap", () => {
    // Only test chains where the leaf is a collection (where on field args AND include)
    const collectionLeafChains = ALL_CHAINS.filter((c) => !isSingular(c.rels[c.rels.length - 1]));

    it.each(collectionLeafChains.map((c) => [c.label, c.rels]))(
      "%s",
      async (label, rels) => {

        const relArr = rels as RelName[];
        const leafModel = targetModel(relArr[relArr.length - 1]);
        const whereNames = whereNamesFor(leafModel);

        // Split the where names: half via field arg, half via include.
        // The system should AND them, meaning only names in BOTH sets match.
        // To make this meaningful, use the SAME set in both places.
        const chain: ChainLevel[] = relArr.map((r, i) => ({
          rel: r,
          required: true,
          ...(i === relArr.length - 1 ? {where: {name: {in: whereNames}}} : {}),
        }));

        // Build query with BOTH field args and include arg
        // The field args have where; the include also has where (same set).
        // GraphQL merges them: where is ANDed, required is ORed.
        // Since the same where is in both, the result should be the same as P4/P6.
        const query = buildQuery(chain, {useFieldArgs: true, useIncludeArg: true});
        const data = await runQuery(query);

        const rootModel = sourceModel(chain[0].rel);
        const gqlRoot = data.models[rootModel];
        const gqlNodes = gqlRoot.edges.map((e: Edge<unknown>) =>
          normalizeGqlNode((e as Edge<Record<string, unknown>>).node, chain, 0));

        const expected = computeExpected(graph, chain);
        const expectedNodes = expected.map((n) => normalizeOracleNode(n, chain, 0));

        expect(sortCollection(gqlNodes, chain, 0)).toEqual(sortCollection(expectedNodes, chain, 0));
      },
    );
  });

  // ---- P8: pagination on collections ----
  describe("P8 pagination", () => {
    const chainsWithCollection = ALL_CHAINS.filter((c) => hasCollection(c.rels));

    it.each(chainsWithCollection.map((c) => [c.label, c.rels]))(
      "%s",
      async (label, rels) => {

        const relArr = rels as RelName[];
        const chain: ChainLevel[] = relArr.map((r) => {
          if (!isSingular(r)) {
            return {
              rel: r,
              first: 2,
              orderBy: "rankASC" as const,
            };
          }
          return {rel: r};
        });

        const query = buildQuery(chain, {useFieldArgs: true});
        const data = await runQuery(query);

        const rootModel = sourceModel(chain[0].rel);
        const gqlRoot = data.models[rootModel];
        const gqlNodes = gqlRoot.edges.map((e: Edge<unknown>) =>
          normalizeGqlNode((e as Edge<Record<string, unknown>>).node, chain, 0));

        const expected = computeExpected(graph, chain);
        const expectedNodes = expected.map((n) => normalizeOracleNode(n, chain, 0));

        // For pagination, order matters so don't re-sort collections
        expect(gqlNodes).toEqual(expectedNodes);
        expect(gqlRoot.total).toBe(computeRootTotal(graph, chain));
      },
    );
  });
});

// ---- utility ----

/**
 * Sort nodes by name at every level for stable comparison. Recurses
 * through both singular and collection levels so that nested collections
 * under singular parents are also sorted.
 */
function sortCollection(
  nodes: NormalizedNode[],
  chain: ChainLevel[],
  depth: number,
): NormalizedNode[] {
  const sortByName = (a: NormalizedNode, b: NormalizedNode) => a.name.localeCompare(b.name);
  const sorted = [...nodes].sort(sortByName);

  if (depth < chain.length) {
    const rel = chain[depth].rel;
    if (!isSingular(rel)) {
      for (const n of sorted) {
        const coll = n[rel] as NormalizedCollection | null;
        if (coll) {
          coll.nodes = sortCollection(coll.nodes, chain, depth + 1);
        }
      }
    } else {
      // Singular: recurse through the child to sort any nested
      // collections deeper in the chain.
      if (depth + 1 < chain.length) {
        for (const n of sorted) {
          const child = n[rel] as NormalizedNode | null;
          if (child) {
            // Wrap in array to recurse, then unwrap
            const [sortedChild] = sortCollection([child], chain, depth + 1);
            n[rel] = sortedChild;
          }
        }
      }
    }
  }

  return sorted;
}
