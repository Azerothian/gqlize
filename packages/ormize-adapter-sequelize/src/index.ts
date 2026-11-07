// The SequelizeAdapter class: the public surface of this package. Each
// non-trivial method delegates to a free function in a cohesive module —
// model-creation, introspection, relationships, id-translation, reads, writes,
// and query-options — keeping this file a thin routing layer.

import {
  ModelAttributes,
  ModelCtor,
  Model,
  Op,
  Sequelize,
} from "sequelize";
import { isFieldExposed } from "@azerothian/utilize/gate";
import typeMapper from "./type-mapper";
import { replaceDefWhereOperators } from "./utils/where-operators";
import { computedOrderableFields as computedOrderableFieldsFor } from "@azerothian/utilize/exposed-methods";
import { copyDefine, copyModelOptions } from "@azerothian/utilize/utils/copy-on-write";

import { type QueryTypeConfig } from "@azerothian/graphql-types/query";
import {
  clearPermissionDerivedMeta,
  getDefaultListArgs,
  getFilterGraphQLType,
  getIncludeGraphQLType,
  getOrderByGraphQLType,
} from "@azerothian/graphql-types/adapter-args";
import {
  CORE_VALUE_FUNCS,
  REGEX_VALUE_FUNCS,
  SQL_ARRAY_FUNCS,
  SQL_ARRAY_VALUES,
} from "@azerothian/graphql-types/operators";

import {
  GraphQLBoolean,
  GraphQLID,
  type GraphQLInputType,
} from "graphql";
import {
  type AdapterCreateFunction,
  type AdapterDeleteFunction,
  type AdapterListOptions,
  type AdapterListRequest,
  type AdapterQueryOptions,
  type AdapterRelationshipRequest,
  type AdapterRelationshipPage,
  type AdapterRestoreFunction,
  type AdapterTransaction,
  type AdapterTransactionHandle,
  type AdapterUpdateFunction,
  type AdapterWhere,
  type Association,
  type DataTypeDescriptor,
  type Definition,
  type DefinitionFieldMeta,
  type DeletedFilter,
  type HookMap,
  type IncludeMap,
  type InitialiseOptions,
  type NativeDataType,
  type Permission,
  type Relationship,
  type Selection,
  type IdTranslation,
  type WhereOperators,
} from '@azerothian/utilize/types/index';
import type { GqlizeAdapter } from '@azerothian/gqlize/types/gqlize-adapter';
import { mapDataType as mapDataTypeImpl, toNativeType as toNativeTypeImpl } from "./data-type-mapper";
import { SequelizeDefinition } from "./types";
import type {
  RunHook,
  SequelizeModelClass,
  SequelizeOrder,
  SequelizeOrderPrefix,
  SequelizeRow,
} from "./types/query";
import {
  INLINE_COUNT_EXPRESSION,
  processIncludeStatement,
  processListArgsToOptions,
} from "./query-options";
// The query-shape types moved to `./types/query` so the option builders could be
// built over them; they stay exported from here, which is where they have always
// been imported from.
export type * from "./types/query";
import { replaceWhereOperators, normalizeWhereForDialect } from "./utils/where-ops";
import { fixNestedThroughJoin, keepNestedJoinsOutOfSubQuery } from "./utils/nested-subquery";

// Re-export types that were declared in this file and are part of the public surface.
export type { SequelizeAdapterOptions, SequelizeConnection, AuthoredAttributes } from "./adapter-types";

// Pagination safety bounds — re-exported as they have been part of this
// package's public surface since the backstop landed.
export {DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE} from "@azerothian/utilize/utils/page-size";

// --- Delegated module imports ---
import {
  prototypeOf,
  staticsOf,
  createModelImpl,
  createSQLFunctionImpl,
  generateSQLFunctionImpl,
  resolveAttributeTypesImpl,
} from "./model-creation";
import {
  getFieldsImpl,
  getAssociationsImpl,
} from "./introspection";
import {
  createRelationshipImpl,
  createFunctionForFindImpl,
} from "./relationships";
import {
  getGlobalKeysImpl,
  replaceIdInWhereImpl,
  replaceIdInIncludeImpl,
  replaceIdInArgsImpl,
} from "./id-translation";
import {
  findAllImpl,
  countImpl,
  snapshotRowsImpl,
  restoreRowsImpl,
  resolveSingleRelationshipImpl,
  countRelationshipImpl,
  resolveManyRelationshipImpl,
  getInlineCountImpl,
  asInstanceImpl,
} from "./reads";
import {
  getCreateFunctionImpl,
  getUpdateFunctionImpl,
  getDeleteFunctionImpl,
  getRestoreFunctionImpl,
} from "./writes";
import { rowFields, isEmptyWhere, mergeFilterStatement as mergeFilterStatementImpl } from "./row-helpers";

