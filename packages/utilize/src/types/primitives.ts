/**
 * Opaque value types — type aliases for values whose concrete shape belongs to
 * the adapter, the definition author, or the GraphQL layer, not to this package.
 *
 * Every alias here is `unknown` or `any` by design: the docblock on each one
 * explains why a narrower type would be wrong. They exist so that call sites
 * read as contracts ("this is a transaction handle", "this is a field's value")
 * rather than bare `any`.
 */

/**
 * An adapter-native transaction token — a Sequelize `Transaction`, a Valkey
 * MULTI handle, whatever the backend uses. Threaded onto each operation's
 * options and handed back to the adapter untouched, so nothing outside the
 * adapter that produced it may look inside.
 */
export type AdapterTransactionHandle = unknown;

/**
 * An adapter-native type token (`DataTypes.STRING`, a column descriptor, ...).
 * `mapDataType` classifies one into a {@link DataTypeDescriptor} and
 * `toNativeType` produces one; it is opaque everywhere in between.
 */
export type NativeDataType = unknown;

/**
 * An adapter-native filter. `processFilterArgument` builds one from caller args
 * plus the definition's `whereOperators`, and it goes straight back to the
 * adapter — the shape belongs to the backend (Sequelize's `where`, a Valkey
 * index query), not to us.
 *
 * Symbol keys are admitted alongside string ones because a backend may key by
 * symbol: Sequelize's operators (`Op.and`, `Op.eq`) are symbols, and the
 * combined filter this type describes is largely made of them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the filter is the backend's own vocabulary — Sequelize `Op` symbols, a Valkey index query — assembled by `processFilterArgument` and handed straight back to the adapter that understands it. Any shape named here would be one backend's.
export type AdapterWhere = { [key: string | symbol]: any };

/**
 * The options bag threaded through a backend operation: `where`, `limit`,
 * `offset`, `order`, `include`, the transaction token, and whatever else the
 * adapter understands. Produced by `processListArgsToOptions` and merged along
 * the way, so it stays open by design.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the bag accumulates adapter-specific keys as it is merged along the way and is consumed only by the adapter that put them there; the docblock above is the whole contract.
export type AdapterQueryOptions = { [key: string]: any };

/**
 * The caller's per-request context, threaded through every resolve and mutation,
 * handed to `definition.before`/`after` hooks and merged into the options bag the
 * adapter receives.
 *
 * Deliberately `any`: the shape belongs to the application — gqlize passes the
 * GraphQL execution context, nestize passes `{req}` — and ormize forwards it
 * untouched apart from one optional key it reads and re-stamps itself
 * (`transaction`). The same value is also accepted anywhere an
 * {@link AdapterQueryOptions} bag is, so `unknown` would move the narrowing out
 * to every call site without making anything more certain.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shape belongs to the application (gqlize passes the GraphQL execution context, nestize `{req}`) and ormize forwards it untouched — see the docblock above for why `unknown` would only move the narrowing out to every call site.
export type RequestContext = any;

/**
 * A single field's value: a column as the adapter reads or writes it, a
 * `defaultValue`, or what an exposed method produces for its field.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a column's value is whatever the backend types that column as, and this package is adapter-agnostic by design — it cannot name the union. `unknown` would push a narrowing onto every adapter and definition author that already knows the concrete type.
export type FieldValue = any;

/** A row's field values, keyed by field name. */
export type FieldValues = {[field: string]: FieldValue};

