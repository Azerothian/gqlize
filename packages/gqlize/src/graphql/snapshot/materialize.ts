import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLUnionType,
  isInterfaceType,
  isObjectType,
  parseConstValue,
  specifiedScalarTypes,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLScalarType,
  type GraphQLSchemaConfig,
  type GraphQLType,
} from "graphql";

import GqlizeBinding from "../../manager";
import type { Ormize } from "@azerothian/ormize";
import type {
  GqlizeAdapter,
  GqlizeOptions,
  IORBase,
  ModelTypeHatch,
  SchemaCache,
  SchemaHatch,
} from "../../types";
import { createSchema as buildSchema, warnUnknownPermissionKeys } from "../index";
import createSchemaCache from "../create-schema-cache";
import createNodeInterface from "../utils/create-node-interface";
import { applyExtendFields } from "../extend";
import { describeRef, resolveExternalType } from "../external-types";
import { enrichDuplicateTypeError } from "../utils/duplicate-types";
import { collectLiveTypes, collectLiveTypesFromFields, type LiveType } from "./live-types";
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
import type { GqlizeBuildLedger } from "./ledger";
import { compareFingerprints, describeDrift, fingerprintDefinitions } from "./fingerprint";
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
  /** the same, for `options.id` / `options.cursor` — codecs are closures too */
  idProfile?: string;
  cursorProfile?: string;
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
   * Whether to compare the artifact against the live definitions at load.
   * Defaults to `true`, and leaving it there is the right answer for almost
   * everyone: it is what makes `onMismatch` mean anything.
   *
   * Set it to `false` only where something else already guarantees the pair
   * agree — CI ran `gqlize check --strict` against the same commit, and the
   * artifact ships with the code that built it. The check re-walks every
   * definition through the adapter on every boot, which is ~79ms on a
   * 1,000-model schema; skipping it is the one meaningful load-time saving on
   * offer, and it is a trade, not a free win. It warns on the way past.
   */
  checkStaleness?: boolean;
  /**
   * Late-bound `extend` fields, called once every type exists so an extension
   * can reference a *materialized* type rather than a stale instance from
   * another build (which would collide on name at schema construction).
   */
  extendFactory?: (types: Record<string, GraphQLNamedType>) => {
    query?: GraphQLFieldConfigMap<any, any>;
    mutation?: GraphQLFieldConfigMap<any, any>;
    /**
     * Extra `GraphQLSchema` config — `subscription`, `types`. Same reason as the
     * field maps: a subscription root that references this schema's model types
     * has to be built after they exist, and `options.root` is evaluated before.
     */
    root?: Partial<GraphQLSchemaConfig>;
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
  orm: Ormize<any, IORBase>,
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
  // Below the rebuild branch on purpose: that path warns for itself via
  // `createSchemaObjects`.
  warnUnknownPermissionKeys(options);
  if (options.checkStaleness === false) {
    // Never silent, for the same reason a missing fingerprint is not: an
    // unchecked load reads exactly like a fresh one until it doesn't.
    log.warn(
      "gqlize: checkStaleness is false; loading the artifact without comparing it to the live " +
        "definitions. Nothing at runtime will tell you the two disagree — run `gqlize check " +
        "--strict` against the same commit instead.",
    );
  } else {
    const rebuilt = checkFingerprint(snapshot, orm, options, onMismatch);
    if (rebuilt) {
      return rebuilt;
    }
  }
  const instance = new GqlizeBinding(orm, options);
  const {extend = {}, root} = options;
  const ledger = snapshot.ledger;
  const registry = createScalarRegistry(options.scalars);
  const schemaCache: SchemaCache = createSchemaCache();
  const ctx: BindingContext = {instance, options};
  const {nodeInterface, nodeField, nodeTypeMapper} = createNodeInterface(instance, options);

  // Same adapter priming as the live build: its GraphQL type builders consult
  // the configured permission, and resolvers can reach them at request time.
  Object.keys(instance.getDefinitions() || {}).forEach((defName) => {
    const adapter: GqlizeAdapter | undefined = instance.getModelAdapter(defName);
    adapter?.setBuildPermission?.(options.permission);
  });

  const typeMap = new Map<string, GraphQLNamedType>();
  for (const scalar of specifiedScalarTypes) {
    typeMap.set(scalar.name, scalar);
  }
  // The relay triple is always rebuilt live: the node interface's resolveType
  // and the id fetcher's per-request permission re-checks are closures.
  typeMap.set(nodeInterface.name, nodeInterface);

  // Types gqlize builds itself. A live type may *reference* one of them, but its
  // closure past that point belongs to the artifact — claiming it would leave
  // the IR with nothing to build the model from.
  const artifactOwned = new Set<string>([
    ...(ledger.modelTypes || []).map((name) => (name.endsWith("[]") ? name.slice(0, -2) : name)),
    snapshot.query,
    ...(snapshot.mutation ? [snapshot.mutation] : []),
  ]);
  const skip = (name: string) => artifactOwned.has(name) || name === nodeInterface.name;

  /**
   * Every live type, and the *whole closure under each one*.
   *
   * The ledger records the type sitting directly in an `override` / `expose` /
   * `whereOperatorTypes` slot, but a user type nested inside one of those is
   * just as much the user's — and if it is also reachable through a serialized
   * path it is in the IR too. Seeding the closure here means the IR clone is
   * never constructed and both positions resolve to the one live instance.
   */
  const liveTypes = new Map<string, LiveType>();
  for (const [name, ref] of Object.entries(ledger.externalTypes || {})) {
    const resolved = resolveExternalType(name, ref, instance, schemaCache);
    if (!liveTypes.has(name)) {
      liveTypes.set(name, {type: resolved, origin: `${describeRef(ref)}`});
    }
    collectLiveTypes(resolved, describeRef(ref), liveTypes, {skip});
  }
  // `extend` and `root` are supplied by the loading process, resolvers and all.
  // They are never in the artifact, but the types inside them can be.
  collectLiveTypesFromFields(extend?.query, "options.extend.query", liveTypes, {skip});
  collectLiveTypesFromFields(extend?.mutation, "options.extend.mutation", liveTypes, {skip});
  for (const [slot, value] of Object.entries(root || {})) {
    collectLiveTypes(value, `options.root.${slot}`, liveTypes, {skip});
  }
  for (const [name, live] of liveTypes) {
    if (!typeMap.has(name)) {
      typeMap.set(name, live.type);
    }
  }

  const irByName = new Map<string, NamedTypeIR>(snapshot.types.map((t) => [t.name, t]));
  /** field configs per type, kept for the `$sql2gql` escape hatch */
  const configs = new Map<string, GraphQLFieldConfigMap<any, any>>();
  /** merged into the root types' field maps; filled before any thunk runs */
  const rootExtras = new Map<string, GraphQLFieldConfigMap<any, any>>();

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

  /**
   * `decodeTypeRef` runs graphql's `parseType` over the SDL ref and allocates a
   * fresh list/non-null wrapper chain every call, and the same few thousand ref
   * strings recur across every field and argument in the schema — on a
   * 1,000-model artifact that is ~372k parses of ~32k distinct strings.
   *
   * Per materialize call, deliberately. Type identity is per materialization: a
   * module-level cache would hand one schema's instances to the next, which is
   * precisely the duplicate-name failure this loader has to avoid. Within a
   * single call it is sound — `lookup` already memoises into `typeMap`, so a ref
   * always decodes to the same named type, and the `GraphQLList` /
   * `GraphQLNonNull` wrappers around it are immutable and compared structurally.
   *
   * `coordinate` only ever appears in the failure message, and a failed decode
   * caches nothing, so reusing the first caller's coordinate costs nothing.
   */
  const refCache = new Map<string, GraphQLType>();
  function decodeRef(ref: string, coordinate: string): GraphQLType {
    const cached = refCache.get(ref);
    if (cached) {
      return cached;
    }
    const decoded = decodeTypeRef(ref, lookup, coordinate);
    refCache.set(ref, decoded);
    return decoded;
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
          types: () => ir.types.map((n) => lookupObjectType(n, ir.name)),
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
          interfaces: () => (ir.interfaces || []).map((n) => lookupInterfaceType(n, ir.name)),
          fields: () => fieldMap(ir.name, ir.fields),
        });
      case "object":
        return new GraphQLObjectType({
          name: ir.name,
          description,
          interfaces: () => (ir.interfaces || []).map((n) => lookupInterfaceType(n, ir.name)),
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

  /**
   * A union member and an implemented interface each have to be of a particular
   * kind, and the IR carries only the name. Checked here rather than left to
   * `new GraphQLSchema`, whose complaint names neither the referring type nor
   * the artifact it came out of.
   */
  function lookupObjectType(name: string, referencedBy: string): GraphQLObjectType {
    const found = lookupOrThrow(name, referencedBy);
    if (!isObjectType(found)) {
      throw new Error(
        `gqlize: union ${referencedBy} lists "${name}" as a member, but it is not an object ` +
          "type — the artifact is inconsistent, rebuild it",
      );
    }
    return found;
  }

  function lookupInterfaceType(name: string, referencedBy: string): GraphQLInterfaceType {
    const found = lookupOrThrow(name, referencedBy);
    if (!isInterfaceType(found)) {
      throw new Error(
        `gqlize: ${referencedBy} implements "${name}", but it is not an interface type — the ` +
          "artifact is inconsistent, rebuild it",
      );
    }
    return found;
  }

  function fieldMap(typeName: string, fields: FieldIR[]): GraphQLFieldConfigMap<any, any> {
    const out: GraphQLFieldConfigMap<any, any> = {};
    for (const field of fields) {
      const coordinate = `${typeName}.${field.name}`;
      let config: GraphQLFieldConfig<any, any> = {
        // `decodeRef` answers with a `GraphQLType`: the ref is SDL, and SDL does
        // not distinguish input from output. What guarantees this one is an
        // output type is the schema the artifact was printed from.
        type: decodeRef(field.type, coordinate) as GraphQLOutputType,
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
      // An output/input type as above — an argument or input field position
      // only ever held an input type in the schema this was printed from.
      type: decodeRef(iv.type, coordinate) as GraphQLInputType,
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
  const extendQuery = mergeExtend(extend?.query, factory.query);
  const extendMutation = mergeExtend(extend?.mutation, factory.mutation);
  requireExtendFields(ledger, {query: extendQuery, mutation: extendMutation});
  rootExtras.set(snapshot.query, await applyExtendFields({}, extendQuery, "query", options, ctx));
  if (snapshot.mutation) {
    rootExtras.set(
      snapshot.mutation,
      await applyExtendFields({}, extendMutation, "mutation", options, ctx),
    );
  }

  // Reproduce `schemaCache.types` exactly — including the `${defName}[]` list
  // entries and the `undefined` holes left by permission-denied models. `node(id:)`
  // and `__resolveType` break silently if this key set differs.
  const modelTypes = rebuildModelTypes(ledger.modelTypes || [], typeMap);
  nodeTypeMapper.mapTypes(modelTypes);

  const rootSchema: GraphQLSchemaConfig = {};
  rootSchema.query = lookupObjectType(snapshot.query, "schema");
  if (snapshot.mutation) {
    rootSchema.mutation = lookupObjectType(snapshot.mutation, "schema");
  }
  if (snapshot.description) {
    rootSchema.description = snapshot.description;
  }
  // `factory.root` last: a root slot built against the materialized type map is
  // the only way a subscription root can share this schema's model types.
  Object.assign(rootSchema, {...root, ...factory.root});

  const schemaConfig = {
    ...rootSchema,
    extensions: {
      ...(rootSchema.extensions || {}),
      [GQLIZE_EXT]: ledger,
    },
  };
  let schema: GraphQLSchema;
  try {
    schema = new GraphQLSchema(schemaConfig);
  } catch (err) {
    throw enrichDuplicateTypeError(
      err,
      schemaConfig,
      new Map([...liveTypes].map(([name, live]) => [name, live.origin])),
      "A type the artifact defines cannot also be handed in through `options.extend` or " +
        "`options.root`: build it with `extendFactory(types)` instead, which runs once every " +
        "artifact type exists — or rebuild the artifact if the type moved into the definitions.",
    );
  }

  (schema as GraphQLSchema & {$sql2gql?: SchemaHatch}).$sql2gql = {types: modelTypes};
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
  orm: Ormize<any, IORBase>,
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
  // The loading process builds its own options object, and a profile is an
  // opaque label rather than something derivable from it — a caller who does not
  // name one is not claiming the profile changed. Carrying the artifact's value
  // forward keeps that from reading as staleness on every load; naming a
  // *different* one still reports drift.
  //
  // The id and cursor profiles behave identically, and the presence/absence of
  // the codecs themselves is caught by `optionsShape` regardless — so an
  // artifact built with codecs and loaded without them is drift even when no
  // profile was ever named.
  const carried = (key: "permissionProfile" | "idProfile" | "cursorProfile") =>
    options[key] ?? snapshot.fingerprint![key] ?? undefined;
  const unchecked = (["permissionProfile", "idProfile", "cursorProfile"] as const)
    .filter((key) => options[key] === undefined && snapshot.fingerprint![key] != null);
  const live = fingerprintDefinitions(orm, {
    permissionProfile: carried("permissionProfile"),
    idProfile: carried("idProfile"),
    cursorProfile: carried("cursorProfile"),
    options,
  });
  const drift = compareFingerprints(snapshot.fingerprint, live);
  if (drift.length === 0) {
    for (const key of unchecked) {
      log.warn(
        `gqlize: the artifact was built with ${key} ` +
          `"${snapshot.fingerprint[key]}" and none was supplied at load — that drift is not being ` +
          `checked. Pass \`${key}\` to check it, or \`gqlize check --strict\` to diff the schema itself.`,
      );
    }
    return undefined;
  }
  const message =
    `gqlize: the schema artifact is stale — ${describeDrift(drift, snapshot.fingerprint, live)} ` +
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

function buildLiveSchema(orm: Ormize<any, IORBase>, options: GqlizeOptions & MaterializeOptions) {
  return buildSchema(new GqlizeBinding(orm, options), options);
}

/**
 * `extend` fields are never serialized — they are arbitrary user configs with
 * arbitrary resolvers, supplied again at load. Which means forgetting to pass
 * them produces a schema that is quietly missing root fields, and the failure
 * only surfaces later as "Cannot query field" against a schema that looks fine.
 *
 * The build recorded which keys survived its permission gate, so the loader can
 * say so up front.
 */
function requireExtendFields(
  ledger: GqlizeBuildLedger,
  extend: {query?: GraphQLFieldConfigMap<any, any>; mutation?: GraphQLFieldConfigMap<any, any>},
) {
  const missing: string[] = [];
  for (const target of ["query", "mutation"] as const) {
    for (const key of ledger?.extendFields?.[target] || []) {
      if (!extend?.[target] || !(key in extend[target])) {
        missing.push(`extend.${target}.${key}`);
      }
    }
  }
  if (missing.length === 0) {
    return;
  }
  const supplied = (["query", "mutation"] as const)
    .flatMap((target) => Object.keys(extend?.[target] || {}).map((key) => `extend.${target}.${key}`));
  throw new Error(
    `gqlize: the artifact was built with ${missing.join(", ")}, which the load-time options do ` +
      `not supply (${supplied.length ? `got ${supplied.join(", ")}` : "no extend fields were passed"}). ` +
      "`extend` fields carry live resolvers and are never serialized — pass the same `extend` to " +
      "`loadSchema`/`materializeSchema` as you passed to `createSchema`, or supply them from " +
      "`extendFactory`.",
  );
}

function mergeExtend(
  a: GraphQLFieldConfigMap<any, any> | undefined,
  b: GraphQLFieldConfigMap<any, any> | undefined,
) {
  if (!a && !b) {
    return undefined;
  }
  return {...a, ...b};
}

function parseDefault(literal: string, coordinate: string) {
  try {
    return parseConstValue(literal);
  } catch (err) {
    throw new Error(
      `gqlize: default value for ${coordinate} (${JSON.stringify(literal)}) is not a valid ` +
        `GraphQL const literal: ${err instanceof Error ? err.message : String(err)}`,
      {cause: err},
    );
  }
}

function rebuildModelTypes(names: string[], typeMap: Map<string, GraphQLNamedType>): SchemaHatch["types"] {
  const out: SchemaHatch["types"] = {};
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
      // Every model type the build recorded is in the artifact, including the
      // ones no root field reaches — `reachability` seeds them deliberately. A
      // permission-denied model leaves no entry here at all rather than an
      // `undefined` hole: `createModelTypes` returns the accumulator untouched
      // before anything can write one. So a name with nothing behind it is
      // corruption, and admitting it would only defer the failure by one line,
      // to `nodeTypeMapper.mapTypes`, as an opaque TypeError.
      if (!type) {
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
    if (ir.kind !== "object" || !(ir as ObjectTypeIR).model) { // eslint-disable-line @typescript-eslint/no-unnecessary-type-assertion -- ts7 needs it
      continue;
    }
    const type = typeMap.get(ir.name);
    if (!type) {
      continue;
    }
    const pick = (want: "basic" | "related" | "complex") => () => {
      const all = configs.get(ir.name) || {};
      const out: GraphQLFieldConfigMap<any, any> = {};
      for (const [name, config] of Object.entries(all)) {
        const kind = readBinding(config)?.kind;
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
    (type as GraphQLNamedType & {$sql2gql?: ModelTypeHatch}).$sql2gql = {
      basicFields: pick("basic"),
      relatedFields: pick("related"),
      complexFields: pick("complex"),
      fields: {},
    };
  }
}
