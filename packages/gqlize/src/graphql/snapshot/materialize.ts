import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLUnionType,
  parseConstValue,
  specifiedScalarTypes,
  type GraphQLFieldConfigMap,
  type GraphQLNamedType,
  type GraphQLScalarType,
} from "graphql";

import GqlizeBinding from "../../manager";
import type { GqlizeOptions, SchemaCache } from "../../types";
import { createSchema as buildSchema } from "../index";
import createSchemaCache from "../create-schema-cache";
import createNodeInterface from "../utils/create-node-interface";
import { applyExtendFields } from "../extend";
import { resolveExternalType } from "../external-types";
import { bindField, readBinding } from "../resolvers/bind";
import { GQLIZE_EXT, type BindingContext } from "../resolvers/types";
import {
  SNAPSHOT_FORMAT_VERSION,
  type FieldIR,
  type InputValueIR,
  type NamedTypeIR,
  type ObjectTypeIR,
  type SchemaSnapshot,
} from "./ir";
import { recordBuild } from "./build-registry";
import { compareFingerprints, fingerprintDefinitions } from "./fingerprint";
import { createScalarRegistry, unknownScalarError } from "./scalar-registry";
import { decodeTypeRef } from "./type-ref";

/**
 * `console.warn`, not the package's `debug`-based logger.
 *
 * These fire once at boot and every one of them means a safety check was skipped
 * or overridden. The `debug` logger is silent unless `DEBUG` is set, which would
 * make "loading an unchecked artifact" an invisible event — the exact thing this
 * mechanism exists to prevent.
 */
const log = {
  warn: (message: string) => console.warn(message), // eslint-disable-line no-console
};

export interface MaterializeOptions {
  /** must be the same map passed to `snapshotSchema` */
  scalars?: Record<string, GraphQLScalarType>;
  /** opaque id folded into the fingerprint; `options.permission` cannot be hashed */
  permissionProfile?: string;
  /**
   * What to do when the artifact does not match the live definitions.
   *
   * - `"throw"` (default) — refuse to load. The right production behaviour: a
   *   stale artifact serves a schema that disagrees with the database.
   * - `"rebuild"` — warn and fall back to a live `createSchema`. The right local
   *   default, so editing a model does not force a rebuild step mid-iteration.
   * - `"warn"` — log and load the artifact anyway. Escape hatch only.
   */
  onMismatch?: "throw" | "warn" | "rebuild";
  /**
   * Late-bound `extend` fields, called once every type exists so an extension
   * can reference a *materialized* type rather than a stale instance from
   * another build (which would collide on name at schema construction).
   */
  extendFactory?: (types: Record<string, GraphQLNamedType>) => {
    query?: GraphQLFieldConfigMap<any, any>;
    mutation?: GraphQLFieldConfigMap<any, any>;
  };
}

/**
 * Rebuild an executable `GraphQLSchema` from an artifact plus a live ormize
 * instance.
 *
 * This mirrors `createSchemaObjects` step for step, and every resolver goes
 * back on through the same `bindField` the live builder uses — so there is one
 * resolver implementation with two callers, not two implementations to drift.
 *
 * `options.extend` and `options.root` are *not* in the artifact: they are
 * arbitrary user configs with arbitrary resolvers, and the options object is
 * already present in the loading process. Pass them exactly as you would to
 * `createSchema`.
 */
