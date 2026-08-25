import { createHash } from "node:crypto";
import { getNamedType, isEnumType, version as graphqlVersion } from "graphql";

import GqlizeBinding from "../../manager";
import type { AnyOrmize, DataTypeDescriptor, Definition, DefinitionFieldMeta, GqlizeOptions } from "../../types";
import { VERSION as gqlizeVersion } from "../../version";

export const FINGERPRINT_FORMAT_VERSION = 1;

/**
 * A cheap, dialect-independent digest of everything that shapes the schema.
 *
 * Split into named buckets rather than one hash so a mismatch can say *what*
 * moved — "models" is a model edit and needs a rebuild, "gqlizeVersion" is a
 * dependency bump, and the two want very different reactions from an operator.
 */
export interface Fingerprint {
  formatVersion: number;
  gqlizeVersion: string;
  graphqlVersion: string;
  /** which adapter serves which definition — not the dialect */
  adapters: string;
  /** the definitions themselves: fields, associations, overrides, exposes */
  models: string;
  /** opaque, caller-supplied; the only handle we have on `options.permission` */
  permissionProfile: string | null;
  /** opaque, caller-supplied; the only handle we have on `options.id` */
  idProfile: string | null;
  /** opaque, caller-supplied; the only handle we have on `options.cursor` */
  cursorProfile: string | null;
  /** which permission predicates are present, and whether subscriptions are on */
  optionsShape: string;
}

export interface FingerprintOptions {
  /**
   * Opaque id naming the permission configuration. `options.permission` is a bag
   * of closures and cannot be hashed — this is the deliberate stand-in, and the
   * one drift the fingerprint cannot detect on its own. `gqlize check --strict`
   * closes the gap by rebuilding live and diffing the sorted SDL.
   */
  permissionProfile?: string;
  /**
   * Opaque id naming the configured {@link IdCodec} / {@link CursorCodec}. Codecs
   * are closures like `permission` is, so the same stand-in applies — but with a
   * sharper failure mode: an artifact built with a codec and loaded without one
   * still *resolves*, silently minting ids and cursors in the wrong format. The
   * `optionsShape` bucket catches the presence/absence half on its own; these
   * profiles are what catches one codec swapped for another.
   */
  idProfile?: string;
  cursorProfile?: string;
  /** the same options object handed to `createSchema` */
  options?: GqlizeOptions;
}

/**
 * Hash the live ormize definitions.
 *
 * Deliberately **excluded**: the SQL dialect (a CI job commonly builds against
 * sqlite while production runs postgres, and the dialect does not change the
 * schema's shape) and every hook/predicate body (they are closures). What is
 * included is the projection the builders actually read.
 */
export function fingerprintDefinitions(orm: AnyOrmize | GqlizeBinding, opts: FingerprintOptions = {}): Fingerprint {
  const instance = orm instanceof GqlizeBinding ? orm : new GqlizeBinding(orm);
  return {
    formatVersion: FINGERPRINT_FORMAT_VERSION,
    gqlizeVersion,
    graphqlVersion,
    adapters: hash(adapterProjection(instance)),
    models: hash(modelProjection(instance)),
    permissionProfile: opts.permissionProfile ?? null,
    idProfile: opts.idProfile ?? null,
    cursorProfile: opts.cursorProfile ?? null,
    optionsShape: hash(optionsProjection(opts.options)),
  };
}

/**
 * Which fingerprint keys differ. Empty means the artifact is current.
 *
 * A missing fingerprint on either side is reported as the single key
 * `"fingerprint"` rather than treated as a match — an artifact that carries no
 * fingerprint has not been *checked*, and calling that "fresh" is the failure
 * mode this whole mechanism exists to prevent.
 */
export function compareFingerprints(a?: Fingerprint | null, b?: Fingerprint | null): string[] {
  if (!a || !b) {
    return ["fingerprint"];
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Fingerprint)[]);
  return [...keys].filter((key) => a[key] !== b[key]).sort();
}

/**
 * The drift keys, with the differing values for the ones a human can read.
 *
 * `adapters` / `models` / `optionsShape` are digests: printing two sha256s says
 * nothing. The version and profile keys are the ones where the value *is* the
 * diagnosis ("built by 7.0.0-beta.5, loaded by 7.0.0-beta.6").
 */
