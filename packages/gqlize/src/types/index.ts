// Re-export barrel: the shared type surface now lives in
// @azerothian/utilize. Kept here to preserve the public
// `@azerothian/gqlize/types/index` subpath (used by external adapters) and
// internal `../types` imports across the core package.
export * from "@azerothian/utilize/types/index";
// The GraphQL-facing adapter contract lives in gqlize (it references `graphql`
// types); re-exported so `@azerothian/gqlize/types/gqlize-adapter` and the
// barrel both surface it.
export * from "./gqlize-adapter";

import type {
  GraphQLFieldConfig,
  GraphQLInputType,
  GraphQLNullableInputType,
  GraphQLOutputType,
  GraphQLType,
} from "graphql";

/** Already-built field configs, keyed by field name — what a `fields()` thunk returns. */
export type GqlFieldMap = { [fieldName: string]: GraphQLFieldConfig<any, any> };

/** The four input object types generated per mutable model. */
export type MutationInputSet = {
  create?: GraphQLInputType;
  update?: GraphQLInputType;
  select?: GraphQLInputType;
  delete?: GraphQLInputType;
};

/**
 * The per-build memo threaded through every schema builder, so a type named
 * twice is built once.
 *
 * Lives in gqlize rather than `@azerothian/utilize`: every bucket holds a
 * `graphql` type, and utilize is deliberately graphql-free. It was declared
 * there as `{[x: string]: any}` twelve times over, which described nothing —
 * the buckets do not share a shape. `types` and `mutationInputFields` are keyed
 * by type name (with a `Name[]` entry for the list wrapper); the `*Fields`
 * buckets are keyed by model name and hold that model's field map; the
 * class-method and mutation-model buckets are flat field maps accumulated
 * across every model, since each becomes one object type's `fields`.
 */
export type SchemaCache = {
  types: { [name: string]: GraphQLOutputType };
  typeFields: { [modelName: string]: GqlFieldMap };
  lists: { [name: string]: GraphQLFieldConfig<any, any> };
  orderBy: { [name: string]: GraphQLInputType };
  classMethodQueries: GqlFieldMap;
  classMethodMutations: GqlFieldMap;
  mutationInputs: { [modelName: string]: MutationInputSet };
  mutationModels: GqlFieldMap;
  /**
   * Nullable rather than the full input union on purpose: this bucket only ever
   * holds an input object or a list of one, and callers wrap it in
   * `GraphQLNonNull` themselves.
   */
  mutationInputFields: { [name: string]: GraphQLNullableInputType };
  basicFields: { [modelName: string]: GqlFieldMap };
  complexFields: { [modelName: string]: GqlFieldMap };
  relatedFields: { [modelName: string]: GqlFieldMap };
};

/**
 * The `$sql2gql` escape hatch hung off every generated model type: the three
 * field partitions the builder assembled the type from, still as thunks, so a
 * caller can take a model's fields apart the same way. `fields` is an empty slot
 * the builder never fills — it is there for callers to hang their own on.
 *
 * Not part of the GraphQL type system, which is why every site that attaches one
 * has to widen the type it is attaching to.
 */
export type ModelTypeHatch = {
  basicFields: () => GqlFieldMap;
  relatedFields: () => GqlFieldMap;
  complexFields: () => GqlFieldMap;
  fields: GqlFieldMap;
};

/**
 * The `$sql2gql` escape hatch hung off the built `GraphQLSchema`: every generated
 * model type by name, with a `Name[]` entry per list wrapper. Documented in
 * `docs/specifications.md`.
 *
 * A key can hold `undefined` — a permission-denied model leaves a hole rather
 * than dropping the key, and the relay node mapper is fed this exact map.
 */
export type SchemaHatch = {
  types: { [name: string]: GraphQLType | undefined };
};
