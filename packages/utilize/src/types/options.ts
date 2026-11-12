/**
 * Top-level options bags — `GqlizeOptions` and the types it names.
 */

import type { Permission } from "../gate";
import type { IdCodec, CursorCodec } from "./codecs";
import type { CacheOptions } from "./cache";
import type { CsvOptions } from "./csv";
import type { HookMap } from "./definitions";

/**
 * What a write does when a row-level scope denies it. Declared here because
 * {@link GqlizeOptions} names it; the behaviour lives in ormize.
 */
export type ScopeMissBehaviour = "empty" | "throw";

export type GqlizeOptions = {
  /** Hooks applied to every model, keyed by hook name — see {@link HookMap}. */
  globalHooks?: HookMap
  /**
   * The predicate bag gating what gets generated. Closed by design — see
   * {@link Permission} in `../gate` for why a typo has to be a compile error.
   */
  permission?: Permission,
  /**
   * What a write does when `permission.scope` denies it outright.
   *
   * `"empty"` (the default) reports the same nothing an unscoped write would
   * report for a row that does not exist — the two have to be
   * indistinguishable, or the difference is itself a read of the scoped-out
   * row. `"throw"` trades that for a loud refusal.
   */
  onScopeMiss?: ScopeMissBehaviour,
  /**
   * Make every foreign key client-writable again, as it was in 6.x, without
   * marking each column `writable: true`. Default: `false`.
   *
   * Read by the `Ormize` constructor, not by `createSchema`: the engine applies
   * it in `getFields`, which is what the GraphQL inputs, the zod schemas and
   * the runtime mass-assignment guard all read, so the three cannot disagree.
   *
   * Only plain foreign keys are affected. A key that is also a primary key (a
   * join model's composite key) stays guarded, and a column authored with
   * `writable: false` opts back out — use that for an owner/tenant key that
   * must only ever be set by a scope. See {@link isStructurallyWritable}.
   */
  writableForeignKeys?: boolean,
  /**
   * How primary/foreign keys are rendered as opaque ids and read back.
   * Default: `relayIdCodec()` — base64 `Type:id`, byte-identical to what every
   * previous version emitted.
   */
  id?: IdCodec,
  /**
   * How connection cursors are minted and read back.
   * Default: `relayCursorCodec()` — base64 `[connectionName, index]`.
   *
   * Unlike an id, a cursor is *in-flight* state: clients mid-pagination across a
   * rolling deploy still hold the old format. Change this through
   * `fallbackCursorCodec(next, previous)` rather than in one step.
   */
  cursor?: CursorCodec,
  /** GraphQL field configs merged into the root query/mutation types. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- these are `GraphQLFieldConfigMap` entries, which this graphql-free package cannot name; gqlize holds them and hands them to the schema builder verbatim.
  extend?: any,
  /** The caller's root-type/root-value config, handed to the GraphQL layer as given. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same reason as `extend`: it is graphql-typed config this package only carries.
  root?: any,
  /** The caller's subscription config. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- consumed only by the GraphQL layer that understands it; naming it here would mean depending on graphql.
  subscriptions?: any
  /**
   * Whether the built schema is checked with graphql's own `validateSchema`
   * before it is handed back. Default: `true`.
   *
   * An invalid schema is not inert. graphql validates once per *execution* and
   * returns the same error for every operation, so a single bad field — most
   * often one written into `options.root` or `options.extend` — fails queries
   * that have nothing to do with it, at request time, from a stack that does not
   * name the mistake. Validating at build time turns that into one error at the
   * point the schema was assembled.
   *
   * Set false only to skip the type-map walk (a host building many permission
   * profiles per process may prefer to pay it once in CI, via `gqlize check`).
   */
  validate?: boolean
  /**
   * An LRU cache in front of adapter reads (`findAll` and `count`), off unless
   * this is set. Read by the `Ormize` constructor. See {@link CacheOptions}.
   */
  cache?: CacheOptions
  /**
   * Accept create/update/delete mutations as a CSV upload, off unless this is
   * set: `true` for the default {@link CsvOptions}, or an object to change them.
   * A model opts out with `definition.csv: false`.
   *
   * Read by the `Ormize` constructor, like `cache` and `writableForeignKeys`,
   * so gqlize's `createCsv`/`updateCsv`/`deleteCsv` arguments and nestize's
   * `_csv` routes agree on which models have it. Gated per caller by
   * `permission.mutationCsv`.
   */
  csv?: boolean | CsvOptions
}
