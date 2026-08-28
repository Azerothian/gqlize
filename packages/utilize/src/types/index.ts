import Events from "../events";
import { DataTypeDescriptor } from "./data-type";
import type { Permission } from "../gate";

// Re-exported so `./types/index` is a complete type barrel: `GqlizeOptions`
// names `Permission`, and the packages that build on these types import both.
export type { Permission, PermissionContext } from "../gate";
// `scope`'s vocabulary. `PortableWhere` is declared in `../gate` rather than
// here so the gate stays importable on its own, but it belongs to this module's
// surface: it is the caller-side counterpart of `AdapterWhere` below.
export type {
  PortableWhere, ScopeOperation, ScopeResult, ScopePredicate, ResolvedScope,
} from "../gate";

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
 * The list arguments `Ormize.resolveFindAll` accepts.
 *
 * Only the cursor keys are named, because `cursorOffset` is the one thing ormize
 * itself reads off the bag; everything else — `where`, `orderBy`, `first`,
 * `include`, and whatever vocabulary a backend adds — is forwarded verbatim to
 * `adapter.processListArgsToOptions`, whose own `args` parameter is equally open.
 * Naming *only* the cursor keys and nothing else would make this a weak type, and
 * TypeScript rejects a weak type outright when the value shares no key with it —
 * which is every caller that passes just `where` and `first`.
 */
export type FindAllArgs = {
  after?: { index: number };
  before?: { index: number };
  limit?: number;
  [arg: string]: unknown;
};

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
export type AdapterRelationshipPage = { total: number; models: AdapterRow[] };

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
 * An unmanaged, adapter-native transaction. `handle` is the token threaded onto
 * each operation's options (e.g. a Sequelize Transaction); `commit`/`rollback`
 * finalise it. Returned by `OrmAdapter.beginTransaction`.
 */
