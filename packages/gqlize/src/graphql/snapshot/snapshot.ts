import {
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  print,
  valueToLiteral,
  type GraphQLArgument,
  type GraphQLEnumType,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLInputObjectType,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLScalarType,
  type GraphQLSchema,
  type GraphQLUnionType,
} from "graphql";

import { GQLIZE_EXT } from "../resolvers/types";
import { readBinding } from "../resolvers/bind";
import { getBuild } from "./build-registry";
import { fingerprintDefinitions } from "./fingerprint";
import type { GqlizeBuildLedger } from "./ledger";
import {
  SNAPSHOT_FORMAT_VERSION,
  type EnumTypeIR,
  type EnumValueIR,
  type FieldIR,
  type InputObjectTypeIR,
  type InputValueIR,
  type InterfaceTypeIR,
  type NamedTypeIR,
  type ObjectTypeIR,
  type ScalarTypeIR,
  type SchemaSnapshot,
  type UnionTypeIR,
} from "./ir";
import { collectSnapshotTypes } from "./reachability";
import { createScalarRegistry, unknownScalarError, type ScalarRegistry } from "./scalar-registry";
import { encodeTypeRef } from "./type-ref";

export interface SnapshotOptions {
  /** must be the same map passed to `materializeSchema` */
  scalars?: Record<string, GraphQLScalarType>;
  /** opaque id folded into the fingerprint; `options.permission` cannot be hashed */
  permissionProfile?: string;
  /**
   * The ormize instance to fingerprint. Normally unnecessary — a schema from
   * `createSchema` remembers the instance and options it was built from. Supply
   * it when the schema came from somewhere else, or pass `false` to skip the
   * fingerprint entirely (the artifact then loads without a staleness check).
   */
  orm?: any | false;
}

/**
 * Serialize a built `GraphQLSchema` into a loadable IR.
 *
 * The contract is **fail loud**: anything this cannot describe throws with its
 * schema coordinate. A silently dropped resolver or enum value becomes a
 * production-only, data-shaped failure; a build-time throw costs nothing.
 */
export function snapshotSchema(schema: GraphQLSchema, opts: SnapshotOptions = {}): SchemaSnapshot {
  const buildLedger = (schema.extensions as any)?.[GQLIZE_EXT] as GqlizeBuildLedger | undefined;
  if (!buildLedger) {
    throw new Error(
      "gqlize: schema has no build ledger — snapshotSchema only accepts a schema built by " +
        "gqlize's createSchema (the ledger records the user-supplied types and relay model " +
        "map that cannot be re-derived from the type system alone).",
    );
  }
  const query = schema.getQueryType();
  if (!query) {
    throw new Error("gqlize: schema has no query type");
  }

  const registry = createScalarRegistry(opts.scalars);
  // clone: the live schema's ledger must not gain snapshot-time bookkeeping
  const ledger: GqlizeBuildLedger = {
    ...buildLedger,
    externalTypes: { ...buildLedger.externalTypes },
    extendFields: {
      query: [...(buildLedger.extendFields?.query || [])],
      mutation: [...(buildLedger.extendFields?.mutation || [])],
    },
    scalars: { ...buildLedger.scalars },
  };

  const { types } = collectSnapshotTypes(schema, ledger);
  const modelTypes = new Set(ledger.modelTypes || []);

  const ir: NamedTypeIR[] = types.map((type) => encodeNamedType(type, registry, ledger, modelTypes));

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    ...fingerprintOf(schema, opts),
    ...maybe("description", schema.description),
    query: query.name,
    ...(schema.getMutationType() ? { mutation: schema.getMutationType()!.name } : {}),
    types: ir,
    ledger,
  };
}

/**
 * The fingerprint is what lets the loader refuse a stale artifact, so it is
 * recorded by default. `permissionProfile` is folded in even when there is no
 * orm to hash — an artifact that names its profile is still worth checking that
 * much of.
 */
