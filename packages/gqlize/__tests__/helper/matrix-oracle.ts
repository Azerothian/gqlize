/**
 * Pure-function oracle for the relationship matrix test.
 *
 * Given the in-memory seed graph and a chain of relationship traversals
 * (with per-level where/required/pagination options), computes the expected
 * GraphQL result so the test can compare against the real system.
 *
 * The semantics are gqlize's documented ones, not a model of any backend:
 * - `where` at a level filters that level's rows.
 * - `required` at a child level removes from the *parent* any row whose
 *   child set is empty after filtering (INNER JOIN semantics for singular,
 *   EXISTS for collections) — and only that parent: a row is removed further
 *   up only when every level in between is required too.
 * - For collections: `orderBy` sorts per-parent; `first` limits per-parent
 *   after filtering; `total` is the per-parent filtered count *before*
 *   pagination.
 * - For singular relations (belongsTo/hasOne): pagination/orderBy are ignored;
 *   the result is a single object or null.
 */

import type {SeedGraph, AlphaRow, BetaRow} from "./matrix-seed";

// ---- public types ----

export type RelName =
  | "toB" | "oneB" | "manyB" | "linkB"   // Alpha -> Beta
  | "toA" | "oneA" | "manyA" | "linkA";  // Beta -> Alpha

export type ChainLevel = {
  rel: RelName;
  where?: {name?: {in: string[]}};
  required?: boolean;
  first?: number;
  after?: number; // 0-based offset for simplicity; maps to cursor in test
  orderBy?: "rankASC" | "rankDESC" | "idASC" | "idDESC";
};

export type OracleOptions = {
  rootWhere?: {name?: {in: string[]}};
  rootOrderBy?: "idASC" | "idDESC";
  rootFirst?: number;
};

/**
 * A row in the oracle's result tree. Collections are arrays; singular
 * relations are a single item or null.
 */
export interface OracleNode {
  id: number;
  name: string;
  rank: number;
  /** For collection relations: {total, nodes} */
  [rel: string]: unknown;
}

export interface OracleCollectionResult {
  total: number;
  nodes: OracleNode[];
}

// ---- relationship metadata ----

type ModelName = "Alpha" | "Beta";

interface RelMeta {
  sourceModel: ModelName;
  targetModel: ModelName;
  kind: "belongsTo" | "hasOne" | "hasMany" | "belongsToMany";
}

const REL_META: Record<RelName, RelMeta> = {
  toB:   {sourceModel: "Alpha", targetModel: "Beta",  kind: "belongsTo"},
  oneB:  {sourceModel: "Alpha", targetModel: "Beta",  kind: "hasOne"},
  manyB: {sourceModel: "Alpha", targetModel: "Beta",  kind: "hasMany"},
  linkB: {sourceModel: "Alpha", targetModel: "Beta",  kind: "belongsToMany"},
  toA:   {sourceModel: "Beta",  targetModel: "Alpha", kind: "belongsTo"},
  oneA:  {sourceModel: "Beta",  targetModel: "Alpha", kind: "hasOne"},
  manyA: {sourceModel: "Beta",  targetModel: "Alpha", kind: "hasMany"},
  linkA: {sourceModel: "Beta",  targetModel: "Alpha", kind: "belongsToMany"},
};

export function isSingular(rel: RelName): boolean {
  const kind = REL_META[rel].kind;
  return kind === "belongsTo" || kind === "hasOne";
}

export function targetModel(rel: RelName): ModelName {
  return REL_META[rel].targetModel;
}

export function sourceModel(rel: RelName): ModelName {
  return REL_META[rel].sourceModel;
}

// ---- row lookup ----

type AnyRow = AlphaRow | BetaRow;

function getRelatedRows(graph: SeedGraph, source: AnyRow, rel: RelName): AnyRow[] {
  switch (rel) {
    // Alpha -> Beta
    case "toB": {
      const a = source as AlphaRow;
      if (a.betaId == null) return [];
      const b = graph.betas.find((r) => r.id === a.betaId);
      return b ? [b] : [];
    }
    case "oneB": {
      const a = source as AlphaRow;
      // Beta.oneAlphaId points back to Alpha
      const found = graph.betas.filter((r) => r.oneAlphaId === a.id);
      return found; // hasOne: 0 or 1
    }
    case "manyB": {
      const a = source as AlphaRow;
      return graph.betas.filter((r) => r.alphaId === a.id);
    }
    case "linkB": {
      const a = source as AlphaRow;
      const betaIds = graph.links.filter((l) => l.alphaId === a.id).map((l) => l.betaId);
      return graph.betas.filter((r) => betaIds.includes(r.id));
    }
    // Beta -> Alpha
    case "toA": {
      const b = source as BetaRow;
      if (b.alphaId == null) return [];
      const a = graph.alphas.find((r) => r.id === b.alphaId);
      return a ? [a] : [];
    }
    case "oneA": {
      const b = source as BetaRow;
      // Alpha.oneBetaId points back to Beta
      const found = graph.alphas.filter((r) => r.oneBetaId === b.id);
      return found; // hasOne: 0 or 1
    }
    case "manyA": {
      const b = source as BetaRow;
      return graph.alphas.filter((r) => r.betaId === b.id);
    }
    case "linkA": {
      const b = source as BetaRow;
      const alphaIds = graph.links.filter((l) => l.betaId === b.id).map((l) => l.alphaId);
      return graph.alphas.filter((r) => alphaIds.includes(r.id));
    }
    default:
      throw new Error(`unknown relation: ${rel as string}`);
  }
}

