import { isScalarType, specifiedScalarTypes, type GraphQLScalarType } from "graphql";

import BigIntType from "@azerothian/graphql-types/bigint";
import DateType from "@azerothian/graphql-types/date";
import IPType from "@azerothian/graphql-types/ip";
import JSONType from "@azerothian/graphql-types/json";
import UploadType from "@azerothian/graphql-types/upload";

/**
 * Scalars are the one part of a schema that is irreducibly *code*:
 * `serialize` / `parseValue` / `parseLiteral` cannot be serialized, and a
 * scalar rebuilt without them silently accepts and emits the wrong values.
 *
 * So the IR stores a registry *key* and both ends look the instance up here.
 * Anything not in the registry throws — at snapshot time and at materialize
 * time — rather than degrading to a pass-through scalar.
 */
export interface ScalarRegistry {
  /** the key a scalar type serializes as, or `undefined` if unregistered */
  keyFor(type: GraphQLScalarType): string | undefined;
  get(key: string): GraphQLScalarType | undefined;
  has(key: string): boolean;
  keys(): string[];
}

/** the scalars gqlize itself can put into a schema, plus graphql's own five */
export function builtinScalars(): Record<string, GraphQLScalarType> {
  const out: Record<string, GraphQLScalarType> = {};
  for (const type of [
    ...specifiedScalarTypes,
    BigIntType,
    DateType,
    IPType,
    JSONType,
    UploadType,
  ] as GraphQLScalarType[]) {
    out[type.name] = type;
  }
  return out;
}

/**
 * Keys default to the scalar's own name, which makes the common case
 * ("I pass the same `scalars` map to both ends") require no bookkeeping.
 * `extra` may re-key a built-in, e.g. to swap `Date` for a stricter variant.
 */
export function createScalarRegistry(extra?: Record<string, GraphQLScalarType>): ScalarRegistry {
  const byKey = new Map<string, GraphQLScalarType>(Object.entries(builtinScalars()));
  for (const [key, type] of Object.entries(extra || {})) {
    if (!isScalarType(type)) {
      throw new Error(`gqlize: scalar registry entry "${key}" is not a GraphQLScalarType`);
    }
    byKey.set(key, type);
  }
  // Lookup is by *name*, not identity: a caller who rebuilds an equivalent
  // instance in the loading process must still resolve.
  const byName = new Map<string, string>();
  for (const [key, type] of byKey) {
    if (!byName.has(type.name)) {
      byName.set(type.name, key);
    }
  }
  return {
    keyFor: (type) => byName.get(type.name),
    get: (key) => byKey.get(key),
    has: (key) => byKey.has(key),
    keys: () => [...byKey.keys()],
  };
}

export function unknownScalarError(name: string, where: "snapshotSchema" | "materializeSchema") {
  return new Error(
    `gqlize: scalar "${name}" is not in the scalar registry. Scalar coercion is code and ` +
      `cannot be serialised — pass it via \`scalars\` to both snapshotSchema and ` +
      `materializeSchema (${where} is the end that failed).`,
  );
}
