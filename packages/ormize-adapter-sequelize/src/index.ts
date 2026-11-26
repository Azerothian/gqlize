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
import { compileRelationshipFilters } from "./relationship-filters";
import { parseQuantifier, LOGICAL_OPERATORS } from "@azerothian/utilize/gate";
import type { PortableWhere } from "@azerothian/utilize/gate";
import type { Association as UtilAssociation } from "@azerothian/utilize/types/index";
import {
  buildCompilerHost, syncRowSecurity as syncRowSecurityImpl,
  generateRlsSql, extractRlsModels,
} from "./rls/sync-row-security";
import type { RlsSyncOptions } from "./rls/sync-row-security";

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

import type { SequelizeAdapterOptions, SequelizeConnection, AdapterRlsConfig } from "./adapter-types";

/** Postgres role name pattern — same strictness as the setting name pattern in `rls.ts`. */
const RLS_ROLE_PATTERN = /^[a-z_][a-z0-9_]*$/i;
/** Postgres setting name pattern — matches `rls.ts`'s `SETTING_NAME_PATTERN`. */
const RLS_SETTING_NAME_PATTERN = /^[a-z_][a-z0-9_.]*$/i;

/** Validate an RLS runtime config at construction time. */
function validateRlsConfig(rls: AdapterRlsConfig): void {
  if (typeof rls.settings !== "function") {
    throw new Error("SequelizeAdapter rls.settings must be a function (ctx) => {[name]: value}.");
  }
  if (typeof rls.role !== "function") {
    throw new Error("SequelizeAdapter rls.role must be a function (ctx) => string | undefined.");
  }
  if (rls.bypassRole !== undefined && !RLS_ROLE_PATTERN.test(rls.bypassRole)) {
    throw new Error(
      `SequelizeAdapter rls.bypassRole: invalid role name '${rls.bypassRole}'. ` +
      "Role names must match [a-z_][a-z0-9_]*.",
    );
  }
  if (rls.enforce !== undefined && rls.enforce !== "database" && rls.enforce !== "both") {
    throw new Error(
      `SequelizeAdapter rls.enforce must be "database" or "both", got '${String(rls.enforce)}'.`,
    );
  }
  if (rls.softDeleteFlag !== undefined) {
    // Declared by the RFC (§6.8) but not wired yet: nothing sets the flag on a
    // transaction. Accepting it would let a deployment believe its flag-gated
    // SELECT policy works when every soft delete under it fails. Refuse it.
    throw new Error(
      "SequelizeAdapter rls.softDeleteFlag is not supported yet (RFC row-security §6.8). " +
      "Keep soft delete out of RLS policies; gqlize applies it as a global filter.",
    );
  }
}

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
    // Validate the RLS runtime config (RFC §6.5) at construction time.
    if (this.options.rls) {
      validateRlsConfig(this.options.rls);
    }
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

  /**
   * Reconcile RLS policies against the database (RFC §6.4). Called by
   * `Ormize.sync()` right after this adapter's own `sync()`. Only runs on
   * Postgres; on other dialects it is a no-op.
   *
   * @param definitions - all model definitions registered against this adapter
   * @param options - `{ manageRoles }` from `new Ormize({ rls: { manageRoles } })`
   * @returns the SQL statements that were executed (for test assertions)
   */
  syncRowSecurity = async (
    definitions: { [name: string]: Definition },
    options?: RlsSyncOptions,
  ): Promise<string[]> => {
    if (this.sequelize.getDialect() !== "postgres") {
      return [];
    }
    const [[{ schema }]] = await this.sequelize.query("SELECT current_schema() AS schema") as [[{ schema: string }], unknown];
    const host = buildCompilerHost(this.sequelize, definitions, {
      schema: (this.sequelize as unknown as { options: { schema?: string } }).options.schema ?? schema,
      functionOwner: this.options.rls?.bypassRole,
    });
    const models = extractRlsModels(host);
    if (models.length === 0) {
      // Nothing declares RLS. Skip the transaction only if nothing is left to
      // undo either: removing `rls` from the last model must still disable
      // what an earlier sync enabled, so look for gqlize's table marker first.
      const [marked] = await this.sequelize.query(
        "SELECT 1 FROM pg_policy WHERE polname LIKE '%\\_\\_gqlize\\_rls\\_marker' LIMIT 1",
      );
      if (marked.length === 0) {
        return [];
      }
    }
    return syncRowSecurityImpl(host, models, options);
  };

  /**
   * Generate idempotent DDL for all RLS policies from definitions alone, no
   * DB connection. Used by `gqlize rls:sql`.
   */
  generateRlsSql = (
    definitions: { [name: string]: Definition },
    options?: RlsSyncOptions,
  ): string => {
    const host = buildCompilerHost(this.sequelize, definitions, { functionOwner: this.options.rls?.bypassRole });
    const models = extractRlsModels(host);
    return generateRlsSql(host, models, options);
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
   *
   * When an `rls` config is set and `context` is provided, the transaction
   * begins with `set_config` for each setting and `SET LOCAL ROLE` (RFC §6.5).
   * Both are reset in the commit/rollback wrappers as defence in depth.
   */
  beginTransaction = async (context?: import("@azerothian/utilize/types/primitives").RequestContext): Promise<AdapterTransaction> => {
    const t = await this.sequelize.transaction();
    const rlsCfg = this.options.rls;
    if (rlsCfg && context && this.sequelize.getDialect() === "postgres") {
      if (await this._applyRlsSettings(t, context, rlsCfg)) {
        const identity = this.rlsIdentity(context);
        if (identity !== undefined) {
          this.rlsTransactions.set(t, identity);
        }
      }
    }
    const resetRls = rlsCfg && context && this.sequelize.getDialect() === "postgres";
    return {
      handle: t,
      commit: async () => {
        // Defence in depth: settings and LOCAL ROLE are transaction-scoped and
        // revert at COMMIT, but we reset explicitly in case the pool reuses the
        // connection before the commit propagates.
        if (resetRls) {
          await this._resetRlsSettings(t, rlsCfg).catch(() => { /* best effort */ });
        }
        return t.commit();
      },
      rollback: async () => {
        if (resetRls) {
          await this._resetRlsSettings(t, rlsCfg).catch(() => { /* best effort */ });
        }
        return t.rollback();
      },
    };
  };

  /**
   * Apply per-request RLS settings and role onto a just-opened transaction.
   * Setting values are always bound via `set_config($1, $2, true)` —
   * never interpolated — and role names are double-quoted identifiers.
   */
  /**
   * Transactions this adapter opened with a request's settings applied and its
   * role switched. Only an operation running on one of these may leave row
   * filtering to the database (see {@link isDatabaseEnforced}); any other
   * transaction, whether opened without a context, by another adapter, or by
   * the caller, has no identity in it, so the engine keeps its own scope.
   */
  private rlsTransactions = new WeakMap<object, string>();

  /** The identity a transaction was opened with: its role and settings. */
  private rlsIdentity = (context: import("@azerothian/utilize/types/primitives").RequestContext): string | undefined => {
    const cfg = this.options.rls;
    if (!cfg) {
      return undefined;
    }
    const role = cfg.role(context);
    if (role === undefined) {
      return undefined;
    }
    const settings = cfg.settings(context);
    return JSON.stringify([role, Object.keys(settings).sort().map((k) => [k, settings[k]])]);
  };

  /** Returns whether a role was switched, i.e. whether the transaction carries an identity. */
  private _applyRlsSettings = async (
    t: AdapterTransactionHandle,
    context: import("@azerothian/utilize/types/primitives").RequestContext,
    rlsCfg: AdapterRlsConfig,
  ): Promise<boolean> => {
    const settings = rlsCfg.settings(context);
    // Validate setting names at runtime (matches the build-time pattern).
    for (const name of Object.keys(settings)) {
      if (!RLS_SETTING_NAME_PATTERN.test(name)) {
        throw new Error(
          `RLS setting name '${name}' is invalid. Names must match [a-z_][a-z0-9_.]*.`,
        );
      }
    }
    // Apply settings via bound parameters: one set_config per setting.
    for (const [name, rawValue] of Object.entries(settings)) {
      const value = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue);
      await this.sequelize.query(
        `SELECT set_config($1, $2, true)`,
        { bind: [name, value], transaction: t as import("sequelize").Transaction },
      );
    }
    // Set the role. The role name is validated against the identifier pattern
    // and double-quoted so injection through it is impossible.
    const role = rlsCfg.role(context);
    if (role !== undefined) {
      if (!RLS_ROLE_PATTERN.test(role)) {
        throw new Error(
          `RLS role name '${role}' is invalid. Role names must match [a-z_][a-z0-9_]*.`,
        );
      }
      await this.sequelize.query(
        `SET LOCAL ROLE "${role}"`,
        { transaction: t as import("sequelize").Transaction },
      );
      return true;
    }
    return false;
  };

  /**
   * Reset settings and role before the connection returns to the pool.
   * Both are transaction-scoped (`true` / `LOCAL`), so this is defence in depth.
   */
  private _resetRlsSettings = async (
    t: AdapterTransactionHandle,
    rlsCfg: AdapterRlsConfig,
  ): Promise<void> => {
    // RESET ROLE reverts SET LOCAL ROLE.
    await this.sequelize.query(
      "RESET ROLE",
      { transaction: t as import("sequelize").Transaction },
    ).catch(() => { /* best effort */ });
    // Reset each setting to empty.
    const dummyCtx = {} as import("@azerothian/utilize/types/primitives").RequestContext;
    try {
      const settings = rlsCfg.settings(dummyCtx);
      for (const name of Object.keys(settings)) {
        await this.sequelize.query(
          `SELECT set_config($1, '', true)`,
          { bind: [name], transaction: t as import("sequelize").Transaction },
        ).catch(() => { /* best effort */ });
      }
    } catch {
      // The settings function may throw with a dummy context; that's fine since
      // the transaction is about to end anyway.
    }
  };
  /**
   * Resolve the database role for a request context. The engine calls this
   * before opening a transaction; `undefined` → no identity → refuse.
   */
  resolveRlsRole = (context: import("@azerothian/utilize/types/primitives").RequestContext): string | undefined => {
    return this.options.rls?.role(context);
  };

  /**
   * Resolve the RLS settings for a request context. Used by the read-cache
   * key augmentation.
   */
  resolveRlsSettings = (context: import("@azerothian/utilize/types/primitives").RequestContext): { [name: string]: string | number | boolean | (string | number)[] } | undefined => {
    if (!this.options.rls) {
      return undefined;
    }
    return this.options.rls.settings(context);
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
   * Whether `defName` is RLS-enabled on this adapter: the model has
   * `rls.enabled` and this adapter has an `rls` runtime config.
   */
  isRlsEnabled = (defName: string): boolean => {
    if (!this.options.rls) {
      return false;
    }
    const model = this.getModel(defName) as SequelizeModelClass | undefined;
    const def = model?.definition;
    return def?.options?.rls?.enabled === true;
  };

  /**
   * Whether `defName` is database-enforced under RLS: RLS-enabled AND
   * `enforce` is `"database"` (the default, not `"both"`). The ONE helper
   * every enforcement site reads (RFC §6.6).
   */
  isDatabaseEnforced = (
    defName: string, transaction?: unknown,
    context?: import("@azerothian/utilize/types/primitives").RequestContext,
  ): boolean => {
    // Only on a transaction this adapter opened with an identity applied.
    // Anything else (no transaction, a bare `orm.transaction`, another
    // adapter's handle) keeps the engine's scope: fail closed.
    if (!transaction || typeof transaction !== "object") {
      return false;
    }
    const opened = this.rlsTransactions.get(transaction);
    if (opened === undefined) {
      return false;
    }
    // A request whose identity differs from the one the transaction was opened
    // with (a principal switched mid-transaction) would be filtered by the
    // database as the first principal, so the engine keeps its own scope.
    if (context !== undefined && this.rlsIdentity(context) !== opened) {
      return false;
    }
    if (!this.isRlsEnabled(defName)) {
      return false;
    }
    const enforce = this.options.rls?.enforce ?? "database";
    return enforce === "database";
  };

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
  async processFilterArgument(where: AdapterWhere | undefined, whereOperators: WhereOperators | undefined, options: AdapterQueryOptions, defName?: string): Promise<AdapterWhere> {
    // Dialect-aware normalisation: rewrites iLike → like on SQLite (where LIKE
    // is already case-insensitive) and rejects postgres-only operators on
    // non-postgres dialects with a clear message. Applied to every where,
    // including those with quantifiers.
    const normalized = normalizeWhereForDialect(where || {}, this.sequelize.getDialect());
    // When `defName` is given, check for relationship quantifiers in the where.
    // The engine passes it from every call site so the adapter can compile
    // quantifiers without symbol stamps on the where object.
    if (defName) {
      const associations = this.getAssociations(defName);
      if (hasQuantifierOnAssociation(normalized, associations)) {
        const compiled = await compileRelationshipFilters(
          this, defName, normalized, options,
        );
        if (whereOperators) {
          return replaceDefWhereOperators(compiled, whereOperators, options);
        }
        return compiled;
      }
    }
    const w = replaceWhereOperators(normalized);
    if (whereOperators) {
      return replaceDefWhereOperators(w, whereOperators, options);
    }
    return w;
  }
  /**
   * Compile relationship quantifiers in a `PortableWhere` into correlated
   * `EXISTS` / `NOT EXISTS` subqueries, then run the result through
   * `processFilterArgument` for the remaining field-level operators.
   *
   * Called by the engine when a scope's `where` contains quantifier keys.
   * The model name is needed to look up associations.
   */
  async compileRelationshipFilter(
    modelName: string, where: PortableWhere, options: AdapterQueryOptions,
  ): Promise<AdapterWhere> {
    return compileRelationshipFilters(this, modelName, where, options);
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

/**
 * Walk a portable where and return true if any key is a relationship quantifier
 * on one of the given associations. Used by `processFilterArgument` to decide
 * whether to invoke the relationship-filter compiler.
 */
function hasQuantifierOnAssociation(
  where: AdapterWhere | undefined,
  associations: { [relName: string]: UtilAssociation },
): boolean {
  if (!where || typeof where !== "object") {
    return false;
  }
  for (const key of Object.keys(where)) {
    const lower = key.toLowerCase();
    if (LOGICAL_OPERATORS.has(lower)) {
      const branch = where[key] as AdapterWhere | AdapterWhere[];
      if (Array.isArray(branch)) {
        if (branch.some((b) => hasQuantifierOnAssociation(b, associations))) {
          return true;
        }
      } else if (hasQuantifierOnAssociation(branch, associations)) {
        return true;
      }
      continue;
    }
    if (parseQuantifier(where[key]) && associations[key]) {
      return true;
    }
  }
  return false;
}

// Typed-models API (definition typesystem). See ./types/orm.
export * from "./types/orm";
