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
      if (readBinding(field as any)?.kind === "nodeField") {
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
 */
export function collectSnapshotTypes(
  schema: GraphQLSchema,
  ledger: GqlizeBuildLedger,
): Reachability {
  const nodeInterfaceName = findNodeInterfaceName(schema);
  const externalNames = new Set(Object.keys(ledger.externalTypes || {}));
  const seen = new Set<string>();

  const isBoundary = (type: GraphQLNamedType) =>
    isIntrospectionType(type) ||
    (isScalarType(type) && isSpecifiedScalarType(type)) ||
    type.name === nodeInterfaceName ||
    externalNames.has(type.name);

  function visitType(type: GraphQLType) {
    visit(getNamedType(type));
  }

  function visit(type: GraphQLNamedType) {
    if (seen.has(type.name) || isBoundary(type)) {
      return;
    }
    seen.add(type.name);
    descend(type);
  }

  function descend(type: GraphQLNamedType) {
    if (isObjectType(type) || isInterfaceType(type)) {
      for (const iface of type.getInterfaces()) {
        visit(iface);
      }
      for (const field of Object.values(type.getFields())) {
        if (readBinding(field as any)?.kind === "extend") {
          continue;
        }
        visitType(field.type);
        for (const arg of field.args || []) {
          visitType(arg.type);
        }
      }
    } else if (isUnionType(type)) {
      for (const member of type.getTypes()) {
        visit(member);
      }
    } else if (isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        visitType(field.type);
      }
    } else if (isEnumType(type) || isScalarType(type)) {
      // leaf
    }
  }

  // Roots are visited unconditionally — they are never boundaries.
  for (const root of [schema.getQueryType(), schema.getMutationType()]) {
    if (root && !seen.has(root.name)) {
      seen.add(root.name);
      descend(root);
    }
  }

  const types = Object.values(schema.getTypeMap()).filter((t) => seen.has(t.name));
  return { types, nodeInterfaceName, externalNames };
}