export async function materializeSchema(
  snapshot: SchemaSnapshot,
  orm: any,
  options: GqlizeOptions & MaterializeOptions = {},
): Promise<GraphQLSchema> {
  const onMismatch = options.onMismatch || "throw";
  if (snapshot?.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    const message =
      `gqlize: snapshot formatVersion ${snapshot?.formatVersion} is not supported by this ` +
      `build (expected ${SNAPSHOT_FORMAT_VERSION}) — rebuild the artifact`;
    // A format the materializer cannot read is fatal under every mode but
    // "rebuild", which exists precisely to make a version bump a non-event.
    if (onMismatch !== "rebuild") {
      throw new Error(message);
    }
    log.warn(`${message}; rebuilding live`);
    return buildLiveSchema(orm, options);
  }
  const rebuilt = checkFingerprint(snapshot, orm, options, onMismatch);
  if (rebuilt) {
    return rebuilt;
  }
  const instance = new GqlizeBinding(orm) as any;
  const {extend = {}, root} = options;
  const ledger = snapshot.ledger;
  const registry = createScalarRegistry(options.scalars);
  const schemaCache: SchemaCache = createSchemaCache();
  const ctx: BindingContext = {instance, options};
  const {nodeInterface, nodeField, nodeTypeMapper} = createNodeInterface(instance, options);

  // Same adapter priming as the live build: its GraphQL type builders consult
  // the configured permission, and resolvers can reach them at request time.
  Object.keys(instance.getDefinitions() || {}).forEach((defName) => {
    const adapter: any = instance.getModelAdapter(defName);
    if (adapter && typeof adapter.setBuildPermission === "function") {
      adapter.setBuildPermission(options.permission);
    }
  });

  const typeMap = new Map<string, GraphQLNamedType>();
  for (const scalar of specifiedScalarTypes) {
    typeMap.set(scalar.name, scalar);
  }
  // The relay triple is always rebuilt live: the node interface's resolveType
  // and the id fetcher's per-request permission re-checks are closures.
  typeMap.set(nodeInterface.name, nodeInterface);
  for (const [name, ref] of Object.entries(ledger.externalTypes || {})) {
    typeMap.set(name, resolveExternalType(name, ref, instance, schemaCache));
  }

  const irByName = new Map<string, NamedTypeIR>(snapshot.types.map((t) => [t.name, t]));
  /** field configs per type, kept for the `$sql2gql` escape hatch */
  const configs = new Map<string, GraphQLFieldConfigMap<any, any>>();
  /** merged into the root types' field maps; filled before any thunk runs */
  const rootExtras = new Map<string, Record<string, any>>();

  function lookup(name: string): GraphQLNamedType | undefined {
    const found = typeMap.get(name);
    if (found) {
      return found;
    }
    const ir = irByName.get(name);
    if (!ir) {
      return undefined;
    }
    const built = construct(ir);
    typeMap.set(name, built);
    return built;
  }

  function construct(ir: NamedTypeIR): GraphQLNamedType {
    const description = ir.description;
    switch (ir.kind) {
      case "scalar": {
        const scalar = registry.get(ir.registryKey);
        if (!scalar) {
          throw unknownScalarError(ir.name, "materializeSchema");
        }
        return scalar;
      }
      case "enum":
        return new GraphQLEnumType({
          name: ir.name,
          description,
          values: Object.fromEntries(ir.values.map((v) => [v.name, {
            // absent means "same as the name"; `null` is a legitimate value, so
            // this is a presence test rather than a nullish fallback
            value: "value" in v ? v.value : v.name,
            description: v.description,
            deprecationReason: v.deprecationReason,
          }])),
        });
      case "union":
        return new GraphQLUnionType({
          name: ir.name,
          description,
          types: () => ir.types.map((n) => lookupOrThrow(n, ir.name)) as any,
        });
      case "input":
        return new GraphQLInputObjectType({
          name: ir.name,
          description,
          isOneOf: ir.isOneOf,
          fields: () => Object.fromEntries(
            ir.fields.map((f) => [f.name, inputValue(f, `${ir.name}.${f.name}`)]),
          ),
        });
      case "interface":
        return new GraphQLInterfaceType({
          name: ir.name,
          description,
          interfaces: () => (ir.interfaces || []).map((n) => lookupOrThrow(n, ir.name)) as any,
          fields: () => fieldMap(ir.name, ir.fields),
        });
      case "object":
        return new GraphQLObjectType({
          name: ir.name,
          description,
          interfaces: () => (ir.interfaces || []).map((n) => lookupOrThrow(n, ir.name)) as any,
          fields: () => fieldMap(ir.name, ir.fields),
        });
    }
  }

  function lookupOrThrow(name: string, referencedBy: string): GraphQLNamedType {
    const found = lookup(name);
    if (!found) {
      throw new Error(`gqlize: ${referencedBy} references unknown type "${name}"`);
    }
    return found;
  }

  function fieldMap(typeName: string, fields: FieldIR[]): GraphQLFieldConfigMap<any, any> {
    const out: GraphQLFieldConfigMap<any, any> = {};
    for (const field of fields) {
      const coordinate = `${typeName}.${field.name}`;
      let config: any = {
        type: decodeTypeRef(field.type, lookup, coordinate),
        description: field.description,
        deprecationReason: field.deprecationReason,
        ...(field.args
          ? {args: Object.fromEntries(field.args.map((a) =>
              [a.name, inputValue(a, `${coordinate}(${a.name}:)`)]))}
          : {}),
      };
      if (field.binding) {
        // The relay node field is the one field whose *config* is rebuilt rather
        // than decoded — its type, args and resolver all come off the live triple.
        if (field.binding.kind === "nodeField") {
          config = nodeField;
        }
        config = bindField(config, field.binding, ctx);
      }
      out[field.name] = config;
    }
    // extend fields are appended last, exactly as the live builder appends them
    Object.assign(out, rootExtras.get(typeName) || {});
    configs.set(typeName, out);
    return out;
  }

  function inputValue(iv: InputValueIR, coordinate: string) {
    return {
      type: decodeTypeRef(iv.type, lookup, coordinate) as any,
      description: iv.description,
      deprecationReason: iv.deprecationReason,
      ...(iv.defaultLiteral !== undefined
        ? {default: {literal: parseDefault(iv.defaultLiteral, coordinate)}}
        : {}),
    };
  }

  // Every type is constructed up front so `snapshot.types` order is honoured and
  // `extendFactory` sees a complete map. Field thunks stay lazy, so circular
  // references resolve without a second patching pass.
  for (const ir of snapshot.types) {
    if (!typeMap.has(ir.name)) {
      typeMap.set(ir.name, construct(ir));
    }
  }

  const factory = options.extendFactory?.(Object.fromEntries(typeMap)) || {};
  rootExtras.set(
    snapshot.query,
    await applyExtendFields({}, mergeExtend(extend?.query, factory.query), "query", options, ctx),
  );
  if (snapshot.mutation) {
    rootExtras.set(
      snapshot.mutation,
      await applyExtendFields({}, mergeExtend(extend?.mutation, factory.mutation), "mutation", options, ctx),
    );
  }

  // Reproduce `schemaCache.types` exactly — including the `${defName}[]` list
  // entries and the `undefined` holes left by permission-denied models. `node(id:)`
  // and `__resolveType` break silently if this key set differs.
  const modelTypes = rebuildModelTypes(ledger.modelTypes || [], typeMap);
  nodeTypeMapper.mapTypes(modelTypes);

  const rootSchema: any = {};
  rootSchema.query = lookupOrThrow(snapshot.query, "schema");
  if (snapshot.mutation) {
    rootSchema.mutation = lookupOrThrow(snapshot.mutation, "schema");
  }
  if (snapshot.description) {
    rootSchema.description = snapshot.description;
  }
  Object.assign(rootSchema, {...root});

  const schema = new GraphQLSchema({
    ...rootSchema,
    extensions: {
      ...(rootSchema.extensions || {}),
      [GQLIZE_EXT]: ledger,
    },
  });

  (schema as any).$sql2gql = {types: modelTypes};
  attachTypeHatches(snapshot, typeMap, configs);
  // Same bookkeeping the live builder does, so a materialized schema can be
  // re-snapshotted (round-trip tests, `gqlize check`) without losing its fingerprint.
  recordBuild(schema, instance, options);
  return schema;
}