/**
 * The arguments a field was selected with, as they reach a hook. The shape is
 * whatever that field's own `args` declaration produced.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the bag's shape is fixed by the definition author's own `args`, not by this package, and it is handed straight back to author-written hooks that know their own vocabulary.
export type FieldArgs = any;

/**
 * A field's argument *declarations* — the `args` config a definition author
 * writes, as opposed to the {@link FieldArgs} values that arrive at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- these are GraphQL argument configs, and this package is graphql-free: naming them would mean importing `GraphQLFieldConfigArgumentMap`, which is exactly what it exists to avoid.
export type FieldArgsConfig = any;

/**
 * The caller's raw GraphQL execution info, passed through to definition hooks
 * untouched. {@link Selection.raw} carries the same value into the engine.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- naming this means importing `GraphQLResolveInfo` into a package that must not depend on graphql; it is only ever read by the GraphQL caller that supplied it.
export type ExecutionInfo = any;

/**
 * A row as it reaches a definition-authored hook. Unlike {@link AdapterRow},
 * which is `unknown` because no *engine* code may assume a shape, a hook is
 * written by whoever declared the model and reads its own columns off it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the hook author knows the row type and this package cannot; `unknown` here would turn every `params.model.someColumn` in user code into a compile error.
export type LoadedRow = any;

/**
 * A callback a definition supplies for this package to call back into: a field's
 * `resolve`, an exposed method's `before`/`after`, an `override`'s `output`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each of these is invoked with a different signature by a different layer (the GraphQL builder, the mutation engine, the adapter), so there is no single function type to give them here.
export type DefinitionHook = any;

/**
 * An instance or class method a definition installs onto its model. `this` is
 * the row (instance methods) or the model handle (class methods).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `this` is the adapter's own row/model type, which this package cannot name, and the return is whatever the author's method produces.
export type DefinitionMethod = (this: any, args?: FieldArgs, context?: RequestContext) => any;

/**
 * A row as the adapter returns it — a Sequelize model instance, a plain object,
 * a decoded hash. Only the adapter knows the concrete shape, so the fetch
 * methods take a type parameter and callers that know what they asked for can
 * name it.
 */
export type AdapterRow = unknown;

/**
 * What one `resolveManyRelationship` hop returns: the page of rows, plus the
 * true total behind it — which is *not* `models.length` once a per-parent limit
 * has been applied, so relay `pageInfo` needs it reported separately.
 */
/**
 * One page of a relationship. `through` is set only for a `belongsToMany` in
 * through mode: the join row behind each entry of `models`, by position.
 */
export type AdapterRelationshipPage = { total: number; models: AdapterRow[]; through?: (AdapterRow | undefined)[] };

/** `getCreateFunction(defName)` — insert one row. */
export type AdapterCreateFunction = (input: FieldValues, options: AdapterQueryOptions) => Promise<AdapterRow>;

/**
 * `getUpdateFunction(defName, whereOperators)` — update every row matching
 * `where`. `processInput` is called per matched row and returns the patch to
 * apply, so a hook can derive it from the row's current state.
 */
export type AdapterUpdateFunction = (
  where: AdapterWhere,
  processInput: (instance: AdapterRow) => Promise<FieldValues> | FieldValues,
  options: AdapterQueryOptions,
) => Promise<AdapterRow[]>;

/**
 * `getDeleteFunction(defName, whereOperators)` — delete every row matching
 * `where`, running `before`/`after` around each one.
 */
export type AdapterDeleteFunction = (
  where: AdapterWhere,
  options: AdapterQueryOptions,
  before: (instance: AdapterRow) => Promise<AdapterRow> | AdapterRow,
  after: (instance: AdapterRow) => Promise<AdapterRow> | AdapterRow,
) => Promise<AdapterRow[]>;

/**
 * `getRestoreFunction(defName, whereOperators)` — undelete every soft-deleted
 * row matching `where`, running `before`/`after` around each one.
 *
 * The mirror of {@link AdapterDeleteFunction}, and deliberately the same shape,
 * so the engine drives both through one code path. Only an adapter whose
 * backend soft-deletes provides it; see `OrmAdapter.softDeletes`.
 */
export type AdapterRestoreFunction = (
  where: AdapterWhere,
  options: AdapterQueryOptions,
  before: (instance: AdapterRow) => Promise<AdapterRow> | AdapterRow,
  after: (instance: AdapterRow) => Promise<AdapterRow> | AdapterRow,
) => Promise<AdapterRow[]>;