export interface AdapterTransaction {
  handle: AdapterTransactionHandle;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * The backend (ORM) adapter contract. This is GraphQL-free — it is the interface
 * `@azerothian/ormize` depends on. The GraphQL-typed extension lives in
 * `./gqlize-adapter` (`GqlizeAdapter extends OrmAdapter`) so importing ormize never
 * pulls `graphql`.
 *
 * Declared with method syntax rather than function-typed properties, and that is
 * deliberate: parameters are then checked bivariantly, which is what an adapter
 * contract wants. A row is `AdapterRow` (`unknown`) *here* because no caller may
 * assume its shape, but the adapter that produced it knows exactly what it is
 * and re-narrows on the way back in (`update(row: Sequelize.Model, ...)`).
 * Property syntax would make every such narrowing an error under
 * `strictFunctionTypes` and push adapters back to `any`.
 */
export interface OrmAdapter {
  adapterName: string;
  createModel(def: Definition, hooks?: HookMap): Promise<Model>;
  /**
   * Register hooks on the adapter's *connection* rather than on a model, for
   * backends that draw that distinction (Sequelize fires `beforeQuery`,
   * `beforeConnect` and friends off the Sequelize instance, and a model never
   * sees them). Called once per adapter from `Ormize.initialise()`.
   *
   * Optional: an adapter with no connection-level hooks — or none at all — omits
   * it, and ormize skips the registration.
   */
  installInstanceHooks?(hooks: HookMap): void;
  /**
   * Whether this adapter fires the model hooks ormize installs, so a row-level
   * scope is re-imposed *below* the engine (§13).
   *
   * Read by §12's build-time audit, and the reason its verdict differs by
   * backend: an adapter with a hook layer has a runtime backstop under every
   * surface the engine cannot see, so an unannotated class method there is a
   * warning. An adapter without one has nothing under it at all, so the same
   * method is an error. Absent means absent — an adapter that ignores hooks says
   * so by saying nothing.
   */
  enforcesRowScope?: boolean;
  getModel(modelName: string): Model;
  getAssociations(defName: string): {[relName: string]: Association};
  getValueFromInstance(model: AdapterRow, sourceKey: string): unknown;
  /**
   * The fields of a created model, as the adapter knows them — which is
   * {@link DefinitionFieldMeta}, not the {@link DefinitionField} a user authors:
   * the adapter fills in `name` and resolves `foreignTarget` from the
   * associations it wired.
   */
  getFields(defName: string): {[fieldName: string]: DefinitionFieldMeta};
  createRelationship(defName: string, modelName: string, relName: string, relType: string, relOptions: Relationship["options"]): unknown;
  getPrimaryKeyNameForModel(modelName: string): string[];
  /**
   * Returns a fetcher for one relationship hop: given the join key's value it
   * resolves the target row(s). Used for cross-adapter relationships, where no
   * native association exists to eager-load through.
   */
  createFunctionForFind(modelName: string): (keyValue: string, filterKey: string, singular: boolean) => ((options: AdapterQueryOptions) => Promise<AdapterRow>);
  reset(options?: AdapterQueryOptions): Promise<void>;
  initialise(): Promise<void>;
  sync(options?: AdapterQueryOptions): Promise<void>;
  hasInlineCountFeature(): boolean;
  findAll(defName: string, options: AdapterQueryOptions): Promise<AdapterRow[]>;
  /** Row count carried alongside the rows by backends that support it (`hasInlineCountFeature`). */
  getInlineCount(models: AdapterRow[]): Promise<number>;
  count(defName: string, options: AdapterQueryOptions): Promise<number>;
  /** `where` may be absent — an operation with no filter — which every adapter reads as "match everything". */
  processFilterArgument(where: AdapterWhere | undefined, whereOperators: WhereOperators | undefined, options: AdapterQueryOptions): AdapterWhere | Promise<AdapterWhere>;
  /**
   * Optional: merge a single equality (or, for array values, membership) filter
   * into an already-processed `where`, returning the combined adapter-native
   * filter. Required for a model to be the *target* of a cross-adapter
   * relationship, which is resolved as a root query scoped to the join key.
   */
  mergeFilterStatement?(fieldName: string, value: unknown, match: boolean | undefined, originalWhere: AdapterWhere | undefined): AdapterWhere;
  /**
   * Optional: AND two already-processed filters together, in the backend's own
   * vocabulary.
   *
   * The generalisation of {@link mergeFilterStatement}, which does the same for
   * a single field condition. Needed where a whole filter has to be re-imposed
   * on options that have already been translated — a `permission.scope`
   * re-asserted after `definition.before` has had the chance to rewrite
   * `where`. An adapter that omits it cannot be scoped behind such a hook, and
   * ormize refuses the query rather than running it unscoped.
   */
  andFilterStatements?(a: AdapterWhere | undefined, b: AdapterWhere | undefined): AdapterWhere | undefined;
  /**
   * Optional: install an extra instance method on an already-defined model. Used
   * to attach cross-adapter relationship accessors to adapters whose "model" is a
   * plain descriptor rather than a class with a prototype.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the method being installed is the definition author's own — its parameters and return are whatever they wrote, and the adapter does nothing but attach it to the model.
  addInstanceFunction?(modelName: string, name: string, fn: (...args: any[]) => any): void;
  /** Apply a patch to one already-fetched row. */
  update(row: AdapterRow, i: FieldValues, defaultOptions: AdapterQueryOptions): Promise<AdapterRow>;
  getCreateFunction(defName: string): AdapterCreateFunction;
  getUpdateFunction(defName: string, whereOperators: WhereOperators | undefined): AdapterUpdateFunction;
  getDeleteFunction(defName: string, whereOperators: WhereOperators | undefined): AdapterDeleteFunction;
  /**
   * Optional: run a callback inside a transaction (auto-commit / auto-rollback).
   * When present, ormize wraps single-adapter multi-step mutations in it.
   * Adapters that cannot provide transactions may omit it — mutations then run
   * without one.
   */
  transaction?<T>(cb: (t: AdapterTransactionHandle) => Promise<T>): Promise<T>;
  /**
   * Optional: begin an UNMANAGED transaction, returning a handle the caller
   * commits or rolls back explicitly. Required for cross-adapter coordination
   * (`orm.transaction`): the coordinator begins one per adapter and commits/rolls
   * back them together. `handle` is the adapter-native transaction token that is
   * threaded onto each operation's options.
   */
  beginTransaction?(): Promise<AdapterTransaction>;
  /** Read: classify an adapter-native type into an abstract `DataTypeDescriptor`. */
  mapDataType(nativeType: NativeDataType): DataTypeDescriptor;
  /** Write: convert an abstract type token/descriptor back to an adapter-native type. */
  toNativeType(descriptor: DataTypeDescriptor): NativeDataType;
  /**
   * Turn list/relationship args into backend fetch options. GraphQL-free: the
   * caller passes a {@link Selection} carrying any selected-field/count hints; the
   * raw execution `info` (if any) rides along on `selection.raw`.
   */
  processListArgsToOptions(defName: string, request: AdapterListRequest): AdapterListOptions | Promise<AdapterListOptions>;
  resolveManyRelationship(defName: string, association: Association, source: AdapterRow, request: AdapterRelationshipRequest): Promise<AdapterRelationshipPage>;
  resolveSingleRelationship(defName: string, association: Association, source: AdapterRow, request: AdapterRelationshipRequest): Promise<AdapterRow>;
}

/**
 * Everything an adapter needs to turn one list request into fetch options.
 *
 * Named fields rather than a positional tail. The 8-parameter form this replaces
 * had already drifted apart in a way the compiler could not see: the contract
 * named `graphQLArgs` at the position every implementation used for `options`,
 * one internal caller passed 6 of the 8 and so silently dropped `selectedFields`
 * and `runHook`, and test call sites carried runs of bare `undefined`.
 */
export interface AdapterListRequest {
  /** The GraphQL-style list args — `where`, `orderBy`, `first`/`last`, `include`. */
  args: {[name: string]: FieldArgs};
  /** Row offset, already resolved from a cursor by the caller. */
  offset?: number;
  /** What the caller wants fetched: selected fields, eager includes, count-only. */
  selection?: Selection;
  /** Per-field operator overrides applied when translating `where`. */
  whereOperators?: WhereOperators;
  /**
   * Caller-supplied base options — the transaction handle, the request context.
   * Values the adapter computes for this request (`attributes`, `include`,
   * `limit`, ...) take precedence: they encode the permission-filtered column
   * list, so letting a caller override them would widen the query.
   */
  options?: AdapterQueryOptions;
  /** Scalar field names to fetch, when the caller has already resolved them. */
  selectedFields?: string[];
  /** Hook dispatcher, so options-building can fire `beforeFind` on eager includes. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- this is the hook *dispatcher*: `value` and the trailing arguments differ per hook name (`beforeFind` gets an options bag, `afterCreate` a row), so it is the one place that cannot know which it is forwarding.
  runHook?: (defName: string, hookName: string, value: any, ...args: any[]) => Promise<any>;
}

/** An {@link AdapterListRequest} for the rows hanging off one parent row. */
export interface AdapterRelationshipRequest extends AdapterListRequest {
  /** Resolve only `total`, skipping the rows. */
  countOnly?: boolean;
  /** The caller's request context (`resolveSingleRelationship` forwards it to hooks). */
  context?: RequestContext;
}

/**
 * What `processListArgsToOptions` returns: the options for the fetch, plus the
 * options for a separate count query on backends without an inline count.
 */
export type AdapterListOptions = {
  getOptions: AdapterQueryOptions;
  countOptions?: AdapterQueryOptions;
};

/**
 * Backend-agnostic description of what a resolver wants fetched. Replaces the
 * GraphQL execution `info` in the ormize engine so the engine stays graphql-free.
 * GraphQL callers (gqlize) populate this from `info`; other callers (e.g. REST)
 * build it directly. `translateFilter`/`translateId` default to identity — gqlize
 * injects relay global-id translation.
 */
export type Selection = {
  /** eager-include plan (relations to JOIN) */
  include?: IncludeMap[];
  /** selected scalar field names */
  fields?: string[];
  /** fetch count without rows */
  countOnly?: boolean;
  /** raw arg variables (caller-provided) */
  variableValues?: {[name: string]: FieldArgs};
  /** opaque passthrough; gqlize stashes the real GraphQLResolveInfo here so hooks still see `info` */
  raw?: unknown;
  /**
   * default identity; gqlize passes replaceIdDeep bound to variableValues.
   * Generic so an absent filter stays absent: a relationship sub-mutation may
   * carry no `where` at all, and translating one is not what supplies it.
   */
  /**
   * `targets` names the type each global key points at (see
   * {@link GlobalKeyTargets}), so the decoder can reject an id minted for another
   * model instead of filtering on its raw pk. Optional: a caller that does not
   * know the targets gets the untyped decode this always did.
   */
  translateFilter?: <W extends AdapterWhere | undefined>(where: W, globalKeys: string[], targets?: GlobalKeyTargets) => W;
  /**
   * default identity; gqlize passes the configured id codec's decode, falling
   * back to the value untouched when it is not one of that codec's ids.
   *
   * `fieldName` is the global key the value arrived on, which is what lets the
   * codec check the id against that key's declared target type.
   */
  translateId?: (value: unknown, fieldName?: string) => unknown;
  /**
   * Query-shaping hooks contributed by the `input` of each selected exposed
   * method. Run after `processListArgsToOptions` **and after
   * `definition.before`**, in selection order, so a method's `input` sees the
   * final options and gets the last word on them.
   *
   * Each returns the params to carry forward; returning nothing keeps the
   * params it was handed (a hook that mutated them in place).
   */
  optionHooks?: OptionHook[];
};

/**
 * A query-shaping hook contributed by an exposed method's `input`, bound to the
 * occurrence it came from. Carried on {@link Selection.optionHooks}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `params` is the adapter-native options bag the hook reshapes and hands back, and the return is that same bag — the backend's vocabulary, not this package's.
export type OptionHook = (params: any, context?: RequestContext) => any | Promise<any>;

/**
 * Descriptor for a single relationship that should be eager-loaded as part of
 * the parent's root query. A superset of what an adapter's include handling
 * consumes (`required`, `where`, `orderBy`, `include`), enriched with pagination
 * and `separate` so collections can be batched at the root with correct
 * per-parent limits.
 *
 * Lives here rather than in gqlize because it is what {@link Selection.include}
 * carries, and `Selection` is the graphql-free hand-off between the two.
 */
export interface IncludeDescriptor {
  target: string;
  associationType: string;
  required?: boolean;
  where?: AdapterWhere;
  orderBy?: OrderEntry[];
  limit?: number;
  offset?: number;
  separate?: boolean;
  include?: IncludeMap[];
}

/** One level of the include plan, keyed by relationship name. */
export interface IncludeMap {
  [relName: string]: IncludeDescriptor;
}

/**
 * An include plan as a definition *declares* it, rather than as the engine
 * carries it. `target` and `associationType` are properties of the relationship,
 * not choices — they are looked up from the live association — so a declaration
 * is just `{items: {}}`, or `{items: {required: true}}` to shape the join.
 */
export interface DeclaredIncludeMap {
  [relName: string]: Partial<IncludeDescriptor>;
}

/**
 * One ORDER BY entry: a column, and the direction to sort it. This is the value
 * carried by a generated `${defName}OrderBy` enum member, so it is what arrives
 * on an `orderBy` argument and what an adapter translates into backend ordering.
 * The direction stays a plain `string` rather than `"ASC" | "DESC"` because a
 * backend may accept more (`NULLS LAST`, a collation), and this type is the
 * hand-off, not the vocabulary.
 */
export type OrderEntry = [column: string, direction: string];

/**
 * What a write does when a row-level scope denies it. Declared here because
 * {@link GqlizeOptions} names it; the behaviour lives in ormize.
 */
export type ScopeMissBehaviour = "empty" | "throw";

/**
 * The type a global key points at, keyed by field name: a primary key targets
 * its own model, a foreign key targets whatever the relationship points at.
 *
 * This is the half {@link globalKeysFromFields} throws away. Without it a decoder
 * has a value and no idea what it is *supposed* to be, so a `Task` id handed to a
 * `Post`-typed foreign key decodes happily and filters on the wrong row.
 */
export type GlobalKeyTargets = {[fieldName: string]: string};

/**
 * How a row's primary/foreign key becomes the opaque id a client sees, and back.
 *
 * Every id gqlize hands out crosses this seam exactly once in each direction, so
 * a codec is the whole vocabulary: swap it and `node(id:)`, `where` filters,
 * mutation inputs and auto-include all speak the new format together. The
 * default (`relayIdCodec`) is base64 `Type:id`, which is what 7.x and every
 * earlier version emitted.
 */
export type IdCodec = {
  /** row value -> the opaque id the client sees. */
  encode(ctx: {type: string; id: string | number; defName: string; fieldName: string}): string;
  /**
   * opaque id -> raw value, or `null` when `value` is not one of this codec's
   * ids — callers leave it untouched rather than corrupting it.
   *
   * That `null` is load-bearing in both directions. A raw primary key typed into
   * a global-key filter or mutation input must survive unchanged (`fromGlobalId`
   * turns `"42"` into `""` without complaining, which is how a raw pk used to be
   * silently written away), and a codec that only recognises its own format is
   * what lets `fallbackCursorCodec`-style layering work for ids too.
   *
   * `type` is the expected target type when the caller knows it (pk: the model;
   * fk: `foreignTarget`); a codec may use it to reject a cross-type id.
   */
  decode(ctx: {value: string; type?: string; defName?: string; fieldName?: string}):
    {type: string; id: string} | null;
  /**
   * False when an id does not carry its type. `node(id:)` cannot work without it
   * — it has nothing but the id to decide which model to fetch — so `createSchema`
   * warns once and omits the `node` field rather than shipping one that returns
   * null for everything.
   *
   * Absent means true: a codec that says nothing is assumed to round-trip the
   * type, which is what every shipped codec but `rawIdCodec` does.
   */
  carriesType?: boolean;
};

/**
 * How a connection's edge position becomes the opaque cursor a client sees.
 *
 * A cursor is not an id: it carries a **connection name and an absolute row
 * index**, not a primary key. `index` must round-trip as an exact integer — it is
 * consumed as arithmetic when deriving `OFFSET`, `hasNextPage` and
 * `hasPreviousPage` — and `connection` must survive too, because a cursor minted
 * by one connection has a meaningless index in another and is rejected on that
 * basis.
 */
export type CursorCodec = {
  encode(ctx: {connection: string; index: number}): string;
  /**
   * `null` for anything this codec did not mint; the caller raises
   * `Invalid cursor`. Codecs never throw and never import `graphql`: one caller
   * turns a failure into a `GraphQLError` and another (the nested-relation
   * offset planner) swallows it, and neither wants the codec to know which.
   *
   * `connection` is the connection asking, when there is one. It is absent where
   * the caller cannot name it — the eager-load planner reads a nested
   * connection's `after`/`before` before that connection's resolver runs — so a
   * codec that checks ownership must only do so when it is given something to
   * check against.
   */
  decode(ctx: {value: string; connection?: string}): {connection: string; index: number} | null;
};

/**
 * What a caller hands the shared id decoder: the codec, and what it knows about
 * the keys being decoded.
 *
 * Travels as a trailing parameter on the adapter contract's `replaceIdIn*` hooks
 * rather than replacing the `variableValues` argument beside it, so an
 * out-of-tree adapter that ignores it keeps working — on the default codec,
 * which is the only format it could have been built against.
 */
export type IdTranslation = {
  /** default: the base64 `Type:id` relay codec */
  codec?: IdCodec;
  /** what each global key points at, so a cross-type id can be rejected */
  targets?: GlobalKeyTargets;
  /** the model the keys belong to; passed to the codec as context only */
  defName?: string;
};

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
}

export type Association = {
  name: string;
  target: string;
  source: string;
  foreignKey: string;
  targetKey: string;
  sourceKey: string;
  associationType: string;
  /**
   * True when source and target live on different adapters. Such a relationship
   * has no native association behind it: it cannot be eager-loaded (no JOIN spans
   * two datastores) and is resolved as a separate query on the target, scoped to
   * the join key.
   */
  crossAdapter?: boolean;
  /**
   * `belongsToMany` only: the join model, and the column on it that points at the
   * target (`foreignKey` points at the source). A cross-adapter `belongsToMany`
   * resolves through this model, so it must be a registered model in its own
   * right rather than an implicit table.
   */
  through?: string;
  otherKey?: string;
  accessors: {
    add: string;
    set: string;
    get: string;
    removeMultiple: string;
    addMultiple: string;
    count: string;
    create: string;
    hasAll: string;
    hasSingle: string;
    remove: string;
  }
}

export enum RelationshipType {
  BelongsTo = "belongsTo",
  HasOne = "hasOne",
  HasMany = "hasMany",
  BelongsToMany = "belongsToMany"
}

export type Relationship = {
  model: string; 
  name: string;
  type: string | RelationshipType;
  target?: string;
  rel?: Association;
  options: {
    as?: string;
    foreignKey?: string;
    sourceKey?: string;
    /** Column on the target a `belongsTo` points at. Defaults to the target's primary key. */
    targetKey?: string;
    constraints?: boolean;
    /** Column on the join model a `belongsToMany` uses to reach the target. */
    otherKey?: string;
    through?: {
      model?: string;
      foreignKey?: string;
      otherKey?: string;
    } | string;
  };
}

export type DefinitionFieldMeta = {
  name?: string;
  /** See {@link DefinitionField.type}. */
  type: unknown;
  foreignKey?: boolean;
  unique?: boolean;
  // Non-unique secondary index marker (see DefinitionField.index).
  index?: boolean;
  primaryKey?: boolean;
  ignoreGlobalKey?: boolean;
  description?: string;
  allowNull?: boolean;
  autoPopulated?: boolean;
  foreignTarget?: string;
  // Opt-in to allow a primary/foreign key to be set from client mutation input.
  // Defaults to false — see `isStructurallyWritable` (mass-assignment guard).
  writable?: boolean;
  resolve?: DefinitionHook;
  args?: FieldArgsConfig;
  comment?: string;
  /** See {@link DefinitionField.deprecated}. Carried through by the adapter. */
  deprecated?: string;
  defaultValue?: FieldValue;
}

export type DefinitionField = {
  /**
   * The field's type token, as authored: a `DataType` member, an adapter-native
   * type, or a GraphQL type. `unknown` rather than `any` because this package is
   * graphql-free and adapter-agnostic — it cannot name the union, and every
   * reader (adapter or gqlize builder) already dispatches on it at runtime.
   */
  type: unknown;
  foreignKey?: boolean;
  unique?: boolean;
  // Marks a field as a (non-unique) secondary index. Adapters that build their
  // own index structures (e.g. the Valkey adapter) use this — alongside `unique`
  // and foreign keys — to decide which fields are searchable.
  index?: boolean;
  primaryKey?: boolean;
  ignoreGlobalKey?: boolean;
  description?: string;
  allowNull?: boolean;
  autoPopulated?: boolean;
  /**
   * Opts a primary key or foreign key back into client-writable mutation input.
   * Both are excluded by default as a mass-assignment / IDOR guard — see
   * {@link isStructurallyWritable}.
   */
  writable?: boolean;
  foreignTarget?: string;
  resolve?: DefinitionHook;
  args?: FieldArgsConfig;
  comment?: string;
  /**
   * Marks the generated field `@deprecated`, with this string as the reason.
   * The central {@link Definition.deprecations} map wins over this when both
   * name the same field, mirroring how `comments.fields` wins over
   * {@link DefinitionField.description}.
   */
  deprecated?: string;
  defaultValue?: FieldValue;
  values?: string[];
  validate?: FieldValidators;
}

/**
 * A field's validation rules, keyed by validator name. The values are `unknown`
 * because each validator takes a different shape — a bare value (`min: 0`), a
 * flag (`isEmail: true`), a pair (`len: [1, 50]`), or the `{args, msg}` wrapper —
 * and it is the consumer that knows which form its own validators use.
 */
export type FieldValidators = {
  [validatorName: string]: unknown;
}

export type DefinitionFields = {
  [name: string]: DefinitionField
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an operator is handed the partially built adapter-native `where`, the adapter's options bag and the client's raw filter value, and returns a backend-shaped fragment. Narrowing the parameters would reject the adapter implementations that legitimately declare their own concrete types for them.
export type WhereOperator = (whereObject: any, options: any, value: any) => Promise<any> | any
export type WhereOperators = {
  [name: string]: WhereOperator
}

/**
 * Context handed to an exposed method's declarative hooks. `source` is the
 * loaded row for `output` (absent for `input`, which runs before any row is
 * fetched); the rest mirror what a resolver sees.
 */
export type ExposedMethodContext = {
  /** The loaded row, for `output`. Absent on the query-building hooks. */
  source?: LoadedRow;
  /** The arguments the field was selected with, after `before`. */
  args?: FieldArgs;
  /** The request context. */
  context?: RequestContext;
  /** The raw GraphQL execution info, when the caller is GraphQL. */
  info?: ExecutionInfo;
  /** The definition the method is declared on. */
  modelDefinition?: Definition;
};

/**
 * How an exposed method contributes a filter to its model's `where` input.
 *
 * The `string` form is portable: it names a real column, and the method's
 * operator object is applied to that column instead. The object form is the
 * adapter-shaped escape hatch — `resolve` is an ordinary
 * {@link WhereOperator}, so it receives `(whereObject, options, value)` where
 * `value` is the operator object the client sent (`{like: "%smith%"}`) and
 * returns a real where-fragment.
 */
export type ExposedMethodWhere = string | {
  /** See {@link DefinitionField.type}. The value type each operator compares against; defaults to `String`. */
  type?: unknown;
  /** Restrict the generated operators to this list. Defaults to the adapter's full vocabulary. */
  operators?: string[];
  resolve: WhereOperator;
};

/**
 * How an exposed method contributes to its model's `orderBy` enum.
 *
 * The `string[]` form is portable: the named columns are ordered in sequence,
 * each in the requested direction. The function form is the adapter-shaped
 * escape hatch and returns the {@link OrderEntry} list to splice in.
 *
 * Both must produce push-down ordering. There is no in-memory post-sort: it
 * would break `first`/`last`, cursor offsets and `total`.
 */
export type ExposedMethodOrderBy =
  | string[]
  | ((direction: string, ctx: ExposedMethodContext) => OrderEntry[]);

/**
 * One entry under `expose.classMethods.{query,mutations}` or
 * `expose.instanceMethods.{query,mutations}`.
 *
 * Beyond the schema shape (`type`/`args`) and the pre/post hooks, an entry may
 * declare what the method *needs loaded* and how it *shapes the query*. Those
 * declarations exist because attribute narrowing projects a query down to the
 * columns the selection set asked for, and an exposed method is a field name,
 * not a column — so the columns it reads off `this` are dropped unless it says
 * which ones they are.
 */
export type ExposedMethod = {
  /**
   * See {@link DefinitionField.type}. Required for every target that produces an
   * output field; unused (and so optional) for `instanceMethods.mutations`,
   * which are pre-commit transforms rather than fields.
   */
  type?: unknown;
  args?: FieldArgsConfig;
  before?: DefinitionHook;
  after?: DefinitionHook;
  /**
   * Columns this method reads off `this`, unioned into the query's projection.
   * `"*"` opts the query out of attribute narrowing entirely.
   *
   * NOTE: these are server-side. `fields: ["passwordHash"]` loads a column the
   * client's own selection set could never reach — the definition author wrote
   * both sides, so that is their call.
   */
  fields?: string[] | "*";
  /** Relations this method reads, merged into (never clobbering) the include plan. */
  include?: DeclaredIncludeMap;
  /**
   * Shape the built query. Receives the same `params` object `definition.before`
   * receives, and runs *after* it — so a method's `input` sees the final options
   * and gets the last word on them. Return the params to use.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `params` is the adapter's own options bag, handed in to be reshaped and returned — the same value `definition.before` receives (see {@link OptionHook}).
  input?: (params: any, ctx: ExposedMethodContext) => any;
  /**
   * Produce or format the field's value from the loaded row. Runs after the
   * method implementation (which receives `undefined` as `value` when there is
   * none — declaring `output` alone is how a field with no implementation
   * works) and before `after`.
   */
  output?: (value: FieldValue, ctx: ExposedMethodContext) => FieldValue;
  /** Contribute `<name>ASC` / `<name>DESC` to the model's `orderBy` enum. */
  orderBy?: ExposedMethodOrderBy;
  /** Contribute a normal nested operator object to the model's `where` input. */
  where?: ExposedMethodWhere;
  /**
   * Marks the field this method generates `@deprecated`, with this string as the
   * reason. Overridden by the matching entry in {@link Definition.deprecations}.
   * For `instanceMethods.mutations` — pre-commit transforms surfaced as fields of
   * the model's `apply` input rather than as query fields — it marks that input
   * field, which is where `comments.instanceMethods` puts the description too.
   */
  deprecated?: string;
};

/** A map of exposed methods, keyed by method name. */
export type ExposedMethods = {
  [name: string]: ExposedMethod;
};

export type Definition = {
  name?: string;
  datasource?: string;
  comment?: string;
  define?: DefinitionFields;
  override?: { 
    [fieldName: string]: {
      description?: string
      /** See {@link DefinitionField.type}. */
      type?: unknown,
      /** See {@link DefinitionField.type}. */
      inputType?: unknown,
      input?: (o: FieldValue, args: FieldArgs, context: RequestContext, info: ExecutionInfo, model: LoadedRow) => FieldValue;
      output?: DefinitionHook
    }
  }; 
  /** Field names excluded from every generated type. */
  ignoreFields?: string[];
  /**
   * Deprecates the model as a whole: the root query list field and the root
   * mutation field for this model are both generated `@deprecated` with this
   * reason. GraphQL cannot deprecate an object type itself, so the mark lands
   * on the fields that lead to it.
   */
  deprecated?: string;
  /** Descriptions to attach to generated fields, keyed by the thing they describe. */
  comments?: DefinitionComments;
  /**
   * Deprecation reasons for generated fields, keyed exactly as
   * {@link Definition.comments} is. A reason here wins over the `deprecated`
   * written on the field or exposed method itself.
   */
  deprecations?: DefinitionDeprecations;
  relationships?: Relationship[];
  whereOperators?: WhereOperators;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each value is the GraphQL input type an operator's argument accepts; a graphql-free package cannot name `GraphQLInputType`, and the schema builder that reads this can.
  whereOperatorTypes?: { [x: string]: any };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `params` is the adapter-native options bag the hook may reshape, and the return is whatever it hands back in its place — both are the backend's/author's vocabulary, not this package's.
  before?: (options: { params: any, model?: LoadedRow, args: FieldArgs, context: RequestContext, info: ExecutionInfo, modelDefinition: Definition, type: Events}) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `result` is whatever the operation produced — a row, a list of rows, a count — and the return is whatever the hook substitutes for it.
  after?: (options: { result: any, args: FieldArgs, context: RequestContext, info: ExecutionInfo, modelDefinition: Definition, type: Events}) => any;
  expose?: {
    classMethods?: {
      query?: ExposedMethods;
      mutations?: ExposedMethods;
    },
    instanceMethods?: {
      query?: ExposedMethods;
      /**
       * Pre-commit transforms, not a second mutation surface: each entry is a
       * custom function that reshapes the data on its way to the write, with the
       * row (update) or the pending values (create) as `this`. Surfaced as the
       * `apply` argument on the model's mutation field.
       */
      mutations?: ExposedMethods;
    }
  }
  instanceMethods?: {
    [name: string]: DefinitionMethod;
  }
  classMethods?: {
    [name: string]: DefinitionMethod;
  }
  hooks?: HookMap;
  options?: DefinitionOptions
};

export interface DefinitionOptions {
  /**
   * Whatever ormize does not name here is handed to the adapter's model
   * constructor verbatim — `timestamps`, `paranoid`, `tableName` and the rest of
   * the backend's own model options. There is no closed list because that set
   * belongs to the backend, not to ormize.
   */
  [option: string]: unknown;
  hooks?: HookMap;
  /**
   * When false, disables root-level eager resolution (auto-generated include tree)
   * for this model, falling back to per-relation resolution. Defaults to enabled.
   */
  autoInclude?: boolean;
  instanceMethods?: {
    [name: string]: DefinitionMethod;
  }
  classMethods?: {
    [name: string]: DefinitionMethod;
  }
}

/** See {@link Definition.comments}. */
export type DefinitionComments = {
  fields?: { [fieldName: string]: string };
  classMethods?: { [methodName: string]: string };
  /**
   * Deprecates the `apply` input field for each instance-method *transform* —
   * the same set `comments.instanceMethods` describes. An instance-method
   * *query* field deprecates through `fields`, since that is where its
   * description comes from too.
   */
  instanceMethods?: { [methodName: string]: string };
}

/**
 * See {@link Definition.deprecations}. Deliberately the same shape as
 * {@link DefinitionComments}: `fields` covers columns, overrides and
 * relationship names alike, because that is the one namespace generated output
 * fields share.
 */
export type DefinitionDeprecations = {
  fields?: { [fieldName: string]: string };
  classMethods?: { [methodName: string]: string };
  instanceMethods?: { [methodName: string]: string };
}

export type Definitions = {
  [name: string]: Definition
}

/**
 * An adapter's model handle — a Sequelize `ModelStatic`, a descriptor object,
 * whatever the backend registers. Indexed by name because adapters install
 * relationship accessors and definition methods onto it dynamically, which is
 * the whole reason it cannot be described more tightly here.
 */
export type Model = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapters install relationship accessors and definition methods onto the model handle at runtime, so its members are not knowable here (see the docblock above); `unknown` would make every `model.someAccessor(...)` in an adapter a compile error.
  [name: string]: any
  /**
   * Present on a class-based adapter's model (Sequelize's `ModelStatic`) and
   * absent on one whose model is a plain descriptor. Ormize tests for it before
   * installing a cross-adapter accessor and falls back to
   * {@link OrmAdapter.addInstanceFunction}, which is the whole reason that method
   * exists — so it has to be optional here or a descriptor-model adapter cannot
   * satisfy this contract at all.
   *
   * `object`, not a keyed record: Sequelize types its prototype as a `Model`,
   * which has no index signature, so a keyed record excludes the one adapter
   * that definitely has a prototype. The single place that installs a method by
   * name narrows it there instead — as the sequelize adapter's own `prototypeOf`
   * helper already does.
   */
  prototype?: object
}

export type HookMap = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each hook name has its own call signature — `beforeCreate(values, options)`, `afterFind(rows)` — fixed by the adapter that fires it, so a single parameter list would be wrong for most of them.
  [hookName: string]: ((...args: any) => any)[] |((...args: any) => any)
}

export * from "./orm";
export * from "./data-type";