import type { SequelizeAdapterOptions, SequelizeConnection } from "./adapter-types";

export default class SequelizeAdapter implements GqlizeAdapter {
  adapterName: string;
  sequelize: Sequelize;
  options: SequelizeAdapterOptions;
  startup: { drop: string; create: string };
  meta: { [modelName: string]: { [key: string]: unknown } };
  /**
   * Phantom brand identifying the typesystem base URI for this adapter. Never
   * set at runtime; `BaseOf<SequelizeAdapter>` reads it so `db.define(...)`
   * produces Sequelize-typed models. See `./types/orm`.
   */
  declare readonly __base?: import("./types/orm").IORSequelizeModel;
  constructor(adapterOptions: SequelizeAdapterOptions = {}, ...config: SequelizeConnection) {
    //allows the adaptor to have the same config options as sequelize
    this.adapterName = "sequelize";
    // See {@link SequelizeConnection}: the spread goes through a single-signature
    // view of the constructor because the overload set cannot resolve one.
    const SequelizeCtor = Sequelize as unknown as new (...args: SequelizeConnection) => Sequelize;
    this.sequelize = new SequelizeCtor(...config);
    // On the instance, so it runs for every model's find — native calls
    // included — rather than only the queries this adapter builds.
    this.sequelize.addHook("beforeFindAfterOptions", "ormize:nested-subquery", keepNestedJoinsOutOfSubQuery);
    fixNestedThroughJoin(this.sequelize.getQueryInterface().queryGenerator);
    // A paginated `separate` hasMany is loaded with Sequelize's grouped limit:
    // one `ORDER BY … LIMIT` subquery per parent, glued with UNION. Sequelize
    // drops the outer ORDER BY unless the dialect says it needs one, so each
    // parent's page came back in whatever order the UNION produced — on SQLite
    // a plain UNION, which reorders. Ordering the outer select by the same keys
    // keeps every parent's rows in order: a subsequence of a sorted list is
    // sorted. An own property on this instance's dialect, so the shared
    // prototype — and every other Sequelize in the process — is untouched.
    const dialect = (this.sequelize as unknown as {dialect: {supports: Record<string, unknown>}}).dialect;
    dialect.supports = {...dialect.supports, topLevelOrderByRequired: true};
    // The caller's adapter options are theirs. `defaultAttr` matters most: it is
    // spread into *every* model, so one shared descriptor object was normalised
    // and stamped by each model in turn, the last one winning the `Model`
    // back-reference. `resolveAttributeTypes` gives each model its own copy of
    // the merged result; this stops the caller's originals being reachable at all.
    this.options = {
      ...adapterOptions,
      ...(adapterOptions.defaultAttr ? { defaultAttr: copyDefine(adapterOptions.defaultAttr) } : {}),
      ...(adapterOptions.defaultModel ? { defaultModel: copyModelOptions(adapterOptions.defaultModel) } : {}),
    };
    this.startup = {
      drop: "",
      create: "",
    };
    this.meta = {};
  }
  /**
   * Replay the raw DDL that definitions registered through `definition.queries`.
   *
   * This is the only connection this adapter opens before a query is actually
   * run — `sequelize.define` and the association calls are pure metadata — so
   * `ddl: false` is what makes an offline `createSchema` / `gqlize build`
   * possible for definitions that carry DDL. The resulting instance can build a
   * schema and nothing more; the types it would have created do not exist.
   */
  initialise = async (options?: InitialiseOptions) => {
    if (options?.ddl === false || this.startup.create === "") {
      return;
    }
    await this.getORM().query(this.startup.create);
  };
  sync = async (options?: AdapterQueryOptions) => {
     await this.getORM().sync(options);
  };
  reset = async (options?: AdapterQueryOptions) => {
    if (this.startup.drop !== "") {
      await this.getORM().query(this.startup.drop);
    }
    await this.getORM().sync({ force: true, ...(options || {}) });
    if (this.startup.create !== "") {
      await this.getORM().query(this.startup.create);
    }
  };
  getORM = () => {
    return this.sequelize;
  };
  /**
   * Run `cb` inside a managed Sequelize transaction: it auto-commits when the
   * callback resolves and auto-rolls-back if it throws. The transaction is
   * threaded to nested queries via the resolve context (see the ormize manager),
   * so a multi-step mutation either fully applies or fully rolls back.
   */
  transaction = <T>(cb: (t: AdapterTransactionHandle) => Promise<T>): Promise<T> => {
    return this.sequelize.transaction(cb);
  };
  /**
   * Begin an UNMANAGED Sequelize transaction (no callback): the returned handle
   * is committed/rolled back explicitly by the cross-adapter coordinator. The
   * `handle` is a Sequelize `Transaction`, threaded onto operation options as
   * `{ transaction }`.
   */
  beginTransaction = async (): Promise<AdapterTransaction> => {
    const t = await this.sequelize.transaction();
    return {
      handle: t,
      commit: () => t.commit(),
      rollback: () => t.rollback(),
    };
  };
  // `OrmAdapter.addInstanceFunction` declares `fn` with this exact permissive
  // signature (an arbitrary user-authored function), so narrowing it here would
  // reject implementations the published contract still promises to accept.
  addInstanceFunction = (
    modelName: string,
    funcName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches OrmAdapter.addInstanceFunction's published signature
    func: (...args: any[]) => any
  ) => {
    prototypeOf(this.sequelize.models[modelName])[funcName] = func;
  };

