import { getNamedType, isIntrospectionType, isSpecifiedScalarType, type GraphQLNamedType } from "graphql";

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
    };

/**
 * The non-type-system facts a build produces that the IR cannot re-derive from
 * the printed schema. Attached to the built `GraphQLSchema` via `extensions`.
 */
export interface GqlizeBuildLedger {
  formatVersion: number;
  /** exact input to `nodeTypeMapper.mapTypes` — recorded, not re-derived */
  modelTypes: string[];
  externalTypes: Record<string, ExternalTypeRef>;
  /** extend keys that survived the build-time permission gate */
  extendFields: { query: string[]; mutation: string[] };
  /** scalar type name -> scalar-registry key; filled by the snapshotter */
  scalars: Record<string, string>;
}

export const LEDGER_FORMAT_VERSION = 1;

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
 * builder that can meet a user-supplied type already receives one. `SchemaCache`
 * itself lives in the graphql-free `@azerothian/utilize`, hence the cast.
 */
export function setLedger(schemaCache: any, ledger: GqlizeBuildLedger) {
  schemaCache.ledger = ledger;
  return ledger;
}

export function getLedger(schemaCache: any): GqlizeBuildLedger | undefined {
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
  schemaCache: any,
  type: GraphQLNamedType | { name?: string } | undefined,
  ref: ExternalTypeRef,
) {
  const ledger = getLedger(schemaCache);
  if (!ledger || !type) {
    return type;
  }
  let named: any = type;
  try {
    named = getNamedType(type as any) ?? type;
  } catch {
    // not a GraphQL type instance (e.g. a plain config object) — use it as-is
  }
  const name = named?.name;
  if (name && !isSpecifiedScalarType(named) && !isIntrospectionType(named)) {
    ledger.externalTypes[name] = ref;
  }
  return type;
}