function fingerprintOf(schema: GraphQLSchema, opts: SnapshotOptions) {
  if (opts.orm === false) {
    return {};
  }
  const orm = opts.orm ?? getBuild(schema)?.instance;
  if (!orm) {
    return {};
  }
  return {
    fingerprint: fingerprintDefinitions(orm, {
      permissionProfile: opts.permissionProfile,
      options: getBuild(schema)?.options,
    }),
  };
}

/**
 * Descriptions are recorded whenever they are *present*, not whenever they are
 * truthy: the input-object builders pass `""`, and `printSchema` emits an empty
 * block string for it. Dropping it silently changes the printed schema.
 */
function maybe<K extends string>(key: K, value: string | null | undefined) {
  return (value === undefined || value === null ? {} : {[key]: value}) as Record<K, string>;
}

function encodeNamedType(
  type: GraphQLNamedType,
  registry: ScalarRegistry,
  ledger: GqlizeBuildLedger,
  modelTypes: Set<string>,
): NamedTypeIR {
  if (isObjectType(type)) {
    return encodeObject(type, modelTypes);
  }
  if (isInterfaceType(type)) {
    return encodeInterface(type);
  }
  if (isUnionType(type)) {
    return encodeUnion(type);
  }
  if (isEnumType(type)) {
    return encodeEnum(type);
  }
  if (isInputObjectType(type)) {
    return encodeInputObject(type);
  }
  if (isScalarType(type)) {
    return encodeScalar(type, registry, ledger);
  }
  throw new Error(`gqlize: cannot snapshot type "${(type as any).name}" of unknown kind`);
}

function encodeObject(type: GraphQLObjectType, modelTypes: Set<string>): ObjectTypeIR {
  if (type.isTypeOf) {
    throw new Error(
      `gqlize: ${type.name} defines isTypeOf, which is code and cannot be serialised`,
    );
  }
  const interfaces = type.getInterfaces().map((i) => i.name);
  return {
    kind: "object",
    name: type.name,
    ...maybe("description", type.description),
    ...(interfaces.length ? { interfaces } : {}),
    fields: encodeFields(type),
    ...(modelTypes.has(type.name) ? { model: { defName: type.name } } : {}),
  };
}

function encodeInterface(type: GraphQLInterfaceType): InterfaceTypeIR {
  if (type.resolveType) {
    throw new Error(
      `gqlize: interface ${type.name} defines resolveType, which is code and cannot be ` +
        "serialised (only the relay node interface may, and it is rebuilt live at load)",
    );
  }
  const interfaces = type.getInterfaces().map((i) => i.name);
  return {
    kind: "interface",
    name: type.name,
    ...maybe("description", type.description),
    ...(interfaces.length ? { interfaces } : {}),
    fields: encodeFields(type),
  };
}

function encodeUnion(type: GraphQLUnionType): UnionTypeIR {
  if (type.resolveType) {
    throw new Error(
      `gqlize: union ${type.name} defines resolveType, which is code and cannot be serialised`,
    );
  }
  return {
    kind: "union",
    name: type.name,
    ...maybe("description", type.description),
    types: type.getTypes().map((t) => t.name),
  };
}

function encodeEnum(type: GraphQLEnumType): EnumTypeIR {
  const values: EnumValueIR[] = type.getValues().map((value) => {
    const out: EnumValueIR = { name: value.name };
    Object.assign(out, maybe("description", value.description));
    Object.assign(out, maybe("deprecationReason", value.deprecationReason));
    if (value.value !== value.name) {
      if (!isJsonSerializable(value.value)) {
        throw new Error(
          `gqlize: enum value ${type.name}.${value.name} carries a non-JSON internal value ` +
            `(${describe(value.value)}). Internal values are the payload handed to the ORM ` +
            "and cannot be reconstructed from the enum name.",
        );
      }
      out.value = value.value;
    }
    return out;
  });
  return {
    kind: "enum",
    name: type.name,
    ...maybe("description", type.description),
    values,
  };
}

function encodeInputObject(type: GraphQLInputObjectType): InputObjectTypeIR {
  return {
    kind: "input",
    name: type.name,
    ...maybe("description", type.description),
    fields: Object.values(type.getFields()).map((field: GraphQLInputField) =>
      encodeInputValue(field, `${type.name}.${field.name}`),
    ),
    ...(type.isOneOf ? { isOneOf: true } : {}),
  };
}