  // Mirrors `addInstanceFunction` above (statics instead of the prototype); kept
  // just as permissive so the two stay interchangeable for callers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see addInstanceFunction above
  addStaticFunction = (modelName: string, funcName: string, func: (...args: any[]) => any) => {
    staticsOf(this.model(modelName))[funcName] = func;
  };
  getModel = (modelName: string) => {
    return this.sequelize.models[modelName];
  };
  getModels = (): { [modelName: string]: ModelCtor<Model> } => {
    return this.sequelize.models;
  };
  /** {@link getModel}, seen through the statics this adapter installs — see {@link SequelizeModelClass}. */
  private model = (modelName: string): SequelizeModelClass => {
    return this.sequelize.models[modelName] as SequelizeModelClass;
  };
  /** Lazily initialise and return the per-model meta bag. */
  private ensureMeta = (modelName: string): { [key: string]: unknown } => {
    if (!this.meta[modelName]) {
      this.meta[modelName] = {};
    }
    return this.meta[modelName];
  };
  getMetaObj = <T>(modelName: string, metaName: string): T => {
    return this.ensureMeta(modelName)[metaName] as T;
  };
  setMetaObj = (modelName: string, metaName: string, value: unknown) => {
    this.ensureMeta(modelName)[metaName] = value;
  };
  getTypeMapper = () => {
    return typeMapper;
  };
  getFields = (modelName: string): { [fieldName: string]: DefinitionFieldMeta } => {
    return getFieldsImpl(this, modelName);
  };
  getAssociations = (modelName: string): { [relName: string]: Association } => {
    return getAssociationsImpl(this, modelName);
  };
  getAssociation = (modelName: string, assocName: string) => {
    const rels = this.getAssociations(modelName);
    return rels[assocName];
  };
  /** Read: classify a native Sequelize DataType instance into an abstract descriptor. */
  mapDataType = (nativeType: NativeDataType): DataTypeDescriptor => mapDataTypeImpl(nativeType);
  /** Write: convert an abstract type descriptor/token into a native Sequelize DataType. */
  toNativeType = (descriptor: DataTypeDescriptor): NativeDataType => toNativeTypeImpl(descriptor);
  /**
   * Convert any authored abstract ormize type tokens in an attribute map to
   * native Sequelize types. Native types (e.g. `Sequelize.STRING`) and fields
   * without a token `type` pass through unchanged (backward compatible).
   */
  resolveAttributeTypes = (attributes: import("./adapter-types").AuthoredAttributes): ModelAttributes => {
    return resolveAttributeTypesImpl(this.toNativeType, attributes);
  };
  /**
   * The model hooks ormize installs do fire here, which is what §13's
   * enforcement layer is built on and what makes §12's audit a warning rather
   * than an error on this backend.
   */
  enforcesRowScope = true;
  /**
   * Sequelize-instance hooks go on the Sequelize object itself. Routing them
   * through `sequelize.define` — which accepts the names without complaint —
   * files them under `Model.options.hooks`, where `runHooks` will never look:
   * hooks propagate model → instance, never the reverse. See #45.
   */
  installInstanceHooks = (hooks: HookMap) => {
    Object.keys(hooks).forEach((hookName) => {
      const hook = hooks[hookName];
      if (typeof hook === "function") {
        this.sequelize.addHook(hookName as never, hook as never);
      }
    });
  };

