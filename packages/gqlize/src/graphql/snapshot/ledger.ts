import { getNamedType, isIntrospectionType, isSpecifiedScalarType, type GraphQLNamedType, type GraphQLType } from "graphql";

import type { SchemaCache } from "../../types";

/**
 * Where a user-authored GraphQL type entered the schema.
 *
 * These types are never serialized: their coercion functions, nested resolvers
 * and thunks are code. Instead the ledger records *how* to find each one again
 * on the live ormize definitions, and the materializer re-runs the same
 * construction the builder did.
 */
export type ExternalTypeRef =
  | {
      via: "definitionOverride";
      defName: string;
      fieldName: string;
      use: "type" | "inputType";
      /** input types get a second, distinctly named variant for updates */
      forceOptional?: boolean;
    }
  | {
      via: "definitionExpose";
      defName: string;
      group: "classMethods" | "instanceMethods";
      target: "query" | "mutations";
      methodName: string;
      use: "type" | "arg";
      argName?: string;
    }
  | {
      /**
       * A type declared on `definition.whereOperatorTypes` — the adapters fold
       * these straight into the generated filter input, so the type reaches the
       * schema without passing any gqlize builder that could record it.
       */
      via: "definitionWhereOperator";
      defName: string;
      operator: string;
    }
  | {
      /** a type on `definition.define[field].args`, passed through verbatim */
      via: "definitionField";
      defName: string;
      fieldName: string;
      use: "arg";
      argName: string;
    };

/**
 * The non-type-system facts a build produces that the IR cannot re-derive from
 * the printed schema. Attached to the built `GraphQLSchema` via `extensions`.
 */
export interface GqlizeBuildLedger {
  formatVersion: number;
  /**
   * Exact input to `nodeTypeMapper.mapTypes` — recorded, not re-derived, and
   * pruned to the model types the schema publishes. A model the permissions left
   * unreachable is absent: the artifact carries no type for it, so recording the
   * name would make the artifact inconsistent at birth.
   */
  modelTypes: string[];
  externalTypes: Record<string, ExternalTypeRef>;
  /** extend keys that survived the build-time permission gate */
  extendFields: { query: string[]; mutation: string[] };
  /** scalar type name -> scalar-registry key; filled by the snapshotter */
  scalars: Record<string, string>;
}

export const LEDGER_FORMAT_VERSION = 2;

export function createLedger(): GqlizeBuildLedger {
  return {
    formatVersion: LEDGER_FORMAT_VERSION,
    modelTypes: [],
    externalTypes: {},
    extendFields: { query: [], mutation: [] },
    scalars: {},
  };
}

/**
 * The ledger rides on the schema cache — same per-build lifetime, and every
 * builder that can meet a user-supplied type already receives one.
 */
export function setLedger(schemaCache: SchemaCache, ledger: GqlizeBuildLedger) {
  schemaCache.ledger = ledger;
  return ledger;
}

export function getLedger(schemaCache: SchemaCache | undefined): GqlizeBuildLedger | undefined {
  return schemaCache?.ledger;
}

/**
 * Records a user-supplied type against the name it ended up with in the schema.
 * A no-op when no ledger is being collected, so the builders can call it
 * unconditionally. Returns `type` unchanged so it can wrap an assignment.
 *
 * List/non-null wrappers are stripped: only the named type needs re-deriving,
 * and the wrapper is carried by the field's serialized `TypeRef`. Specified
 * scalars and introspection types are skipped — the materializer seeds those
 * itself, and a user handing back `GraphQLString` says nothing about `String`.
 */
export function recordExternalType(
  schemaCache: SchemaCache,
  // Wrappers are accepted as well as named types: `getNamedType` below unwraps
  // them, and callers legitimately hand over a `GraphQLNonNull`/`GraphQLList`.
  type: GraphQLType | { name?: string } | undefined,
  ref: ExternalTypeRef,
) {
  const ledger = getLedger(schemaCache);
  if (!ledger || !type) {
    return type;
  }
  // A named type is what this ends up reading; the assertion is what lets the
  // guards below take it, and the `name` check is what makes it true — a plain
  // config object has no `name` graphql would recognise and falls through.
  let named = type as GraphQLNamedType;
  try {
    named = getNamedType(type as GraphQLType) ?? named;
  } catch {
    // not a GraphQL type instance (e.g. a plain config object) — use it as-is
  }
  const name = named?.name;
  if (name && !isSpecifiedScalarType(named) && !isIntrospectionType(named)) {
    ledger.externalTypes[name] = ref;
  }
  return type;
}
