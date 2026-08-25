/* eslint-disable no-underscore-dangle */
import {
  Model,
  ModelAttributeColumnOptions,
  ModelAttributes,
  ModelCtor,
  ModelOptions,
  Op,
  QueryTypes,
  Sequelize,
  type Association as NativeAssociation,
  type Options as SequelizeOptions,
} from "sequelize";
import logger from "@azerothian/utilize/utils/logger";
import { isFieldAllowed, scopeParametersIn, bindScopeParameters } from "@azerothian/utilize/gate";
import type { ResolvedScope } from "@azerothian/utilize/gate";
import typeMapper from "./type-mapper";
import replaceIdDeep from "@azerothian/gqlize/utils/replace-id-deep";
import { replaceDefWhereOperators } from "./utils/where-operators";
import { computedOrderableFields as computedOrderableFieldsFor } from "@azerothian/utilize/exposed-methods";
const log = logger("gqlize::adapter::sequelize::");

/**
 * A model prototype viewed as the plain object it is at runtime. Sequelize types
 * it as `Model<any, any>`, which has no index signature — but installing
 * relationship accessors and definition instance methods onto it *by name* is
 * exactly what this adapter does.
 */
function prototypeOf(model: { prototype: unknown }): Record<string, unknown> {
  return model.prototype as Record<string, unknown>;
}

/**
 * The statics of a model class, by name — the counterpart of {@link prototypeOf}.
 * A definition's `classMethods` are installed onto the class by name, which
 * `ModelCtor` (no index signature, and rightly so) cannot describe.
 */
function staticsOf(model: SequelizeModelClass): Record<string, unknown> {
  return model as unknown as Record<string, unknown>;
}

/**
 * A fetched row seen as the plain object it is at runtime. Relationship
 * accessors (`getTasks`, `countTasks`) and eager-loaded relationship values are
 * reached off an instance by name, and they exist only once Sequelize has wired
 * the association — so `Model` has no index signature describing them.
 */
function rowFields(row: SequelizeRow): Record<string, any> {
  return row;
}




/**
 * A column as ormize authors one: Sequelize's own attribute options plus the two
 * flags this project adds. Declared here rather than as a module augmentation
 * because they are read by this adapter, never by Sequelize.
 */
type OrmizeColumnOptions = ModelAttributeColumnOptions & {
  /** Keeps the column out of relay global-id translation — see `getGlobalKeys`. */
  ignoreGlobalKey?: boolean;
  /** Opts a primary/foreign key back into client-writable mutation input. */
  writable?: boolean;
  /**
   * GraphQL args for the field and a resolver hung off it by the author. Typed
   * off the shared meta rather than restated, so the two cannot drift.
   */
  args?: DefinitionFieldMeta["args"];
  resolve?: DefinitionFieldMeta["resolve"];
  /** The GraphQL field description; `comment` is the Sequelize-native spelling. */
  description?: string;
};

/**
 * A live Sequelize association plus the three members its public typings omit.
 * `accessors` exists on every association at runtime (it is how Sequelize names
 * the generated `getTasks`/`countTasks` methods). `sourceKey`/`targetKey` exist
 * only on the association kinds that have one — a `hasMany` has a source key, a
 * `belongsTo` a target key — which is why both are optional here and defaulted
 * where they are read.
 */
type NativeAssociationInternals = NativeAssociation & {
  accessors: Association["accessors"];
  sourceKey?: string;
  targetKey?: string;
  /** The resolved column name behind `identifier`, when they differ. */
  identifierField?: string;
};

/**
 * This adapter's own options — the first constructor argument. Closed, so a
 * misspelled key is a compile error rather than a setting that silently does
 * nothing; everything Sequelize itself understands belongs in the *second*
 * argument.
 */
export type SequelizeAdapterOptions = {
  /** Attributes merged under every definition's own `define` map. */
  defaultAttr?: ModelAttributes;
  /** Model options merged under every definition's own `options`. */
  defaultModel?: ModelOptions;
  /** Skip the window-function row count even on a dialect that supports it. */
  disableInlineCount?: boolean;
  /** Opt in to the regex where-operators — see the ReDoS note in `createQueryConfig`. */
  enableRegexpOperators?: boolean;
};

/**
 * The argument list forwarded verbatim to Sequelize's own constructor. Sequelize
 * declares it as a set of positional overloads, and a spread argument cannot be
 * resolved against overloads — so the accepted shapes are named here, where a
 * caller's arguments are still checked against them.
 */
