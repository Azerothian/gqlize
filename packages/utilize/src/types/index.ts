import Events from "../events";
import { DataTypeDescriptor } from "./data-type";
import type { Permission } from "../gate";

// Re-exported so `./types/index` is a complete type barrel: `GqlizeOptions`
// names `Permission`, and the packages that build on these types import both.
export type { Permission, PermissionContext } from "../gate";

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
export type AdapterWhere = { [key: string | symbol]: any };

/**
 * The options bag threaded through a backend operation: `where`, `limit`,
 * `offset`, `order`, `include`, the transaction token, and whatever else the
 * adapter understands. Produced by `processListArgsToOptions` and merged along
 * the way, so it stays open by design.
 */
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
export type RequestContext = any;

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
export type AdapterCreateFunction = (input: {[field: string]: any}, options: AdapterQueryOptions) => Promise<AdapterRow>;

/**
 * `getUpdateFunction(defName, whereOperators)` — update every row matching
 * `where`. `processInput` is called per matched row and returns the patch to
 * apply, so a hook can derive it from the row's current state.
 */
export type AdapterUpdateFunction = (
  where: AdapterWhere,
  processInput: (instance: AdapterRow) => Promise<{[field: string]: any}> | {[field: string]: any},
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
   * Optional: install an extra instance method on an already-defined model. Used
   * to attach cross-adapter relationship accessors to adapters whose "model" is a
   * plain descriptor rather than a class with a prototype.
   */
  addInstanceFunction?(modelName: string, name: string, fn: (...args: any[]) => any): void;
  /** Apply a patch to one already-fetched row. */
  update(row: AdapterRow, i: {[field: string]: any}, defaultOptions: AdapterQueryOptions): Promise<AdapterRow>;
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
  args: {[name: string]: any};
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
  variableValues?: {[name: string]: any};
  /** opaque passthrough; gqlize stashes the real GraphQLResolveInfo here so hooks still see `info` */
  raw?: unknown;
  /**
   * default identity; gqlize passes replaceIdDeep bound to variableValues.
   * Generic so an absent filter stays absent: a relationship sub-mutation may
   * carry no `where` at all, and translating one is not what supplies it.
   */
  translateFilter?: <W extends AdapterWhere | undefined>(where: W, globalKeys: string[]) => W;
  /** default identity; gqlize passes v => fromGlobalId(v).id */
  translateId?: (value: unknown) => unknown;
};

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
 * One ORDER BY entry: a column, and the direction to sort it. This is the value
 * carried by a generated `${defName}OrderBy` enum member, so it is what arrives
 * on an `orderBy` argument and what an adapter translates into backend ordering.
 * The direction stays a plain `string` rather than `"ASC" | "DESC"` because a
 * backend may accept more (`NULLS LAST`, a collation), and this type is the
 * hand-off, not the vocabulary.
 */
export type OrderEntry = [column: string, direction: string];

export type GqlizeOptions = {
  /** Hooks applied to every model, keyed by hook name — see {@link HookMap}. */
  globalHooks?: HookMap
  /**
   * The predicate bag gating what gets generated. Closed by design — see
   * {@link Permission} in `../gate` for why a typo has to be a compile error.
   */
  permission?: Permission,
  extend?: any,
  root?: any,
  subscriptions?: any
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
  resolve?: any;
  args?: any;
  comment?: string;
  defaultValue?: any;
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
  resolve?: any;
  args?: any;
  comment?: string;
  defaultValue?: any;
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
export type WhereOperator = (whereObject: any, options: any, value: any) => Promise<any> | any
export type WhereOperators = {
  [name: string]: WhereOperator
}

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
      input?: (o: any, args: any, context: any, info: any, model: any) => any;
      output?: any
    }
  }; 
  /** Field names excluded from every generated type. */
  ignoreFields?: string[];
  /** Descriptions to attach to generated fields, keyed by the thing they describe. */
  comments?: DefinitionComments;
  relationships?: Relationship[];
  whereOperators?: WhereOperators;
  whereOperatorTypes?: { [x: string]: any };
  before?: (options: { params: any, model?: any, args: any, context: any, info: any, modelDefinition: Definition, type: Events}) => any;
  after?: (options: { result: any, args: any, context: any, info: any, modelDefinition: Definition, type: Events}) => any;
  expose?: {
    classMethods?: {
      query?: {
        [name: string]: {
          /** See {@link DefinitionField.type}. */
          type: unknown;
          args?: any;
          before?: any;
          after?: any;
        }
      }
      mutations?: {
        [name: string]: {
          /** See {@link DefinitionField.type}. */
          type: unknown;
          args?: any;
          before?: any;
          after?: any;
        }
      }
    },
    instanceMethods?: {
      query?: {
        [name: string]: {
          /** See {@link DefinitionField.type}. */
          type: unknown;
          args?: any;
          before?: any;
          after?: any;
        }
      }
      mutations?: {
        [name: string]: {
          /** See {@link DefinitionField.type}. */
          type: unknown;
          args?: any;
          before?: any;
          after?: any;
        }
      }

    }
  }
  instanceMethods?: {
    [name: string]: (this: any, args?: any, context?: any) => any;
  }
  classMethods?: {
    [name: string]: (this: any, args?: any, context?: any) => any;
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
    [name: string]: (this: any, args?: any, context?: any) => any;
  }
  classMethods?: {
    [name: string]: (this: any, args?: any, context?: any) => any;
  }
}

/** See {@link Definition.comments}. */
export type DefinitionComments = {
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
  [hookName: string]: ((...args: any) => any)[] |((...args: any) => any)
}

export * from "./orm";
export * from "./data-type";