export function describeDrift(
  drift: string[],
  artifact?: Fingerprint | null,
  live?: Fingerprint | null,
): string {
  const readable = new Set([
    "formatVersion", "gqlizeVersion", "graphqlVersion",
    "permissionProfile", "idProfile", "cursorProfile",
  ]);
  return drift.map((key) => {
    if (!readable.has(key) || !artifact || !live) {
      return key;
    }
    return `${key} (artifact ${JSON.stringify(artifact[key as keyof Fingerprint])}, live ` +
      `${JSON.stringify(live[key as keyof Fingerprint])})`;
  }).join(", ");
}

/**
 * Which *implementation* serves each definition — the adapter class, not its
 * registration name and not its dialect.
 *
 * The adapter class is what supplies the type mapper and the filter / orderBy /
 * default-list-arg builders, so swapping it genuinely reshapes the schema.
 * The registration name is a routing label chosen by the caller (test fixtures
 * commonly name it after the dialect), and the dialect is deliberately out of
 * scope — a CI job that builds against sqlite must produce an artifact that
 * loads against postgres.
 */
function adapterProjection(instance: GqlizeBinding) {
  const defsAdapters = instance.orm.defsAdapters || {};
  const adapters = instance.orm.adapters || {};
  return Object.fromEntries(Object.keys(defsAdapters).map((defName) =>
    [defName, adapters[defsAdapters[defName]]?.constructor?.name ?? "unknown"]));
}

function modelProjection(instance: GqlizeBinding) {
  const defs = instance.getDefinitions() || {};
  return Object.keys(defs).sort().map((defName) => {
    const def: Partial<Definition> = defs[defName] || {};
    const fields = safe(() => instance.getFields(defName)) || {};
    const associations = safe(() => instance.getAssociations(defName)) || {};
    return {
      name: def.name ?? defName,
      comment: def.comment,
      comments: def.comments,
      ignoreFields: [...(def.ignoreFields || [])].sort(),
      fields: Object.keys(fields).sort().map((key) =>
        fieldProjection(instance, defName, key, fields[key])),
      associations: Object.keys(associations).sort().map((key) => {
        const a = associations[key] || {};
        // `accessors` is derived from these, so hashing it would only add noise
        return {
          name: key,
          target: a.target,
          source: a.source,
          associationType: a.associationType,
          foreignKey: a.foreignKey,
          targetKey: a.targetKey,
          sourceKey: a.sourceKey,
        };
      }),
      override: Object.keys(def.override || {}).sort().map((fieldName) => {
        const o = def.override?.[fieldName] || {};
        return {
          fieldName,
          description: o.description,
          type: typeShape(o.type),
          inputType: typeShape(o.inputType),
          hasInput: typeof o.input === "function",
          hasOutput: typeof o.output === "function",
        };
      }),
      expose: exposeProjection(def.expose),
    };
  });
}

function fieldProjection(instance: GqlizeBinding, defName: string, key: string, field: DefinitionFieldMeta) {
  return {
    name: field.name ?? key,
    type: fieldType(instance, defName, key, field),
    allowNull: field.allowNull === true,
    primaryKey: field.primaryKey === true,
    foreignKey: field.foreignKey === true,
    foreignTarget: field.foreignTarget,
    description: field.description,
    args: field.args ? Object.keys(field.args).sort() : undefined,
    hasResolve: typeof field.resolve === "function",
  };
}

/**
 * The GraphQL type the builders would give this field — which is the only
 * projection of a native column type that matters here, and the one that makes
 * the fingerprint survive sqlite -> postgres. Enum members are appended because
 * they are schema-visible but the type's name alone hides them.
 */
