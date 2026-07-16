import { getArgumentValues, GraphQLResolveInfo, GraphQLObjectType } from "graphql";
import GQLManager from "../../manager";
import { fromCursor } from "../objects/cursor";

// Bound per-parent eager-load page size. This mirrors the adapter's root-query
// backstop but is applied at the GraphQL layer, since a nested `first`/`last`
// is written straight onto the include descriptor and never passes back through
// `processListArgsToOptions`. Without it, `orders(first: 10000000)` on a nested
// connection is an unbounded per-parent fetch (DoS / amplification).
const DEFAULT_INCLUDE_PAGE_SIZE = 100;
const MAX_INCLUDE_PAGE_SIZE = 1000;
function clampIncludePageSize(value: any): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_INCLUDE_PAGE_SIZE;
  }
  return Math.min(n, MAX_INCLUDE_PAGE_SIZE);
}

/**
 * Descriptor for a single relationship that should be eager-loaded as part of the
 * parent's root query. Shape is a superset of what the sequelize adapter's
 * `processIncludeStatement` consumes (`required`, `where`, `orderBy`, `include`),
 * enriched with pagination + `separate` so collections can be batched at the root
 * with correct per-parent limits.
 */
export interface IncludeDescriptor {
  target: string;
  associationType: string;
  required?: boolean;
  where?: any;
  orderBy?: any;
  limit?: number;
  offset?: number;
  separate?: boolean;
  include?: IncludeMap[];
}
export interface IncludeMap {
  [relName: string]: IncludeDescriptor;
}

function isCollection(associationType: string) {
  return associationType === "hasMany" || associationType === "belongsToMany";
}

/**
 * Locate the selection set that holds a relationship field's actual sub-fields.
 * Collections are wrapped in a relay connection (`edges { node { … } }`); single
 * valued relations expose their sub-fields directly.
 */
export function getChildSelectionSet(fieldSelectionSet: any, collection: boolean, info: GraphQLResolveInfo): any {
  if (!fieldSelectionSet) {
    return undefined;
  }
  if (!collection) {
    return fieldSelectionSet;
  }
  const edges = findFieldSelectionSet(fieldSelectionSet, "edges", info);
  if (!edges) {
    return undefined;
  }
  return findFieldSelectionSet(edges, "node", info);
}

/**
 * True when a relay connection field selects its rows (`edges`). When it selects
 * only `total`/`pageInfo`, callers can skip the row fetch and run a count instead.
 * Fragment-aware; defaults to `true` (fetch rows) when the shape is unknown.
 */
export function isConnectionRowsSelected(fieldNode: any, info: GraphQLResolveInfo): boolean {
  if (!fieldNode || !fieldNode.selectionSet) {
    return true;
  }
  return flattenFieldNodes(fieldNode.selectionSet, info).some((f: any) => f.name.value === "edges");
}

// Memoizes the flattened field list per selection-set AST node. Node identity is
// unique per parsed document (and the document's fragments are fixed), so keying
// by the node is safe across requests; entries are GC'd with the document.
const flattenCache = new WeakMap<object, any[]>();

/**
 * Flatten a selection set into its effective Field nodes, expanding inline
 * fragments (`... on Type { … }`) and fragment spreads (`...FragmentName`)
 * recursively so relationships requested via fragments are still discovered.
 * GraphQL validation guarantees a fragment's type condition is compatible with
 * the position it appears in, so type conditions are simply followed through.
 */
export function flattenFieldNodes(selectionSet: any, info: GraphQLResolveInfo, seen?: Set<string>): any[] {
  if (!selectionSet || !Array.isArray(selectionSet.selections)) {
    return [];
  }
  // Only top-level calls (no active cycle-guard set) are cacheable; recursive
  // fragment-expansion calls carry `seen` and produce partial results.
  const cacheable = !seen;
  if (cacheable) {
    const cached = flattenCache.get(selectionSet);
    if (cached) {
      return cached;
    }
  }
  const visited = seen || new Set<string>();
  const fields: any[] = [];
  for (const sel of selectionSet.selections) {
    if (sel.kind === "Field") {
      fields.push(sel);
    } else if (sel.kind === "InlineFragment") {
      fields.push(...flattenFieldNodes(sel.selectionSet, info, visited));
    } else if (sel.kind === "FragmentSpread") {
      const name = sel.name && sel.name.value;
      if (!name || visited.has(name)) {
        continue; // guard against unknown / cyclic fragments
      }
      visited.add(name);
      const fragment = info.fragments && info.fragments[name];
      if (fragment) {
        fields.push(...flattenFieldNodes(fragment.selectionSet, info, visited));
      }
    }
  }
  if (cacheable) {
    flattenCache.set(selectionSet, fields);
  }
  return fields;
}

