/**
 * The backend adapter contract (`OrmAdapter`) and the types its methods use —
 * transaction handles, CRUD function signatures, and initialisation options.
 */

import type { DataTypeDescriptor } from "./data-type";
import type {
  AdapterTransactionHandle,
  NativeDataType,
  AdapterWhere,
  AdapterQueryOptions,
  FieldValues,
  AdapterRow,
  AdapterRelationshipPage,
  AdapterCreateFunction,
  AdapterUpdateFunction,
  AdapterDeleteFunction,
  AdapterRestoreFunction,
} from "./primitives";
import type {
  Definition,
  DefinitionFieldMeta,
  Model,
  HookMap,
  WhereOperators,
} from "./definitions";
import type { Association } from "./relationships";
import type {
  Selection,
  AdapterListRequest,
  AdapterRelationshipRequest,
  AdapterListOptions,
} from "./selection";

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
 * Options for `Ormize.initialise()` and, forwarded unchanged, `OrmAdapter.initialise()`.
 */
export interface InitialiseOptions {
  /**
   * Whether the adapter may issue DDL while initialising. Defaults to `true`.
   *
   * `false` is for a build that has no database to issue it against — generating
   * a GraphQL schema reads model metadata only, so the whole relationship and
   * join-model wiring still has to happen, but nothing needs a connection. The
   * one exception is a definition carrying raw create/drop DDL (Sequelize's
   * `definition.queries`), which is exactly what this turns off.
   *
   * An instance initialised this way can build a schema; it cannot serve a
   * request against a database that was never migrated.
   */
  ddl?: boolean;
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
  /**
   * Whether the adapter applies an include plan as a JOIN. Default `true`.
   * An adapter that sets `false` (Valkey) never reads `include`, so ormize
   * applies every `required` relation of its models itself, as a key filter on
   * the parent (`engine/required-filter.ts`), as it does for a cross-adapter
   * relation on any adapter.
   */
  readonly supportsJoins?: boolean;
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
   * The row as this adapter's own instance: returned unchanged when it already
   * is one, otherwise an instance built over its values.
   *
   * A class or instance method can return plain objects typed as a model, and
   * gqlize then runs a field's `resolve`, an `override.output` or an instance
   * method on them — code written against real rows (`row.get(...)`, a
   * relationship accessor). Optional: an adapter whose rows are already plain
   * objects has nothing to build.
   */
  asInstance?(defName: string, row: AdapterRow): AdapterRow;
  /**
   * The fields of a created model, as the adapter knows them — which is
   * {@link DefinitionFieldMeta}, not the {@link DefinitionField} a user authors:
   * the adapter fills in `name` and resolves `foreignTarget` from the
   * associations it wired.
   */
  getFields(defName: string): {[fieldName: string]: DefinitionFieldMeta};
  createRelationship(defName: string, modelName: string, relName: string, relType: string, relOptions: import("./relationships").Relationship["options"]): unknown;
  getPrimaryKeyNameForModel(modelName: string): string[];
  /**
   * Returns a fetcher for one relationship hop: given the join key's value it
   * resolves the target row(s). Used for cross-adapter relationships, where no
   * native association exists to eager-load through.
   */
  createFunctionForFind(modelName: string): (keyValue: string, filterKey: string, singular: boolean) => ((options: AdapterQueryOptions) => Promise<AdapterRow>);
  reset(options?: AdapterQueryOptions): Promise<void>;
  initialise(options?: InitialiseOptions): Promise<void>;
  sync(options?: AdapterQueryOptions): Promise<void>;
  hasInlineCountFeature(): boolean;
  findAll(defName: string, options: AdapterQueryOptions): Promise<AdapterRow[]>;
  /** Row count carried alongside the rows by backends that support it (`hasInlineCountFeature`). */
  getInlineCount(models: AdapterRow[]): Promise<number>;
  /**
   * Optional: the rows a `findAll(defName, options)` returned, as plain values
   * that can go through JSON. Should hold the stored values, not getter
   * output, along with anything `restoreRows` needs to rebuild what the
   * resolvers read: eager-loaded relations, an inline count column.
   *
   * The read cache stores rows only for an adapter that implements this
   * together with `restoreRows`. Without them it still caches `count`.
   */
  snapshotRows?(defName: string, rows: AdapterRow[], options: AdapterQueryOptions): unknown[];
  /**
   * Optional: rows rebuilt from a `snapshotRows` result, as indistinguishable as
   * possible from what `findAll` with the same `options` would have returned.
   * Each call must hand back fresh rows, because callers are free to mutate them.
   */
  restoreRows?(defName: string, snapshot: unknown[], options: AdapterQueryOptions): AdapterRow[];
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
   * Optional: whether this model soft-deletes — a delete marks the row rather
   * than removing it, so deleted rows are still there to be read back or
   * undeleted.
   *
   * Optional exactly as {@link OrmAdapter.mergeFilterStatement} is: absent means
   * "this backend has no soft delete", and every `deleted` argument and root
   * `restore` mutation is then simply not generated. An adapter that reports
   * `true` must also provide {@link OrmAdapter.getRestoreFunction} and honour a
   * `deleted` value on the list requests it is handed.
   */
  softDeletes?(defName: string): boolean;
  /**
   * Optional: the counterpart of {@link OrmAdapter.getDeleteFunction} for a model
   * that soft-deletes. Required only for a model whose `softDeletes` is `true`.
   */
  getRestoreFunction?(defName: string, whereOperators: WhereOperators | undefined): AdapterRestoreFunction;
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