export type SequelizeConnection =
  | []
  | [options: SequelizeOptions]
  | [uri: string, options?: SequelizeOptions]
  | [database: string, username: string, options?: SequelizeOptions]
  | [database: string, username: string, password?: string, options?: SequelizeOptions];

/**
 * An attribute map as it arrives at `resolveAttributeTypes`: either Sequelize's
 * own {@link ModelAttributes} or a definition's fields carrying abstract ormize
 * type tokens, whose `type` is deliberately `unknown`.
 */
export type AuthoredAttributes = { [fieldName: string]: unknown };








import { type QueryTypeConfig } from "@azerothian/graphql-types/query";
import {
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
import {globalKeyTargets, globalKeysFromFields} from "@azerothian/utilize/utils/global-keys";

import {
  GraphQLBoolean,
  GraphQLID,
  type GraphQLInputType,
} from "graphql";
import {
  isOrmizeDataType,
  type AdapterCreateFunction,
  type AdapterDeleteFunction,
  type AdapterListOptions,
  type AdapterListRequest,
  type AdapterQueryOptions,
  type AdapterRelationshipRequest,
  type AdapterRelationshipPage,
  type AdapterRow,
  type AdapterUpdateFunction,
  type AdapterTransaction,
  type AdapterTransactionHandle,
  type AdapterWhere,
  type Association,
  type DataTypeDescriptor,
  type Definition,
  type DefinitionFieldMeta,
  type HookMap,
  type IncludeDescriptor,
  type IncludeMap,
  type NativeDataType,
  type Permission,
  type RequestContext,
  type Relationship,
  type Selection,
  type IdTranslation,
  type WhereOperators,
} from '@azerothian/utilize/types/index';
import type { GqlizeAdapter } from '@azerothian/gqlize/types/gqlize-adapter';
import { mapDataType as mapDataTypeImpl, toNativeType as toNativeTypeImpl } from "./data-type-mapper";
import { SequelizeDefinition, SqlClassMethod } from "./types";
import type {
  ListArgs,
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
  type QueryOptionsHost,
} from "./query-options";
// The query-shape types moved to `./types/query` so the option builders could be
// built over them; they stay exported from here, which is where they have always
// been imported from.
export type * from "./types/query";
import { replaceWhereOperators, reservedOperatorNames } from "./utils/where-ops";

// Pagination safety bounds. This is the central backstop that bounds every list
// query (GraphQL relay connections and REST list routes both funnel through
// `processListArgsToOptions`). Without it, an absent `first`/`last` produced an
// unbounded `findAll` (full-table dump) and an over-large value was passed
// straight through — a trivial DoS / data-exfiltration vector.
// Re-exported because they have been part of this package's public surface
// since the backstop landed; the implementation is shared with every other
// list path in `@azerothian/utilize`.
export {DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE} from "@azerothian/utilize/utils/page-size";

function safeStringify(value: unknown) {
  const seen = new Set<unknown>();
  return JSON.stringify(
    value,
    (k, v) => {
      if (seen.has(v) || k === "sequelize") {
        return "...";
      }
      if (typeof v === "object") {
        seen.add(v);
      }
      return v;
    },
    2
  );
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
    this.options = adapterOptions;
    this.startup = {
      drop: "",
      create: "",
    };
    this.meta = {};
  }
  initialise = async () => {
    if (this.startup.create !== "") {
      await this.getORM().query(this.startup.create);
    }
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
  addInstanceFunction = (
    modelName: string,
    funcName: string,
    func: (...args: any[]) => any
  ) => {
    prototypeOf(this.sequelize.models[modelName])[funcName] = func;
  };

  addStaticFunction = (modelName: string, funcName: string, func: (...args: any[]) => any) => {
    staticsOf(this.model(modelName))[funcName] = func;
  };
  getModel = (modelName: string) => {
    return this.sequelize.models[modelName];
  };
  getModels = (): { [modelName: string]: ModelCtor<Model<any, any>> } => {
    return this.sequelize.models;
  };
  /** {@link getModel}, seen through the statics this adapter installs — see {@link SequelizeModelClass}. */
  private model = (modelName: string): SequelizeModelClass => {
    return this.sequelize.models[modelName] as SequelizeModelClass;
  };
  getMetaObj = <T>(modelName: string, metaName: string): T => {
    if(!this.meta[modelName]) {
      this.meta[modelName] = {};
    }
    return this.meta[modelName][metaName] as T;
  };
  setMetaObj = (modelName: string, metaName: string, value: unknown) => {
    if(!this.meta[modelName]) {
      this.meta[modelName] = {};
    }
    this.meta[modelName][metaName] = value;
  };
  getTypeMapper = () => {
    return typeMapper;
  };
  getFields = (modelName: string): { [fieldName: string]: DefinitionFieldMeta } => {
    const Model = this.sequelize.models[modelName];
    //TODO add filter for excluding or including fields
    if (!this.getMetaObj(modelName, "fields")) {
      const fieldNames = Object.keys(Model.rawAttributes);
      const fields = fieldNames.reduce((fields, key) => {
        const attr = Model.rawAttributes[key] as OrmizeColumnOptions;
        // `_dataTypeChanges` is a Sequelize internal (a column whose declared
        // type the dialect had to rewrite), so it is absent from the public
        // typings; a missing one simply means no column was rewritten.
        const dataTypeChanges = (Model as unknown as {
          _dataTypeChanges?: { [fieldName: string]: unknown };
        })._dataTypeChanges;
        const autoPopulated =
          attr.autoIncrement === true ||
          attr.defaultValue !== undefined ||
          !!dataTypeChanges?.[key];
        const allowNull = attr.allowNull === true;
        const foreignKey = !!attr.references;
        let foreignTarget;
        if (foreignKey) {
          foreignTarget = Object.keys(Model.associations)
            .filter((assocKey) => {
              const assoc = Model.associations[assocKey] as NativeAssociationInternals;
              return assoc.identifier === key || assoc.identifierField === key;
            })
            .map((assocKey) => {
              return Model.associations[assocKey].target.name;
            })[0];
          if (!foreignTarget) {
            //TODO: better error logging
            let message = `An error has occurred with relationships on model - ${modelName} - ${key}`;
            if (process.env.NODE_ENV !== "production") {
              const jsonAssociations = safeStringify(Model.associations);
              const jsonRelationships = safeStringify(
                (Model as SequelizeModelClass).relationships
              );
              message = `Model: ${modelName} - Unable to find ${key} identifier field association in the model associations \n ---Associations--- ${jsonAssociations}\n ---Relationships--- ${jsonRelationships}`;
            }
            throw new Error(message);
          }
        }

        fields[key] = {
          name: key,
          type: attr.type,
          primaryKey: attr.primaryKey === true,
          allowNull,
          // `comment` is the Sequelize spelling and the one that reaches the
          // database; `description` is what `DefinitionField` documents, so it
          // is honoured too and wins. Same precedence as the valkey adapter.
          description: attr.description ?? attr.comment,
          defaultValue: attr.defaultValue,
          foreignKey,
          foreignTarget,
          autoPopulated,
          ignoreGlobalKey: attr.ignoreGlobalKey,
          // Opt-in that lets a pk/fk be set from client input (default: excluded
          // to prevent mass-assignment — see isStructurallyWritable).
          writable: attr.writable === true,
          // `args`/`resolve` are authored on the field and are meaningless to
          // Sequelize, which carries unknown attribute keys through `define`
          // onto `rawAttributes` untouched (the same escape hatch the two flags
          // above ride on). Read back explicitly rather than spreading
          // `rawAttributes`: Sequelize also hangs a circular `Model`
          // back-reference, internals like `_modelAttribute`, and a `unique`
          // normalised to a shape `DefinitionFieldMeta.unique` does not
          // describe — and `getFields` memoises, so all of it would be retained
          // per field forever. See `passes authored args/resolve through` in
          // `__tests__/define-model.test.ts` for the canary on the passthrough.
          args: attr.args,
          resolve: attr.resolve,
        };
        return fields;
      }, {} as { [key: string]: DefinitionFieldMeta });
      this.setMetaObj(modelName, "fields", fields);
    }
    return this.getMetaObj(modelName, "fields");
  };
  getAssociations = (modelName: string): { [relName: string]: Association } => {
    const Model = this.sequelize.models[modelName];
    let associations: { [relName: string]: Association } = this.getMetaObj(modelName, "associations");
    if (associations) {
      return associations;
    }
    associations = Object.keys(Model.associations).reduce(
      (rels, key) => {
        const assoc = Model.associations[key] as NativeAssociationInternals;
        const { associationType } = assoc;
        rels[key] = {
          name: key,
          target: assoc.target.name,
          source: assoc.source.name,
          associationType: `${associationType
            .charAt(0)
            .toLowerCase()}${associationType.slice(1)}`,
          foreignKey: assoc.foreignKey,
          // Sequelize defines these only on the association kinds that have one:
          // a `hasMany` carries a source key, a `belongsTo` a target key. An
          // {@link Association} reports *resolved* keys, so an absent one falls
          // back to the primary key of the model it names — which is exactly what
          // Sequelize itself defaults to when the author omits it.
          targetKey: assoc.targetKey || assoc.target.primaryKeyAttribute,
          sourceKey: assoc.sourceKey || assoc.source.primaryKeyAttribute,
          accessors: assoc.accessors,
        };
        return rels;
      },
      {} as { [relName: string]: Association }
    );
    this.setMetaObj(modelName, "associations", associations);
    return associations;
    
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
  resolveAttributeTypes = (attributes: AuthoredAttributes): ModelAttributes => {
    const out: AuthoredAttributes = {};
    for (const key of Object.keys(attributes)) {
      const attr = attributes[key];
      if (isOrmizeDataType(attr)) {
        // Shorthand form: `field: DataTypes.String`
        out[key] = this.toNativeType(attr);
      } else if (attr && typeof attr === "object") {
        // Object form: `field: { type: DataTypes.String, allowNull: false }`
        const { type } = attr as { type?: unknown };
        out[key] = isOrmizeDataType(type)
          ? Object.assign({}, attr, { type: this.toNativeType(type) })
          : attr;
      } else {
        out[key] = attr;
      }
    }
    // Every entry is now either untouched — already a Sequelize attribute — or
    // one whose token `type` has just been converted to a native one. The
    // compiler cannot see that: what came in were `DefinitionField`s, whose
    // `type` is `unknown` by design (see {@link AuthoredAttributes}).
    return out as ModelAttributes;
  };
  /**
   * Warn about columns whose name collides with a reserved where-operator:
   * `replaceWhereOperators` would silently reinterpret a filter on such a column
   * as the operator instead of an equality filter — a hard-to-diagnose footgun.
   */
  private warnReservedFieldNames = (defName: string, define: SequelizeDefinition["define"]) => {
    for (const fieldName of Object.keys(define || {})) {
      if (reservedOperatorNames.has(fieldName)) {
        log.error(
          `Model "${defName}" field "${fieldName}" collides with a reserved where-operator; ` +
          `filters on this column may be misinterpreted. Consider renaming it.`,
        );
      }
    }
  };
  /** Collect a definition's raw create/drop DDL, replayed by {@link initialise}. */
  private registerStartupQueries = (queries: SequelizeDefinition["queries"]) => {
    Object.keys(queries || {}).forEach((k) => {
      const q = queries[k];
      if (q.drop) {
        this.startup.drop += `${isFunction(q.drop) ? q.drop() : q.drop}\n`;
      }
      if (q.create) {
        this.startup.create += `${isFunction(q.create) ? q.create() : q.create}\n`;
      }
    });
  };
  private installClassMethods = async (defName: string, classMethods: {[name: string]: unknown}) => {
    const statics = staticsOf(this.model(defName));
    await Promise.all(
      Object.keys(classMethods).map(async (classMethod) => {
        if (isFunction(classMethods[classMethod])) {
          statics[classMethod] = classMethods[classMethod];
          return;
        }
        // Not a function, so it is a {@link SqlClassMethod} descriptor — a raw
        // query or a Postgres function call — compiled into a static here.
        // `Definition.classMethods` names only the function form, so the
        // descriptor form is narrowed at this one branch.
        statics[classMethod] = await this.generateSQLFunction(classMethods[classMethod] as SqlClassMethod, defName);
      })
    );
  };
  private installInstanceMethods = (defName: string, instanceMethods: {[name: string]: unknown}) => {
    const proto = prototypeOf(this.sequelize.models[defName]);
    Object.keys(instanceMethods).forEach((instanceMethod) => {
      proto[instanceMethod] = instanceMethods[instanceMethod];
    });
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
    const { defaultAttr, defaultModel } = this.options;
    const newDef = Object.assign({}, def, {
      options: Object.assign({}, defaultModel, def.options, {
        hooks,
      }),
    });
    if(!newDef.name) {
      throw new Error("Unable to create model with no name");
    }
    const defName = newDef.name;
    this.warnReservedFieldNames(defName, newDef.define);
    this.sequelize.define(
      defName,
      this.resolveAttributeTypes(Object.assign({}, defaultAttr, newDef.define)),
      newDef.options
    );
    this.registerStartupQueries(newDef.queries);

    if (newDef.disablePrimaryKey) {
      this.sequelize.models[defName].removeAttribute("id");
    }
    (newDef.removeAttributes || []).forEach((attr) => {
      this.sequelize.models[defName].removeAttribute(attr);
    });
    // `options.classMethods`/`options.instanceMethods` are the nested spelling
    // and win over the top-level one when both are authored.
    const classMethods = newDef.options?.classMethods || newDef.classMethods;
    const instanceMethods = newDef.options?.instanceMethods || newDef.instanceMethods;
    if (classMethods) {
      await this.installClassMethods(defName, classMethods);
    }
    if (instanceMethods) {
      this.installInstanceMethods(defName, instanceMethods);
    }

    const model = this.model(defName);
    prototypeOf(model).Model = model;
    model.definition = newDef;

    return model;
  };
  /**
   * @param modelName the model rows are mapped onto, which is often absent.
   * @param scopeModel the model whose row-level scope this statement is bound
   *   to (§12) — the definition the class method was installed on, not the one
   *   results are mapped to. Those are usually the same and need not be: a
   *   statement mapped onto nothing at all is still a read of *some* model.
   */
  createSQLFunction = async (query: string, modelName: string | undefined, args: string[], scopeModel?: string) => {
    // Read once, at build: the parameter list is a property of the statement,
    // and re-parsing it per call would be work done on every request to learn
    // something that cannot have changed.
    const scopeParameters = scopeParametersIn(query, args);
    const label = scopeModel ? `${scopeModel}'s raw SQL` : "a raw SQL class method";
    return async (a: { [argName: string]: unknown }, context: RequestContext) => {
      // security check?
      const opts = {
        replacements: args.reduce(
          (o: { [argName: string]: unknown }, ar: string) => {
            o[ar] = a[ar] ? a[ar] : null;
            return o;
          },
          {}
        ),
        type: QueryTypes.SELECT,
      } as {
        model: ModelCtor<Model<any, any>>;
        replacements: { [argName: string]: unknown };
        type: QueryTypes;
      };
      if (scopeParameters.length > 0) {
        // §12: the engine cannot rewrite a statement that is already text, so a
        // reserved parameter is the whole of its reach into one. The audit
        // guarantees the parameter is there; this puts the value in it.
        //
        // `scopeFor` arrives on the context from `resolveClassMethod`. A static
        // called straight off the model has none, and binds nulls — which the
        // documented `(:scopeOwnerId IS NULL OR …)` idiom reads as unconstrained.
        // That path is closed by its runtime twin, the instance-level
        // `beforeQuery`, not here: this layer cannot tell "no scope configured"
        // from "the engine was bypassed", and guessing either way is worse than
        // letting the layer that knows decide.
        const scopeOf = (context as { scopeFor?: (m: string, o: string) => Promise<ResolvedScope> } | undefined)?.scopeFor;
        const resolved = scopeModel && typeof scopeOf === "function"
          ? await scopeOf(scopeModel, "read")
          : undefined;
        const bound = bindScopeParameters(query, args, resolved, label);
        if (bound === false) {
          // Denied outright. An empty page is what a caller with no matching
          // rows already sees, and a read has nothing louder to say that would
          // not itself confirm the rows exist.
          return [];
        }
        // After the argument reduction, never before it: `args` is caller-supplied
        // and a request that named `scopeOwnerId` among them would otherwise be
        // choosing the value that decides what it may read.
        Object.assign(opts.replacements, bound);
      }
      if (modelName) {
        opts.model = this.sequelize.models[modelName];
      }
      return this.sequelize.query(query, opts);
    };
  };
  generateSQLFunction = async (sqlFunc: SqlClassMethod, scopeModel?: string) => {
    // PostgreSQL supported only atm?
    const {
      type = "query",
      schema = "public",
      functionName,
      query,
      modelName,
      args = [],
    } = sqlFunc;
    let q = "";
    switch (type) {
      case "query":
        q = query;
        break;
      case "sqlfunction":
        if (query) {
          q = query;
        } else {
          q = `SELECT * FROM "${schema}"."${functionName}"(${args
            .map((s: string) => `:${s}`)
            .join(",")});`;
        }
    }
    return this.createSQLFunction(q, modelName, args, scopeModel);
  };
  // Permission object captured at schema-build time. The GraphQL filter/order/
  // include type builders below fall back to it when no explicit permission is
  // threaded through, so denied fields/relationships are consistently excluded
  // regardless of which build path reaches a given model first.
  _buildPermission: Permission | undefined = undefined;
  setBuildPermission = (permission: Permission | undefined) => {
    if (permission !== this._buildPermission) {
      // The meta cache is keyed by model name alone, but these three types are
      // derived from the permission bag. Building a second schema off the same
      // adapter under a different permission must not hand back the previous
      // build's types — that would silently re-expose denied fields and
      // relationships. `fields`/`associations` are permission-independent and
      // deliberately survive.
      Object.keys(this.meta).forEach((modelName) => {
        delete this.meta[modelName].queryType;
        delete this.meta[modelName].orderByType;
        delete this.meta[modelName].includeType;
      });
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
      if (!isFieldAllowed(perm, defName, k)) {
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
          if (isFieldAllowed(perm, defName, field.foreignKey)) {
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
    sourceModel: string ,
    name: string,
    type: string,
    options: Relationship["options"] = {}
  ) => {
    const model = this.model(targetModel);
    if (!model.relationships) {
      model.relationships = {};
    }
    try {
      // `through` may also be a bare model name, which Sequelize accepts as-is.
      // Only the object form carries a `model` to resolve — the previous
      // unguarded property read simply found `undefined` on the string.
      if (typeof options.through === "object" && options.through?.model) {
        (options.through as {model?: unknown}).model = this.sequelize.models[options.through.model];
      }
      const opts = Object.assign(
        {
          as: name,
        },
        options
      );
      // `type` names one of Sequelize's association builders (`belongsTo`,
      // `hasMany`, ...) and is called by name off the model class, so the lookup
      // is dynamic — see {@link staticsOf}. An unknown one is a definition error
      // and is reported by the `catch` below.
      const build = staticsOf(model)[type];
      if (typeof build !== "function") {
        throw new Error(`SequelizeAdapter: "${type}" is not a relationship type`);
      }
      model.relationships[name] = {
        name: name,
        type: type,
        source: sourceModel,
        target: targetModel,
        options: opts,
        rel: build.call(model, this.sequelize.models[sourceModel], opts),
      };
    } catch (err) {
      log.error("Error Mapping relationship", {
        model,
        sourceModel,
        name,
        type,
        options,
        err,
      });
      // Fail fast at boot rather than silently booting with a missing/broken
      // association — downstream query scoping and relationship resolution
      // assume the association exists, so swallowing this hides real defects.
      throw err;
    }
    this.sequelize.models[targetModel] = model;
  };
  createFunctionForFind = (modelName: string) => {
    const model = this.sequelize.models[modelName];
    return function(value: unknown, filterKey: string, singular: boolean) {
      return (options: AdapterQueryOptions = {}) => {
        const opts = Object.assign({}, options, {
          where: mergeFilterStatement(filterKey, value, true, options.where),
        });
        if (!singular) {
          return model.findAll(opts);
        }
        return model.findOne(opts);
      };
    };
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
    // The count rides along as a `full_count` column on every row of the page
    // (a window function — see `processListArgsToOptions`), so the first row is
    // enough. It is not a declared attribute, hence the plain-object view.
    const first = values[0] ? rowFields(values[0]) : undefined;
    const row = first ? (first.dataValues || first) : undefined;
    if (!row || !row.full_count) {
      return 0;
    }
    return parseInt(row.full_count, 10);
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
    const w = replaceWhereOperators(where);
    if (whereOperators) {
      return replaceDefWhereOperators(w, whereOperators, options);
    }
    return w;
  }
  getAllArgsToReplaceId() {
    return ["where", "include"];
  }
  getGlobalKeys = (defName: string) => globalKeysFromFields(this.getFields(defName));
  /**
   * Each hop re-derives `targets` for the model it is about to decode against,
   * rather than carrying the caller's down: a nested relation's `where` filters
   * the *target's* keys, and typing them with the parent's map is how a
   * cross-type id would slip through the check it exists to make.
   */
  private idTranslation(defName: string, translation?: IdTranslation): IdTranslation {
    return {
      ...translation,
      defName,
      targets: globalKeyTargets(this.getFields(defName), defName),
    };
  }
  replaceIdInWhere = (
    where: AdapterWhere | undefined,
    defName: string,
    variableValues?: {[name: string]: any},
    translation?: IdTranslation
  ) => {
    const globalKeys = this.getGlobalKeys(defName);
    return replaceIdDeep(where, globalKeys, variableValues, this.idTranslation(defName, translation));
  };
  replaceIdInInclude = (
    arrIncludeVar: Selection["include"],
    defName: string,
    variableValues?: {[name: string]: any},
    translation?: IdTranslation
  ) => {
    return (arrIncludeVar || []).map(
      (iv) => {
        return Object.keys(iv).reduce((o, relName) => {
          const { include, where, ...rest } = iv[relName];
          o[relName] = rest;
          const rel = this.getAssociation(defName, relName);
          if (where) {
            o[relName].where = this.replaceIdInWhere(
              where,
              rel.target,
              variableValues,
              translation
            );
          }
          if (include) {
            o[relName].include = this.replaceIdInInclude(
              include,
              rel.target,
              variableValues,
              translation
            );
          }
          return o;
        }, {} as { [relName: string]: IncludeDescriptor });
      }
    );
  };
  replaceIdInArgs = (
    args: { [name: string]: any },
    defName: string,
    variableValues?: {[name: string]: any},
    translation?: IdTranslation
  ) => {
    const { where, include, ...rest } = args;
    if (include) {
      rest.include = this.replaceIdInInclude(include, defName, variableValues, translation);
    }
    if (where) {
      rest.where = this.replaceIdInWhere(where, defName, variableValues, translation);
    }
    return rest;
  };

  findAll = (defName: string, options: AdapterQueryOptions): Promise<SequelizeRow[]> => {
    const Model = this.sequelize.models[defName];
    return Model.findAll(options);
  };
  count = (defName: string, options: AdapterQueryOptions): Promise<number> => {
    const Model = this.sequelize.models[defName];
    // Sequelize's `count` is declared to return a grouped row array when the
    // options carry a `group`; ormize never counts by group, so the number
    // overload is the only one this can produce.
    return Model.count(options);
  };
  update = (
    source: SequelizeRow,
    input: { [field: string]: any },
    options: AdapterQueryOptions
  ): Promise<SequelizeRow> => {
    return source.update(input, options);
  };
  getCreateFunction = (defName: string): AdapterCreateFunction => {
    const Model = this.sequelize.models[defName];
    return (input, options) => {
      return Model.create(input, options);
    };
  };
  getUpdateFunction = (defName: string, whereOperators: WhereOperators | undefined): AdapterUpdateFunction => {
    const Model = this.sequelize.models[defName];
    return async (where, processInput, options) => {
      const items = await Model.findAll({
        where: await this.processFilterArgument(where, whereOperators, options),
        ...options,
      });
      return Promise.all(
        items.map(async (i) => {
          const input = await processInput(i);
          if (Object.keys(input).length > 0) {
            return i.update(input, options);
          }
          return i;
        })
      );
    };
  };
  getDeleteFunction = (defName: string, whereOperators: WhereOperators | undefined): AdapterDeleteFunction => {
    const Model = this.sequelize.models[defName];
    return async (where, options, before, after) => {
      const items = await Model.findAll({
        where: await this.processFilterArgument(where, whereOperators, options),
        ...options,
      });
      // Destroy serially and await each one before resolving — returning the array
      // of un-awaited promises previously let callers (and subsequent queries) run
      // before the deletes completed, which was both a correctness bug and a flake.
      const results: AdapterRow[] = [];
      for (const item of items) {
        // `before`/`after` are declared over the contract's opaque
        // {@link AdapterRow}, not this adapter's row: they are arrow-syntax
        // aliases, so a narrowed *return* would not survive the variance flip.
        // What comes back is still the row that went in.
        const beforeDestroy = (await before(item)) as SequelizeRow;
        await beforeDestroy.destroy(options);
        results.push(await after(beforeDestroy));
      }
      return results;
    };
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
    if (!a || Object.getOwnPropertyNames(a).length + Object.getOwnPropertySymbols(a).length === 0) {
      return b;
    }
    if (!b || Object.getOwnPropertyNames(b).length + Object.getOwnPropertySymbols(b).length === 0) {
      return a;
    }
    // A fresh `Op.and` rather than a spread, for the same reason
    // `mergeScopeWhere` wraps: the two sides routinely constrain the same
    // column, and a spread would keep whichever was written second.
    return { [Op.and]: [a, b] };
  }
  resolveSingleRelationship = async (
    _defName: string,
    relationship: Association,
    source: SequelizeRow,
    request: AdapterRelationshipRequest,
  ): Promise<SequelizeRow> => {
    const options = request.options || {};
    // Both the eager-loaded value and the generated accessor are reached off the
    // instance by name — see {@link rowFields}.
    const fields = rowFields(source);
    if (fields[relationship.name]) {
      return fields[relationship.name];
    }
    return fields[relationship.accessors.get](options);
  };
  // Count a relationship for its `total`. For hasMany, count the target directly
  // with the foreign-key filter so the child's beforeCount hook fires (Sequelize's
  // hasMany count accessor runs via findAll, which would fire beforeFind instead).
  // belongsToMany and others use the through-table-aware association accessor.
  countRelationship = async (
    relationship: Association,
    source: SequelizeRow,
    where: AdapterWhere,
    options: AdapterQueryOptions
  ): Promise<number> => {
    if (relationship.associationType === "hasMany") {
      const TargetModel = this.sequelize.models[relationship.target];
      const countWhere = Object.assign({}, where, {
        [relationship.foreignKey]: source.get(relationship.sourceKey),
      });
      // `getGraphQLArgs` is this project's own addition to the options bag — the
      // hooks read it off `options`; Sequelize itself ignores it.
      return TargetModel.count({
        where: countWhere,
        getGraphQLArgs: options?.getGraphQLArgs,
      } as AdapterQueryOptions);
    }
    return rowFields(source)[relationship.accessors.count]({ where, getGraphQLArgs: options?.getGraphQLArgs });
  };
  resolveManyRelationship = async (
    defName: string,
    relationship: Association,
    source: SequelizeRow,
    request: AdapterRelationshipRequest,
  ): Promise<AdapterRelationshipPage> => {
    const {whereOperators, options = {}, countOnly} = request;
    const args = (request.args || {}) as ListArgs;
    // The eager-loaded value and the generated accessors are reached off the
    // instance by name — see {@link rowFields}.
    const fields = rowFields(source);
    if (countOnly && !(fields[relationship.name] !== undefined && fields[relationship.name] !== null)) {
      // Only `total` requested: run a count instead of fetching rows.
      const where = await this.processFilterArgument(args.where || {}, whereOperators, options);
      const total = await this.countRelationship(relationship, source, where, options);
      return { total, models: [] };
    }
    if (fields[relationship.name] !== undefined && fields[relationship.name] !== null) {
      // Eager-loaded at the root level (JOIN or `separate:true`). The rows are
      // already filtered/sorted/limited, so return them — but when a per-parent
      // limit was applied the loaded length is the page size, not the true total,
      // so fetch an accurate count (fires the child's beforeCount natively).
      const val = fields[relationship.name];
      const models = Array.isArray(val) ? val : [val];
      let total = models.length;
      if (args && (args.first != null || args.last != null)) {
        try {
          const where = await this.processFilterArgument(args.where || {}, whereOperators, options);
          total = await this.countRelationship(relationship, source, where, options);
        } catch (e) {
          // Fall back to the already-loaded page length, but surface the error —
          // silently returning a plausible-but-wrong count hides real defects
          // (e.g. a bug in filter processing) behind a valid-looking response.
          log.error("countRelationship failed; falling back to loaded page length", {
            relationship: relationship.name,
            err: e,
          });
          total = models.length;
        }
      }
      return {
        total,
        models,
      };
    }
    // Forwards the whole request: the positional form this replaced passed six of
    // eight arguments, so `selectedFields` and `runHook` were dropped here and a
    // JOIN-include `beforeFind` never fired on the relationship path.
    const { getOptions, countOptions } = await this.processListArgsToOptions(defName, request);
    const models = await fields[relationship.accessors.get](getOptions);
    let total;
    if (this.hasInlineCountFeature()) {
      total = await this.getInlineCount(models);
    } else {
      total = await fields[relationship.accessors.count](countOptions);
    }
    return {
      total,
      models,
    };
  };
}

export function mergeFilterStatement(
  fieldName: string,
  value: unknown,
  match = true,
  originalWhere?: AdapterWhere
): AdapterWhere {
  const targetOp = Array.isArray(value)
    ? (match ? Op.in : Op.notIn)
    : (match ? Op.eq : Op.ne);
  const filter = {
    [fieldName]: {
      [targetOp]: value,
    },
  };
  if (originalWhere) {
    return {
      [Op.and]: [originalWhere, filter],
    };
  }
  return filter;
}

function isFunction(functionToCheck: unknown) {
  if (functionToCheck) {
    const type = {}.toString.call(functionToCheck);
    return type === "[object Function]" || type === "[object AsyncFunction]";
  }
  return false;
}

// Typed-models API (definition typesystem). See ./types/orm.
export * from "./types/orm";
