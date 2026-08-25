import type { GraphQLSchema } from "graphql";

import type GqlizeBinding from "../../manager";
import type { AnyOrmize, GqlizeOptions } from "../../types";

export interface BuildRecord {
  instance: AnyOrmize | GqlizeBinding;
  options: GqlizeOptions;
}

/**
 * Remembers which ormize instance and options produced a given schema, so
 * `snapshotSchema(schema)` can fingerprint without the caller having to hand the
 * orm back in.
 *
 * A `WeakMap` rather than a property on the schema: it costs nothing on the hot
 * build path, cannot be serialized by accident, and does not widen the public
 * shape of `GraphQLSchema`. Nothing depends on the entry existing — a schema
 * built by some other route simply snapshots without a fingerprint.
 */
const builtWith = new WeakMap<GraphQLSchema, BuildRecord>();

export function recordBuild(schema: GraphQLSchema, instance: AnyOrmize | GqlizeBinding, options: GqlizeOptions = {}) {
  builtWith.set(schema, {instance, options});
  return schema;
}

export function getBuild(schema: GraphQLSchema): BuildRecord | undefined {
  return builtWith.get(schema);
}