function findFieldSelectionSet(selectionSet: any, fieldName: string, info: GraphQLResolveInfo): any {
  for (const sel of flattenFieldNodes(selectionSet, info)) {
    if (sel.name.value === fieldName) {
      return sel.selectionSet;
    }
  }
  return undefined;
}

/**
 * Merge two include maps (by relation name, recursively). Used to combine the
 * selection-AST-derived tree with any explicit `include` argument so a parent
 * `include` and a nested `include` for the same section combine rather than
 * override.
 */
export function mergeIncludeMaps(a: IncludeMap = {}, b: IncludeMap = {}): IncludeMap {
  const out: IncludeMap = { ...a };
  for (const relName of Object.keys(b)) {
    if (!out[relName]) {
      out[relName] = b[relName];
      continue;
    }
    out[relName] = mergeIncludeDescriptors(out[relName], b[relName]);
  }
  return out;
}

function mergeWhere(a: any, b: any) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  // combine via the filter type's `and` array operator
  return { and: [a, b] };
}

function mergeIncludeDescriptors(a: IncludeDescriptor, b: IncludeDescriptor): IncludeDescriptor {
  const merged: IncludeDescriptor = {
    ...a,
    ...b,
    target: a.target || b.target,
    associationType: a.associationType || b.associationType,
    required: Boolean(a.required || b.required),
    separate: Boolean(a.separate || b.separate),
    where: mergeWhere(a.where, b.where),
    orderBy: b.orderBy || a.orderBy,
  };
  const childA = (a.include && a.include[0]) || undefined;
  const childB = (b.include && b.include[0]) || undefined;
  if (childA || childB) {
    merged.include = [mergeIncludeMaps(childA, childB)];
  }
  return merged;
}

/**
 * Normalise an explicit `include` argument (an array of relation-keyed objects)
 * into a single include map.
 */
export function normaliseExplicitInclude(include: any): IncludeMap {
  if (!Array.isArray(include)) {
    return {};
  }
  return include.reduce((map: IncludeMap, entry: any) => {
    return mergeIncludeMaps(map, entry as IncludeMap);
  }, {} as IncludeMap);
}

/**
 * Walk the GraphQL selection set for `defName` and build an include map for every
 * requested relationship whose target is on the SAME adapter as the parent
 * (cross-adapter relations are left for their own resolvers to fetch as separate
 * root queries).
 */
