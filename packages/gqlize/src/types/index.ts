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
import type { Ormize } from "@azerothian/ormize";
import type { IORBase } from "@azerothian/utilize/types/index";
import type { GqlizeBuildLedger } from "../graphql/snapshot/ledger";

/**
 * An `Ormize` instance whose model map is not known here.
 *
 * `Ormize` is generic over the map its fluent `define()` chain accumulates, and
 * nothing in gqlize reads a model by name — it forwards. Naming a concrete map
 * would reject every instance a caller actually builds, and naming the default
 * one would reject the typed ones. The base parameter keeps its own constraint:
 * it is a registry key, and `any` is not one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the model map is the caller's; see above. `unknown` is not a substitute: `Ormize`'s map parameter is read in both positions, so it would reject every instance rather than accept any.
export type AnyOrmize = Ormize<any, IORBase>;

/**
 * One already-built field config, as handed to `new GraphQLObjectType({fields})`.
 *
 * Identical to `GraphQLFieldConfigMap`'s element type — named here so the two
 * `graphql` type parameters are explained once rather than at each of the fifty
 * places a field config is passed around.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `TSource` and `TContext` are the consumer's: the source is whatever the ORM adapter returned and the context is the application's own per-request object. Pinning either would make every consumer-authored `resolve` non-assignable, which is a breaking change to a published type.
export type GqlFieldConfig = GraphQLFieldConfig<any, any>;

/** Already-built field configs, keyed by field name — what a `fields()` thunk returns. */
export type GqlFieldMap = { [fieldName: string]: GqlFieldConfig };

/** The four input object types generated per mutable model. */
export type MutationInputSet = {
  /**
   * The two bare input objects the four list-wrapped members below are built
   * from. Declared because `create-mutation-input` reads them back off a
   * relationship's target to decide whether that relationship can appear as a
   * nested create/update — they are part of the shape, not an internal detail.
   */
  required?: GraphQLNullableInputType;
  optional?: GraphQLNullableInputType;
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
  lists: { [name: string]: GqlFieldConfig };
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
  /**
   * Where the build records the user-authored types it met, for the snapshotter
   * to re-derive later. Optional because only a build that is going to be
   * snapshotted collects one; see `graphql/snapshot/ledger`.
   */
  ledger?: GqlizeBuildLedger;
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