/**
 * Compare the artifact's fingerprint against the live definitions.
 *
 * Returns a replacement schema when `onMismatch: "rebuild"` took over, and
 * `undefined` when materialization should proceed.
 */
function checkFingerprint(
  snapshot: SchemaSnapshot,
  orm: any,
  options: GqlizeOptions & MaterializeOptions,
  onMismatch: "throw" | "warn" | "rebuild",
): Promise<GraphQLSchema> | undefined {
  if (!snapshot.fingerprint) {
    // Not fatal — an artifact may deliberately be built without one — but it is
    // never silent, because "unchecked" reads exactly like "fresh" until it isn't.
    log.warn(
      "gqlize: artifact carries no fingerprint; loading it without a staleness check. Build it " +
        "with `snapshotSchema(schema)` on a schema from `createSchema` to get one.",
    );
    return undefined;
  }
  const live = fingerprintDefinitions(orm, {
    permissionProfile: options.permissionProfile,
    options,
  });
  const drift = compareFingerprints(snapshot.fingerprint, live);
  if (drift.length === 0) {
    return undefined;
  }
  const message =
    `gqlize: the schema artifact is stale — ${drift.join(", ")} ` +
    `${drift.length === 1 ? "differs" : "differ"} from the live definitions. Rebuild it` +
    (drift.includes("permissionProfile")
      ? ", or pass the `permissionProfile` the artifact was built with"
      : "") +
    ".";
  if (onMismatch === "throw") {
    throw new Error(message);
  }
  if (onMismatch === "rebuild") {
    log.warn(`${message} Rebuilding live.`);
    return buildLiveSchema(orm, options);
  }
  log.warn(`${message} Loading it anyway (onMismatch: "warn").`);
  return undefined;
}