// ---- sorting ----

// ---- filtering ----

function applyWhere(rows: AnyRow[], where?: {name?: {in: string[]}}): AnyRow[] {
  if (!where?.name?.in) return rows;
  const names = new Set(where.name.in);
  return rows.filter((r) => names.has(r.name));
}

// ---- oracle core ----

/**
 * Compute the expected result for a chain of relationships starting from
 * a set of root rows.
 *
 * Returns an array of OracleNode trees.
 */
export function computeExpected(
  graph: SeedGraph,
  chain: ChainLevel[],
  options: OracleOptions = {},
): OracleNode[] {
  // Determine root model from chain[0]
  const rootModelName = chain.length > 0 ? sourceModel(chain[0].rel) : "Alpha";
  let rootRows: AnyRow[] = rootModelName === "Alpha" ? [...graph.alphas] : [...graph.betas];

  // Apply root where
  rootRows = applyWhere(rootRows, options.rootWhere);

  // Build tree recursively, then prune by required
  const result = buildLevel(graph, rootRows, chain, 0);

  // Sort roots
  const sorted = sortNodes(result, options.rootOrderBy || "idASC");

  // Apply root first
  if (options.rootFirst != null) {
    return sorted.slice(0, options.rootFirst);
  }
  return sorted;
}

/**
 * Compute the total count of root rows (after where + required filtering,
 * before pagination).
 */
export function computeRootTotal(
  graph: SeedGraph,
  chain: ChainLevel[],
  options: OracleOptions = {},
): number {
  const rootModelName = chain.length > 0 ? sourceModel(chain[0].rel) : "Alpha";
  let rootRows: AnyRow[] = rootModelName === "Alpha" ? [...graph.alphas] : [...graph.betas];
  rootRows = applyWhere(rootRows, options.rootWhere);

  // Build to get required-pruned set, then count before pagination
  const result = buildLevel(graph, rootRows, chain, 0);
  return result.length;
}

function buildLevel(
  graph: SeedGraph,
  parentRows: AnyRow[],
  chain: ChainLevel[],
  depth: number,
): OracleNode[] {
  if (depth >= chain.length) {
    // Leaf: just return nodes for each parent row
    return parentRows.map((r) => ({id: r.id, name: r.name, rank: r.rank}));
  }

  const level = chain[depth];
  const singular = isSingular(level.rel);
  const nodes: OracleNode[] = [];

  for (const parent of parentRows) {
    let related = getRelatedRows(graph, parent, level.rel);

    // Apply where at this level
    related = applyWhere(related, level.where);

    // `required` is local: this level, when required, removes the *parent*
    // row it hangs off when nothing survives here — and nothing above that.
    // A row at this level is itself removed (below) when a required level
    // beneath it has nothing left, which is how a deep `required` reaches up
    // exactly as far as the chain of `required` levels does.
    if (singular) {
      const child = related.length > 0 ? related[0] : null;
      const deeper = child !== null ? buildLevel(graph, [child], chain, depth + 1) : [];
      const childNode = deeper.length > 0 ? deeper[0] : null;
      if (level.required && childNode === null) {
        continue;
      }

      const node: OracleNode = {id: parent.id, name: parent.name, rank: parent.rank};
      node[level.rel] = childNode;
      nodes.push(node);
    } else {
      // Collection: nested `required` propagates up. With pagination
      // (`first` set) the collection uses a separate query and the
      // propagation stops.
      const childNodes = buildLevel(graph, related, chain, depth + 1);

      if (level.required && childNodes.length === 0) {
        continue;
      }

      // Sort children
      const sorted = sortNodes(childNodes, level.orderBy);

      // total is count before pagination
      const total = sorted.length;

      // Paginate
      let paginated = sorted;
      const offset = level.after ?? 0;
      if (offset > 0) {
        paginated = paginated.slice(offset);
      }
      if (level.first != null) {
        paginated = paginated.slice(0, level.first);
      }

      const node: OracleNode = {id: parent.id, name: parent.name, rank: parent.rank};
      node[level.rel] = {total, nodes: paginated};
      nodes.push(node);
    }
  }

  return nodes;
}



function sortNodes(nodes: OracleNode[], orderBy?: string): OracleNode[] {
  if (!orderBy) return nodes;
  const sorted = [...nodes];
  switch (orderBy) {
    case "idASC":   sorted.sort((a, b) => a.id - b.id); break;
    case "idDESC":  sorted.sort((a, b) => b.id - a.id); break;
    case "rankASC": sorted.sort((a, b) => a.rank - b.rank || a.id - b.id); break;
    case "rankDESC": sorted.sort((a, b) => b.rank - a.rank || a.id - b.id); break;
  }
  return sorted;
}
