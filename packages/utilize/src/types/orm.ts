// Generic, adapter-agnostic type plumbing for the gqlize definition typesystem.
//
// This module contains NO adapter-specific (e.g. sequelize) types. Adapters
// (plugins) augment `IORBaseRegistry` to map a merged (instance, statics) pair
// to their concrete model type, and expose a string "base URI" that selects
// that mapping — the fp-ts "lightweight HKT" pattern. The core gqlize manager
// consumes only these generic types.

import { Definition } from "./index";

/**
 * A gqlize {@link Definition} tagged with the TypeScript instance + statics
 * types it produces. The `__instance` / `__statics` fields are phantom — they
 * are never present at runtime (`defineModel` returns the definition verbatim);
 * they exist only so the composition types below can `infer` them.
 */
export interface ITypedDefinition<Name extends string, TInstance, TStatics>
  extends Definition {
  name: Name;
  /** phantom — the model instance type (attributes + instance methods) */
  readonly __instance?: TInstance;
  /** phantom — the static/classMethods type */
  readonly __statics?: TStatics;
}

/** Any typed definition, regardless of its concrete instance/statics types. */
export type AnyTypedDef = ITypedDefinition<string, any, any>;

/** The literal model name of a typed definition. */
export type ModelNameOf<D> = D extends ITypedDefinition<infer N, any, any>
  ? N
  : never;

/**
 * Lightweight-HKT registry. Each adapter augments this interface with a single
 * key (its "base URI") mapping a merged instance + statics pair to the adapter's
 * concrete model type, e.g. the sequelize plugin adds:
 *
 * The four slots are kept separate (required vs optional, instance vs statics)
 * so the adapter controls how optional fragments are made optional — e.g. the
 * sequelize mapping partials only the optional *attributes*, leaving the
 * required fragment's `Model` brand (and its creation-attribute typing) intact.
 *
 * ```ts
 * declare module "@azerothian/utilize/types/orm" {
 *   interface IORBaseRegistry<ReqInstance, OptInstance, ReqStatics, OptStatics> {
 *     sequelize: ModelStatic<ReqInstance & Partial<InferAttributes<OptInstance>>>
 *       & ReqStatics & Partial<OptStatics>;
 *   }
 * }
 * ```
 */
export interface IORBaseRegistry<
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ReqInstance,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  OptInstance,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ReqStatics,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  OptStatics,
> {}

/** Union of registered adapter base URIs (e.g. `"sequelize"`). */
export type IORBase = keyof IORBaseRegistry<any, any, any, any>;

/** Collapse a union to an intersection. */
export type UnionToIntersection<U> = (
  U extends any ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

/**
 * Extract phantom key `K` from every element of a definition tuple and
 * intersect the results (dropping the phantom `undefined`). An empty tuple
 * yields `unknown` (the intersection identity).
 */
export type MergeDefs<
  Defs extends readonly AnyTypedDef[],
  K extends "__instance" | "__statics",
> = UnionToIntersection<NonNullable<Defs[number][K]>>;

/**
 * Compose one or more typed definitions into a model type for base `TBase`.
 * `TRequired` fragments contribute required members; `TOptional` fragments
 * contribute optional (`?`) members. The concrete model shape comes from the
 * adapter's {@link IORBaseRegistry} entry for `TBase`.
 */
export type IORModel<
  TBase extends IORBase,
  TRequired extends readonly AnyTypedDef[],
  TOptional extends readonly AnyTypedDef[] = [],
> = IORBaseRegistry<
  MergeDefs<TRequired, "__instance">,
  MergeDefs<TOptional, "__instance">,
  MergeDefs<TRequired, "__statics">,
  MergeDefs<TOptional, "__statics">
>[TBase];

/**
 * Extract the base URI branded onto an adapter instance via `__base`.
 * Adapters that support typed models declare `readonly __base?: <uri>`.
 */
export type BaseOf<A> = A extends { readonly __base?: infer B }
  ? [B] extends [IORBase]
    ? B
    : IORBase
  : IORBase;