function buildLiveSchema(orm: any, options: GqlizeOptions & MaterializeOptions) {
  return buildSchema(new GqlizeBinding(orm) as any, options);
}

function mergeExtend(a: any, b: any) {
  if (!a && !b) {
    return undefined;
  }
  return {...a, ...b};
}

function parseDefault(literal: string, coordinate: string) {
  try {
    return parseConstValue(literal);
  } catch (err: any) {
    throw new Error(
      `gqlize: default value for ${coordinate} (${JSON.stringify(literal)}) is not a valid ` +
        `GraphQL const literal: ${err.message}`,
    );
  }
}

function rebuildModelTypes(names: string[], typeMap: Map<string, GraphQLNamedType>) {
  const out: Record<string, any> = {};
  const wanted = new Set(names);
  for (const name of names) {
    if (name.endsWith("[]")) {
      const base = typeMap.get(name.slice(0, -2));
      if (!base) {
        throw new Error(
          `gqlize: the artifact lists relay model type "${name}" but "${name.slice(0, -2)}" is ` +
            "not in the schema — the artifact is inconsistent, rebuild it",
        );
      }
      out[name] = new GraphQLList(base);
    } else {
      const type = typeMap.get(name);
      // A permission-denied model leaves a real `undefined` hole in the live
      // cache, with no matching `[]` entry. Anything else is a genuine mismatch.
      if (!type && wanted.has(`${name}[]`)) {
        throw new Error(
          `gqlize: the artifact lists relay model type "${name}" but it is not in the schema — ` +
            "the artifact is inconsistent, rebuild it",
        );
      }
      out[name] = type;
    }
  }
  return out;
}

/**
 * Reattaches the per-type `$sql2gql` escape hatch. The live builder stores the
 * memoised partition thunks it happened to build from; here the same partition
 * is recovered from the binding kinds, which is what produced it in the first
 * place.
 */
function attachTypeHatches(
  snapshot: SchemaSnapshot,
  typeMap: Map<string, GraphQLNamedType>,
  configs: Map<string, GraphQLFieldConfigMap<any, any>>,
) {
  for (const ir of snapshot.types) {
    if (ir.kind !== "object" || !(ir as ObjectTypeIR).model) {
      continue;
    }
    const type = typeMap.get(ir.name) as any;
    if (!type) {
      continue;
    }
    const pick = (want: "basic" | "related" | "complex") => () => {
      const all = configs.get(ir.name) || {};
      const out: Record<string, any> = {};
      for (const [name, config] of Object.entries(all)) {
        const kind = readBinding(config as any)?.kind;
        const bucket = kind === "connection" || kind === "singleRelationship"
          ? "related"
          : kind === "instanceMethod"
            ? "complex"
            : "basic";
        if (bucket === want) {
          out[name] = config;
        }
      }
      return out;
    };
    type.$sql2gql = {
      basicFields: pick("basic"),
      relatedFields: pick("related"),
      complexFields: pick("complex"),
      fields: {},
    };
  }
}