function encodeScalar(
  type: GraphQLScalarType,
  registry: ScalarRegistry,
  ledger: GqlizeBuildLedger,
): ScalarTypeIR {
  const registryKey = registry.keyFor(type);
  if (!registryKey) {
    throw unknownScalarError(type.name, "snapshotSchema");
  }
  ledger.scalars[type.name] = registryKey;
  return {
    kind: "scalar",
    name: type.name,
    ...maybe("description", type.description),
    registryKey,
    ...maybe("specifiedByURL", type.specifiedByURL),
  };
}

function encodeFields(type: GraphQLObjectType | GraphQLInterfaceType): FieldIR[] {
  const out: FieldIR[] = [];
  for (const field of Object.values(type.getFields()) as GraphQLField<any, any>[]) {
    const binding = readBinding(field as any);
    if (binding?.kind === "extend") {
      // supplied via `options.extend` and re-merged at load — never serialized
      continue;
    }
    const coordinate = `${type.name}.${field.name}`;
    if ((field.resolve || (field as any).subscribe) && !binding) {
      throw new Error(
        `gqlize: ${coordinate} has a resolver but no binding descriptor. Every resolver must be ` +
          "attached through bindField() so the loader can rebuild it; a field serialized without " +
          "one would silently resolve to undefined at runtime.",
      );
    }
    const args = (field.args || []).map((arg: GraphQLArgument) =>
      encodeInputValue(arg, `${coordinate}(${arg.name}:)`),
    );
    out.push({
      name: field.name,
      type: encodeTypeRef(field.type),
      ...maybe("description", field.description),
      ...maybe("deprecationReason", field.deprecationReason),
      ...(args.length ? { args } : {}),
      ...(binding ? { binding } : {}),
    });
  }
  return out;
}

function encodeInputValue(
  iv: GraphQLArgument | GraphQLInputField,
  coordinate: string,
): InputValueIR {
  return {
    name: iv.name,
    type: encodeTypeRef(iv.type),
    ...maybe("description", iv.description),
    ...maybe("deprecationReason", iv.deprecationReason),
    ...(encodeDefault(iv, coordinate) ?? {}),
  };
}

function encodeDefault(
  iv: GraphQLArgument | GraphQLInputField,
  coordinate: string,
): { defaultLiteral: string } | undefined {
  const def = iv.default;
  let value: unknown;
  if (def === undefined) {
    // `defaultValue` is the deprecated v17 spelling, removed in v18
    if ((iv as any).defaultValue === undefined) {
      return undefined;
    }
    value = (iv as any).defaultValue;
  } else if (def.literal !== undefined) {
    return { defaultLiteral: print(def.literal) };
  } else {
    value = def.value;
  }
  let literal;
  try {
    literal = valueToLiteral(value, iv.type);
  } catch (err: any) {
    throw new Error(
      `gqlize: default value for ${coordinate} could not be encoded: ${err.message}`,
    );
  }
  if (!literal) {
    throw new Error(
      `gqlize: default value for ${coordinate} (${describe(value)}) is not representable as a ` +
        `GraphQL literal of type ${String(iv.type)}`,
    );
  }
  return { defaultLiteral: print(literal) };
}

/**
 * Structural check rather than a `JSON.stringify` round-trip: stringify happily
 * turns a `Date` into a string and a class instance into a bare object, both of
 * which would load back as something the ORM does not accept.
 */
export function isJsonSerializable(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  const type = typeof value;
  if (type === "string" || type === "boolean") {
    return true;
  }
  if (type === "number") {
    return Number.isFinite(value as number);
  }
  if (type !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonSerializable);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  return Object.values(value as object).every(isJsonSerializable);
}

function describe(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  const proto = Object.getPrototypeOf(value);
  const ctor = proto?.constructor?.name;
  if (typeof value === "object" && ctor && ctor !== "Object" && ctor !== "Array") {
    return `${ctor} instance`;
  }
  if (typeof value === "function") {
    return "function";
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
