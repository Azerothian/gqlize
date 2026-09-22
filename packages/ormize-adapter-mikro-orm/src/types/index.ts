// Adapter-specific types for the MikroORM backend.
//
// Nothing here touches `graphql` — the GraphQL-facing half of the adapter lives
// in `../graphql` and `../type-mapper`, the same split the other two adapters use.

import type { Definition } from "@azerothian/utilize/types/index";

/**
 * A MikroORM `EntityManager`, structurally.
 *
 * Declared here rather than imported so this module states exactly which members
 * the adapter reaches for. The real `EntityManager` satisfies it, and typing the
 * seam this way is what lets a transaction handle — which *is* a forked
 * EntityManager — flow through the contract's opaque `AdapterTransactionHandle`
 * and be recognised again on the way back in.
 */
export interface MikroEntityManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MikroORM's own `find` is eight generic parameters deep and resolves `Loaded<…>` against them; restating that here would bind this adapter to one minor version of those types for no safety it does not already get from `EntityMetadata`
  [method: string]: any;
}

/**
 * What the adapter reads off the MikroORM instance it was handed.
 *
 * Structural for the same reason as {@link MikroEntityManager}, and because the
 * ORM class is generic in its driver: naming it concretely would force every
 * caller's driver to match the one this package's devDependency resolved to.
 */
export interface MikroORMInstance {
  em: MikroEntityManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `getMetadata()` is overloaded (storage vs. one entity's metadata) and `schema` resolves through the driver's platform; both are narrowed at their use sites in `../discover` and `../index`
  [member: string]: any;
}

/**
 * Per-entity additions to a discovered {@link Definition}.
 *
 * Discovery can read structure — columns, nullability, relations — but nothing
 * about how a model should be *exposed*: `expose`, `comments`, `deprecations`,
 * `override`, the `before`/`after` hooks, class/instance methods and custom
 * where-operators are all authored, and all of them live on a `Definition`. This
 * is where an author supplies them without giving up discovery for the rest.
 *
 * Merged *over* the derived definition, key by key for `define` — so naming one
 * column here does not drop the other forty.
 */
export type MikroDefinitionOverrides = { [entityName: string]: Partial<Definition> };

/**
 * Closed on purpose, like the SQL adapter's own options: every key is spelled
 * out, so a misspelling is a compile error rather than a silently ignored
 * setting.
 */
export interface MikroAdapterOptions {
  /**
   * Per-entity {@link MikroDefinitionOverrides}, merged over what discovery
   * derived.
   */
  definitions?: MikroDefinitionOverrides;
  /**
   * Restrict discovery to these entity class names. Absent means every entity
   * MikroORM knows about, which is the point of handing over an instance.
   */
  entities?: string[];
  /**
   * Whether `initialise()`/`sync()`/`reset()` may issue schema DDL.
   *
   * Defaults to `false`, and deliberately: the instance handed to this adapter
   * belongs to the host application, and its schema is that application's
   * business. An ormize call must not silently create or drop tables under it.
   * Tests and throwaway databases turn it on.
   */
  manageSchema?: boolean;
  /**
   * Whether to advertise the Postgres-only array and range operators
   * (`$overlap`, `$contains`, `$contained`) in generated `where` inputs.
   *
   * Opt-in for the reason the SQL adapter gates its regexp operators: the filter
   * vocabulary must not offer an operator the configured driver will reject at
   * query time.
   */
  enablePostgresArrayOperators?: boolean;
}

/**
 * The query bag this adapter builds and consumes.
 *
 * The contract types options as an open `AdapterQueryOptions` because no caller
 * may assume its shape; this is what it actually holds once this adapter has
 * built it, and every read of it inside the package narrows to this.
 */
export interface MikroQueryOptions {
  /** A forked EntityManager enrolled in a transaction — see `MikroAdapter.emFor`. */
  transaction?: MikroEntityManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a MikroORM `FilterQuery` is generic in the entity, which is only known by name at this layer
  where?: any;
  /** One map, or a list of them — an ordering is a sequence, and two entries for the same property would collapse into one object. */
  orderBy?: { [property: string]: unknown } | { [property: string]: unknown }[];
  populate?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `populateWhere` mirrors `where`'s shape, nested by relation path
  populateWhere?: any;
  populateHints?: { [path: string]: { limit?: number; offset?: number; orderBy?: object } };
  fields?: string[];
  limit?: number;
  offset?: number;
  [option: string]: unknown;
}