function fieldType(instance: GqlizeBinding, defName: string, fieldName: string, field: DefinitionFieldMeta): string {
  const gql = safe(() => instance.getGraphQLOutputType(defName, fieldName, field.type));
  if (gql) {
    const named = safe(() => getNamedType(gql));
    if (named && isEnumType(named)) {
      return `${String(gql)}<${named.getValues().map((v) => v.name).join(",")}>`;
    }
    return String(gql);
  }
  // Fall back to ormize's abstract descriptor before the native type: the
  // descriptor is adapter-neutral, `String(nativeType)` is dialect-specific and
  // would make the fingerprint flip on sqlite -> postgres for no real change.
  const descriptor: DataTypeDescriptor | undefined = safe(() => instance.getModelAdapter(defName)?.mapDataType?.(field.type));
  if (descriptor) {
    return `ormize:${descriptor.type}${descriptor.values ? `<${descriptor.values.join(",")}>` : ""}`;
  }
  return `native:${String(field.type)}`;
}

function exposeProjection(expose: Definition["expose"]) {
  if (!expose) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const group of ["classMethods", "instanceMethods"] as const) {
    for (const target of ["query", "mutations"] as const) {
      const methods = expose[group]?.[target];
      if (!methods) {
        continue;
      }
      out[`${group}.${target}`] = Object.keys(methods).sort().map((methodName) => ({
        name: methodName,
        type: typeShape(methods[methodName]?.type),
        args: Object.keys(methods[methodName]?.args || {}).sort().map((argName) => ({
          name: argName,
          type: typeShape(methods[methodName].args[argName]?.type),
        })),
      }));
    }
  }
  return out;
}

/**
 * Definitions hand the builders either a real GraphQL type or a bare config
 * object that the builder wraps. Both carry a `name`; a config object also
 * carries a literal `fields` map worth hashing, since editing it changes the
 * schema. A thunked `fields` is skipped — calling it here could construct types
 * as a side effect of a staleness check.
 */
function typeShape(type: unknown): string | {name: unknown; fields?: string[]} | undefined {
  if (!type) {
    return undefined;
  }
  // Excluding `object` and `function` would not narrow `unknown`, leaving
  // `String()` reading as a stringification of something with no useful one, so
  // the primitives are named instead. A symbol needs its own branch: it has no
  // implicit conversion, and only `.toString()` reaches it.
  if (typeof type === "string") {
    return type;
  }
  if (typeof type === "number" || typeof type === "boolean" || typeof type === "bigint") {
    return String(type);
  }
  if (typeof type === "symbol") {
    return type.toString();
  }
  // Either shape carries `name`; only a config object carries a literal `fields`.
  const authored = type as {name?: unknown; fields?: unknown};
  const shape: {name: unknown; fields?: string[]} = {name: authored.name};
  if (authored.fields && typeof authored.fields === "object") {
    shape.fields = Object.keys(authored.fields).sort();
  }
  return shape;
}

function optionsProjection(options?: GqlizeOptions) {
  // Only the options that shape the *serialized* schema. `extend` and `root` are
  // merged at load from the live options object, so a caller legitimately adding
  // a `health` query locally must not read as a stale artifact.
  //
  // `permission` is excluded for the same reason it has a `permissionProfile`
  // stand-in: it is a bag of closures, and which predicates are *present* is not
  // a property of the artifact. The loading process builds its own options
  // object — commonly with a request-scoped permission bag, or none at all,
  // because permissions were applied at build time — and hashing its key set
  // made every such load report drift. `permissionProfile` is the deliberate
  // handle on permission changes; `gqlize check --strict` is the real gate.
  //
  // The codecs are the one exception to "closures are not hashable, so they are
  // excluded": *whether* one is configured is a property of the artifact, not of
  // the loading process. An artifact built with `options.id` and loaded without
  // it does not fail — it quietly hands clients ids in a different format than
  // the ones it accepts, which is precisely the drift `gqlize check` exists to
  // catch. `carriesType` is included because it decides whether `node(id:)` is
  // in the schema at all. Which *particular* codec is a matter for `idProfile` /
  // `cursorProfile`.
  return {
    subscriptions: Boolean(options?.subscriptions),
    id: Boolean(options?.id),
    idCarriesType: options?.id ? options.id.carriesType !== false : true,
    cursor: Boolean(options?.cursor),
  };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** JSON with object keys in sorted order, so the digest is stable across runs. */
export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as {[key: string]: unknown};
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
