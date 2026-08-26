import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isIntrospectionType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isSpecifiedScalarType,
  isUnionType,
  type GraphQLNamedType,
  type GraphQLSchema,
  type GraphQLType,
} from "graphql";

import { readBinding } from "../resolvers/bind";
import type { GqlizeBuildLedger } from "./ledger";

export interface Reachability {
  /** the types the IR must carry, in `getTypeMap()` insertion order */
  types: GraphQLNamedType[];
  /** rebuilt live by the materializer, so excluded from the IR */
  nodeInterfaceName?: string;
  /** re-derived from the live definitions, so excluded from the IR */
  externalNames: Set<string>;
}

/**
 * The relay node interface, found via the `nodeField` binding rather than by
 * hardcoding `"Node"` — graphql-relay owns that name, not us.
 */
export function findNodeInterfaceName(schema: GraphQLSchema): string | undefined {
  const query = schema.getQueryType();
  if (query) {
    for (const field of Object.values(query.getFields())) {
      if (readBinding(field)?.kind === "nodeField") {
        return getNamedType(field.type).name;
      }
    }
  }
  return schema.getType("Node")?.name;
}

/**
 * Which types belong in the artifact.
 *
 * Everything reachable from the roots, minus the four families that must *not*
 * be serialized:
 *
 * - specified scalars and introspection types — graphql seeds those itself;
 * - the node interface — its `resolveType` closes over a live `nodeTypeMapper`;
 * - external (user-authored) types — recorded in the ledger and re-derived from
 *   the live definitions, because their coercion functions and nested resolvers
 *   are code.
 *
 * The walk *stops* at those boundaries too: an external type's internals are
 * the user's, and re-deriving the root re-derives the closure with it.
 *
 * `extend` fields are skipped: they are arbitrary user configs supplied to
 * `createSchema`, and are merged again at load from the same options object.
 * This makes the walk's reach narrower than `schema.getTypeMap()` — a type only
 * an extend field refers to is in the map but not in the artifact — which is why
 * the snapshotter prunes `ledger.modelTypes` against the result of this walk
 * rather than against the type map.
 *
 * The walk runs off an explicit stack rather than recursing. A schema whose
 * models chain model-to-model a few hundred deep is one `createSchema` builds
 * without complaint, and the recursive form used to overflow the call stack
 * on it — so the artifact could not be built for a schema that otherwise works.
 */
export function collectSnapshotTypes(
  schema: GraphQLSchema,
  ledger: GqlizeBuildLedger,
): Reachability {
  const nodeInterfaceName = findNodeInterfaceName(schema);
  const externalNames = new Set(Object.keys(ledger.externalTypes || {}));
  const seen = new Set<string>();
  /** types claimed but not yet descended into */
  const pending: GraphQLNamedType[] = [];

  const isBoundary = (type: GraphQLNamedType) =>
    isIntrospectionType(type) ||
    (isScalarType(type) && isSpecifiedScalarType(type)) ||
    type.name === nodeInterfaceName ||
    externalNames.has(type.name);

  /** claim a type the first time it is reached, and queue it for descent */
  function visit(type: GraphQLType, queue: GraphQLNamedType[]) {
    const named = getNamedType(type);
    if (seen.has(named.name) || isBoundary(named)) {
      return;
    }
    seen.add(named.name);
    queue.push(named);
  }

  function descend(type: GraphQLNamedType) {
    const queue: GraphQLNamedType[] = [];
    if (isObjectType(type) || isInterfaceType(type)) {
      for (const iface of type.getInterfaces()) {
        visit(iface, queue);
      }
      for (const field of Object.values(type.getFields())) {
        if (readBinding(field)?.kind === "extend") {
          continue;
        }
        visit(field.type, queue);
        for (const arg of field.args || []) {
          visit(arg.type, queue);
        }
      }
    } else if (isUnionType(type)) {
      for (const member of type.getTypes()) {
        visit(member, queue);
      }
    } else if (isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        visit(field.type, queue);
      }
    } else if (isEnumType(type) || isScalarType(type)) {
      // leaf
    }
    // pushed in reverse so that popping walks the children left to right, the
    // order the recursive form had
    for (let i = queue.length - 1; i >= 0; i--) {
      pending.push(queue[i]);
    }
  }

  // Roots are visited unconditionally — they are never boundaries.
  for (const root of [schema.getQueryType(), schema.getMutationType()]) {
    if (root && !seen.has(root.name)) {
      seen.add(root.name);
      pending.push(root);
    }
  }
  while (pending.length > 0) {
    descend(pending.pop() as GraphQLNamedType);
  }

  const types = Object.values(schema.getTypeMap()).filter((t) => seen.has(t.name));
  return { types, nodeInterfaceName, externalNames };
}