  createModel = async (def: SequelizeDefinition, hooks?: HookMap): Promise<SequelizeModelClass> => {
    return createModelImpl(this, def, hooks, (sqlFunc, scopeModel) =>
      this.generateSQLFunction(sqlFunc, scopeModel));
  };
  /**
   * @param modelName the model rows are mapped onto, which is often absent.
   * @param scopeModel the model whose row-level scope this statement is bound
   *   to (§12) — the definition the class method was installed on, not the one
   *   results are mapped to. Those are usually the same and need not be: a
   *   statement mapped onto nothing at all is still a read of *some* model.
   */
  createSQLFunction = async (query: string, modelName: string | undefined, args: string[], scopeModel?: string) => {
    return createSQLFunctionImpl(this.sequelize, query, modelName, args, scopeModel);
  };
  generateSQLFunction = async (sqlFunc: import("./types").SqlClassMethod, scopeModel?: string) => {
    return generateSQLFunctionImpl(this.sequelize, sqlFunc, scopeModel);
  };
  // Permission object captured at schema-build time. The GraphQL filter/order/
  // include type builders below fall back to it when no explicit permission is
  // threaded through, so denied fields/relationships are consistently excluded
  // regardless of which build path reaches a given model first.
  _buildPermission: Permission | undefined = undefined;
  setBuildPermission = (permission: Permission | undefined) => {
    if (permission !== this._buildPermission) {
      // A second schema built off this adapter under a different permission must
      // not be handed the previous build's types. `fields`/`associations` are
      // permission-independent and deliberately survive.
      clearPermissionDerivedMeta(this.meta);
    }
    this._buildPermission = permission;
  };