export function buildIncludeMapFromSelection(
  instance: GQLManager,
  defName: string,
  selectionSet: any,
  gqlType: GraphQLObjectType | undefined,
  info: GraphQLResolveInfo
): IncludeMap {
  const plan: IncludeMap = {};
  if (!selectionSet || !Array.isArray(selectionSet.selections)) {
    return plan;
  }
  const associations = instance.getAssociations(defName);
  const typeFields: any = gqlType && (gqlType as any).getFields ? (gqlType as any).getFields() : {};
  let parentAdapter: any;
  try {
    parentAdapter = instance.getModelAdapter(defName);
  } catch (e) {
    parentAdapter = undefined;
  }
  for (const sel of flattenFieldNodes(selectionSet, info)) {
    const relName = sel.name.value;
    const association = associations[relName];
    if (!association) {
      continue; // scalar / non-relationship field
    }
    let sameAdapter = true;
    try {
      sameAdapter = !parentAdapter || parentAdapter === instance.getModelAdapter(association.target);
    } catch (e) {
      sameAdapter = true;
    }
    if (!sameAdapter) {
      continue; // cross-adapter: resolved as its own root query elsewhere
    }
    const collection = isCollection(association.associationType);
    if (collection && !isConnectionRowsSelected(sel, info)) {
      // Only `total` (no `edges`/rows) requested — do not eager-load; the nested
      // resolver runs a count-only query (fires beforeCount/afterCount) instead.
      continue;
    }
    let fieldArgs: any = {};
    try {
      const fieldDef = typeFields[relName];
      if (fieldDef) {
        fieldArgs = getArgumentValues(fieldDef, sel, info.variableValues) || {};
      }
    } catch (e) {
      fieldArgs = {};
    }
    const childType = info.schema.getType(association.target) as GraphQLObjectType | undefined;
    const childSelectionSet = getChildSelectionSet(sel.selectionSet, collection, info);
    const nested = buildIncludeMapFromSelection(instance, association.target, childSelectionSet, childType, info);

    const descriptor: IncludeDescriptor = {
      target: association.target,
      associationType: association.associationType,
      required: fieldArgs.required === true,
    };
    if (fieldArgs.where) {
      descriptor.where = fieldArgs.where;
    }
    if (fieldArgs.orderBy) {
      descriptor.orderBy = fieldArgs.orderBy;
    }
    if (collection) {
      const paginated =
        fieldArgs.first != null || fieldArgs.last != null ||
        fieldArgs.after != null || fieldArgs.before != null;
      // Use `separate` (a batched root query) only when it is actually needed —
      // per-parent pagination, which a JOIN cannot express — or when explicitly
      // requested via the include arg. Otherwise the relation folds into the
      // parent query as a JOIN. Sequelize only supports `separate` on hasMany.
      descriptor.separate =
        association.associationType === "hasMany" &&
        (paginated || fieldArgs.separate === true);
      if (fieldArgs.first != null || fieldArgs.last != null) {
        descriptor.limit = clampIncludePageSize(fieldArgs.first != null ? fieldArgs.first : fieldArgs.last);
      } else if (descriptor.separate) {
        // Per-parent separate fetch with no explicit page size — bound it so a
        // nested connection can't pull an entire child table for each parent.
        descriptor.limit = DEFAULT_INCLUDE_PAGE_SIZE;
      }
      if (fieldArgs.after) {
        descriptor.offset = decodeCursorIndex(fieldArgs.after) + 1;
      } else if (fieldArgs.before) {
        let offset = decodeCursorIndex(fieldArgs.before) + 1;
        if (descriptor.limit != null) {
          offset -= descriptor.limit;
        }
        descriptor.offset = offset < 0 ? 0 : offset;
      }
    }
    let child = nested;
    if (fieldArgs.include) {
      child = mergeIncludeMaps(child, normaliseExplicitInclude(fieldArgs.include));
    }
    if (Object.keys(child).length > 0) {
      descriptor.include = [child];
    }
    plan[relName] = descriptor;
  }
  return plan;
}

function decodeCursorIndex(cursor: any): number {
  try {
    if (typeof cursor === "string") {
      return fromCursor(cursor).index;
    }
    if (cursor && typeof cursor.index === "number") {
      return cursor.index;
    }
  } catch (e) {
    // ignore malformed cursors
  }
  return -1;
}

/**
 * Entry point used by the manager: build the merged include map for a top-level
 * list field, combining the selection AST with an explicit `include` argument.
 * Returns an array with a single merged map (the shape `processIncludeStatement`
 * consumes), or `undefined` when there is nothing to include.
 */
export default function buildIncludeFromSelection(
  instance: GQLManager,
  defName: string,
  fieldNode: any,
  info: GraphQLResolveInfo,
  explicitInclude?: any
): IncludeMap[] | undefined {
  const gqlType = info.schema.getType(defName) as GraphQLObjectType | undefined;
  const nodeSelectionSet = getChildSelectionSet(fieldNode && fieldNode.selectionSet, true, info);
  let map = buildIncludeMapFromSelection(instance, defName, nodeSelectionSet, gqlType, info);
  if (explicitInclude) {
    map = mergeIncludeMaps(map, normaliseExplicitInclude(explicitInclude));
  }
  if (Object.keys(map).length === 0) {
    return undefined;
  }
  return [map];
}
