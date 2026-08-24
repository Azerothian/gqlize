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
  GraphQLOutputType,
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
  mutationInputFields: { [name: string]: GraphQLInputType };
  basicFields: { [modelName: string]: GqlFieldMap };
  complexFields: { [modelName: string]: GqlFieldMap };
  relatedFields: { [modelName: string]: GqlFieldMap };
};