  createQueryConfig = (definition: SequelizeDefinition, permission?: Permission): QueryTypeConfig => {
    const defName = definition.name;
    if(!defName) {
      throw new Error("no name set");
    }
    const perm = permission !== undefined ? permission : this._buildPermission;
    const fields = this.getFields(defName);
    // Only expose permission-allowed fields as filterable. Otherwise a field
    // hidden from the output type (e.g. a password hash) stays filterable and a
    // client can binary-search its value from row counts (boolean oracle).
    let f = Object.keys(fields).reduce((o, k) => {
      const field = fields[k];
      if (!isFieldExposed(definition, perm, defName, k)) {
        return o;
      }
      if (field.primaryKey || field.foreignKey) {
        o[k] = GraphQLID;
      } else {
        o[k] = this.getTypeMapper()(
          field.type,
          `GQLTWhere${definition.name}`,
          k
        );
      }
      return o;
    }, {} as { [fieldName: string]: GraphQLInputType });
    const rels = this.getAssociations(defName);
    f = Object.keys(rels).reduce((o, k) => {
      const field = rels[k];
      switch (field.associationType) {
        case "belongsTo":
          if (isFieldExposed(definition, perm, defName, field.foreignKey)) {
            o[field.foreignKey] = GraphQLID;
          }
          break;
      }
      return o;
    }, f);

    let iso = {} as { [operatorName: string]: GraphQLInputType };
    if (definition.whereOperators) {
      iso = Object.keys(definition.whereOperators).reduce((o, k) => {
        const declared = definition.whereOperatorTypes?.[k];
        // `whereOperatorTypes` is the author's own map of operator -> GraphQL
        // type; `Definition` leaves its values open because it must not name a
        // graphql type, so it is narrowed here, where it is read.
        o[k] = (declared as GraphQLInputType) || GraphQLBoolean;
        return o;
      }, iso);
    }
    return {
      modelName: defName,
      fields: f,
      isolatedFields: iso,
      valueFuncs: [
        ...CORE_VALUE_FUNCS,
        // Regex operators are opt-in: see `REGEX_VALUE_FUNCS` for why.
        ...(this.options.enableRegexpOperators ? REGEX_VALUE_FUNCS : []),
      ],
      arrayFuncs: [...SQL_ARRAY_FUNCS],
      arrayValues: [...SQL_ARRAY_VALUES],
    };
  };
  createRelationship = (
    targetModel: string,
    sourceModel: string,
    name: string,
    type: string,
    options: Relationship["options"] = {}
  ) => {
    createRelationshipImpl(this.sequelize, targetModel, sourceModel, name, type, options);
  };
  createFunctionForFind = (modelName: string) => {
    return createFunctionForFindImpl(this.sequelize, modelName);
  };
  getPrimaryKeyNameForModel = (modelName: string) => {
    const model = this.sequelize.models[modelName];
    if ((model.primaryKeyAttributes || []).length > 0) {
      return [...model.primaryKeyAttributes];
    }
    return [this.sequelize.models[modelName].primaryKeyAttribute];
  };
  getValueFromInstance(data: SequelizeRow, keyName: string) {
    const fields = rowFields(data);
    if (fields.dataValues) {
      return fields.dataValues[keyName];
    }
    return fields[keyName];
  }
  // --- `AdapterArgsHost`: what the shared argument builders reach into. ---
  /** The SQL filter vocabulary and its belongsTo-FK pass are this adapter's own. */
  queryConfigFor = (defName: string, definition?: Definition, permission?: Permission): QueryTypeConfig =>
    this.createQueryConfig((definition ?? this.targetOf(defName)?.definition) as SequelizeDefinition, permission);
  orderableFields = (defName: string): string[] => Object.keys(this.getFields(defName));
  /** Computed sorts are declared on the definition; the shared builder stays definition-blind. */
  computedOrderableFields = (defName: string, permission?: Permission): string[] =>
    computedOrderableFieldsFor(this.targetOf(defName)?.definition, defName, permission !== undefined ? permission : this._buildPermission);
  relationshipsOf = (defName: string, definition?: Definition): Relationship[] =>
    (definition?.relationships || []);
  /**
   * A relationship whose target lives on another adapter has no Sequelize model
   * here and no JOIN can reach it, so it is not includable — it is resolved by
   * the target's own adapter as a separate query.
   */
  targetOf = (modelName: string) => {
    const model = this.getModel(modelName) as SequelizeModelClass | undefined;
    return model ? {name: model.name, definition: model.definition} : undefined;
  };
  /**
   * The model's soft-delete column, or `undefined` when it does not soft-delete.
   *
   * Both halves are checked, and that is not belt-and-braces: Sequelize accepts
   * `{paranoid: true, timestamps: false}`, reports `options.paranoid === true`
   * for it, and then defines no `deletedAt` column at all — deletes from such a
   * model are hard. Trusting `options.paranoid` alone would put a `deleted`
   * argument and a `restore` mutation on a table that has neither, and leave the
   * `ONLY` filter naming `undefined` as a column.
   *
   * The column name is read rather than assumed because it is renameable
   * (`{deletedAt: "archivedAt"}`).
   */
  deletedAtColumn = (defName: string): string | undefined => {
    const model = this.getModel(defName) as SequelizeModelClass | undefined;
    if (!model?.options.paranoid) {
      return undefined;
    }
    return model._timestampAttributes?.deletedAt;
  };
  /** Whether this model soft-deletes — see {@link deletedAtColumn}. */
  softDeletes = (defName: string): boolean => this.deletedAtColumn(defName) !== undefined;
  /** An include is a JOIN, and a model may be joined more than once per query. */
  readonly includeIsList = true;

  getFilterGraphQLType = (defName: string, definition: Definition, permission?: Permission) =>
    getFilterGraphQLType(this, defName, definition, permission);
  getOrderByGraphQLType = (defName: string, permission?: Permission) =>
    getOrderByGraphQLType(this, defName, permission);
  getIncludeGraphQLType = (defName: string, definition: Definition, permission?: Permission) =>
    getIncludeGraphQLType(this, defName, definition, permission);
  getDefaultListArgs = (defName: string, definition: Definition, permission?: Permission) =>
    getDefaultListArgs(this, defName, definition, permission);
  hasInlineCountFeature = () => {
    if (this.options.disableInlineCount) {
      return false;
    }
    return Boolean(INLINE_COUNT_EXPRESSION[this.sequelize.getDialect()]);
  };
  getInlineCount = async(values: SequelizeRow[]) => {
    return getInlineCountImpl(values);
  };
  /**
   * Build the fetch (and count) options for one list request. The steps live in
   * `./query-options` as free functions over {@link QueryOptionsHost}, which
   * this class satisfies structurally.
   */
  processListArgsToOptions = (defName: string, request: AdapterListRequest): Promise<AdapterListOptions> =>
    processListArgsToOptions(this, defName, request);
  processIncludeStatement(
    defName: string,
    includeStatements: IncludeMap[],
    order: SequelizeOrder[],
    options: AdapterQueryOptions,
    parentRelsForOrder: SequelizeOrderPrefix[] = [],
    runHook?: RunHook
  ) {
    return processIncludeStatement(
      this, defName, includeStatements, order, options, parentRelsForOrder, runHook,
    );
  }
  async processFilterArgument(where: AdapterWhere | undefined, whereOperators: WhereOperators | undefined, options: AdapterQueryOptions): Promise<AdapterWhere> {
    // Dialect-aware normalisation: rewrites iLike → like on SQLite (where LIKE
    // is already case-insensitive) and rejects postgres-only operators on
    // non-postgres dialects with a clear message.
    const normalized = normalizeWhereForDialect(where || {}, this.sequelize.getDialect());
    const w = replaceWhereOperators(normalized);
    if (whereOperators) {
      return replaceDefWhereOperators(w, whereOperators, options);
    }
    return w;
  }
  getAllArgsToReplaceId() {
    return ["where", "include"];
  }
  getGlobalKeys = (defName: string) => getGlobalKeysImpl(this, defName);
  // Not a contract method (unlike `replaceIdInInclude`/`replaceIdInArgs` below),
  // so `variableValues` can be narrowed to what it actually is here: forwarded
  // straight to `replaceIdDeep`, which itself declares it `unknown` — never read.
  replaceIdInWhere = (
    where: AdapterWhere | undefined,
    defName: string,
    variableValues?: unknown,
    translation?: IdTranslation
  ) => {
    return replaceIdInWhereImpl(this, where, defName, variableValues, translation);
  };
  // `GqlizeAdapter.replaceIdInInclude` declares `variableValues` with this exact
  // permissive shape, so it stays here rather than narrowing to `unknown` the
  // way the internal `replaceIdInWhere` above does.
  replaceIdInInclude = (
    arrIncludeVar: Selection["include"],
    defName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches GqlizeAdapter.replaceIdInInclude's published signature
    variableValues?: {[name: string]: any},
    translation?: IdTranslation
  ) => {
    return replaceIdInIncludeImpl(this, arrIncludeVar, defName, variableValues, translation);
  };
  // `GqlizeAdapter.replaceIdInArgs` declares both `args` and `variableValues`
  // with this exact permissive shape — kept to match.
  replaceIdInArgs = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches GqlizeAdapter.replaceIdInArgs's published signature
    args: { [name: string]: any },
    defName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches GqlizeAdapter.replaceIdInArgs's published signature
    variableValues?: {[name: string]: any},
    translation?: IdTranslation
  ) => {
    return replaceIdInArgsImpl(this, args, defName, variableValues, translation);
  };

  findAll = async (defName: string, options: AdapterQueryOptions): Promise<SequelizeRow[]> => {
    return findAllImpl(this.sequelize, defName, options);
  };
  count = (defName: string, options: AdapterQueryOptions): Promise<number> => {
    return countImpl(this.sequelize, defName, options);
  };
  /**
   * Reads `dataValues`, not `get()`. A getter's output would otherwise go
   * through the getter again on the way back. Eager-loaded relations and a
   * `belongsToMany` through row are instances inside `dataValues`, so this
   * recurses into them. An inline `full_count` is a plain value there too.
   */
  snapshotRows = (_defName: string, rows: SequelizeRow[]): unknown[] => snapshotRowsImpl(_defName, rows);
  /**
   * Builds rows the way Sequelize builds a query result: `raw`, not new, over
   * the same include tree. That puts every relation where the resolvers read
   * it. The tree is cloned because building validates it in place, and the
   * options belong to the caller.
   */
  restoreRows = (defName: string, snapshot: unknown[], options: AdapterQueryOptions): SequelizeRow[] => {
    return restoreRowsImpl(this.sequelize, defName, snapshot, options);
  };
  // `OrmAdapter.update` declares `i` with this exact permissive shape — kept to match.
  update = (
    source: SequelizeRow,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches OrmAdapter.update's published signature
    input: { [field: string]: any },
    options: AdapterQueryOptions
  ): Promise<SequelizeRow> => {
    return source.update(input, options);
  };
  getCreateFunction = (defName: string): AdapterCreateFunction => {
    return getCreateFunctionImpl(this.sequelize, defName);
  };
  getUpdateFunction = (defName: string, whereOperators: WhereOperators | undefined): AdapterUpdateFunction => {
    return getUpdateFunctionImpl(this, this.sequelize, defName, whereOperators);
  };
  getDeleteFunction = (defName: string, whereOperators: WhereOperators | undefined): AdapterDeleteFunction => {
    return getDeleteFunctionImpl(this, this.sequelize, defName, whereOperators);
  };
  /**
   * The mirror of {@link getDeleteFunction} for a paranoid model.
   *
   * The find runs with `paranoid: false` — otherwise it could not see the rows
   * it is meant to bring back — and is narrowed to rows that are actually soft
   * deleted, so restoring an already-live row is a no-op rather than a touch.
   * That is the same narrowing the relationship-level `restore` sub-mutation
   * already does.
   */
  getRestoreFunction = (defName: string, whereOperators: WhereOperators | undefined): AdapterRestoreFunction => {
    return getRestoreFunctionImpl(this, this.sequelize, defName, whereOperators);
  };
  mergeFilterStatement(
    fieldName: string,
    value: unknown,
    match: boolean | undefined,
    originalWhere: AdapterWhere | undefined
  ): AdapterWhere {
    return mergeFilterStatement(fieldName, value, match, originalWhere);
  }
  andFilterStatements(a: AdapterWhere | undefined, b: AdapterWhere | undefined): AdapterWhere | undefined {
    if (!a || isEmptyWhere(a)) {
      return b;
    }
    if (!b || isEmptyWhere(b)) {
      return a;
    }
    // A fresh `Op.and` rather than a spread, for the same reason
    // `mergeScopeWhere` wraps: the two sides routinely constrain the same
    // column, and a spread would keep whichever was written second.
    return { [Op.and]: [a, b] };
  }
  /**
   * The row as a model instance, built around it when it is not one.
   *
   * A class or instance method can return plain objects typed as a model, and
   * gqlize resolves that model's relationships on them like any other row. The
   * association accessors (`getItems`, `countItems`, `get`) live on the model
   * prototype, so a plain object has none of them (#72). Building an instance
   * over its values — not a new record — gives it the accessors, keyed off
   * whatever primary and foreign keys it carries.
   */
  asInstance(defName: string, row: SequelizeRow): SequelizeRow {
    return asInstanceImpl(this.sequelize, defName, row);
  }
  resolveSingleRelationship = async (
    _defName: string,
    relationship: Association,
    source: SequelizeRow,
    request: AdapterRelationshipRequest,
  ): Promise<SequelizeRow> => {
    return resolveSingleRelationshipImpl(this, _defName, relationship, source, request);
  };
  // Count a relationship for its `total`. For hasMany, count the target directly
  // with the foreign-key filter so the child's beforeCount hook fires (Sequelize's
  // hasMany count accessor runs via findAll, which would fire beforeFind instead).
  // belongsToMany and others use the through-table-aware association accessor.
  countRelationship = async (
    relationship: Association,
    source: SequelizeRow,
    where: AdapterWhere,
    options: AdapterQueryOptions,
    deleted?: DeletedFilter,
  ): Promise<number> => {
    return countRelationshipImpl(this, relationship, source, where, options, deleted);
  };
  resolveManyRelationship = async (
    defName: string,
    relationship: Association,
    source: SequelizeRow,
    request: AdapterRelationshipRequest,
  ): Promise<AdapterRelationshipPage> => {
    return resolveManyRelationshipImpl(this, defName, relationship, source, request);
  };
}

export function mergeFilterStatement(
  fieldName: string,
  value: unknown,
  match = true,
  originalWhere?: AdapterWhere
): AdapterWhere {
  return mergeFilterStatementImpl(fieldName, value, match, originalWhere);
}

// Typed-models API (definition typesystem). See ./types/orm.
export * from "./types/orm";
