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
  type IncludeOptions,
  type Options as SequelizeOptions,
} from "sequelize";
import logger from "@azerothian/utilize/utils/logger";
import unique from "@azerothian/utilize/utils/unique";
import { isFieldAllowed, isModelAllowed, isRelationshipAllowed } from "@azerothian/utilize/gate";
import typeMapper from "./type-mapper";
import replaceIdDeep from "@azerothian/gqlize/utils/replace-id-deep";
import { replaceDefWhereOperators } from "./utils/where-operators";
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
  return row as unknown as Record<string, any>;
}

/**
 * A model class, augmented with the two statics this adapter installs on it:
 * `createModel` stamps the authored definition onto the class, and
 * `createRelationship` builds `relationships` up on it as each one is wired.
 * Sequelize's `ModelCtor` knows about neither.
 *
 * Both are declared non-optional rather than `?`: every model reaching this
 * adapter's read paths came out of `createModel`, which installs `definition`
 * before it returns. A model without one is a wiring error, not a case for every
 * read site to branch on.
 */
export type SequelizeModelClass = ModelCtor<Model<any, any>> & {
  definition: SequelizeDefinition;
  relationships: { [relName: string]: SequelizeRelationship };
};

/**
 * A wired relationship as this adapter records it on the model class: the
 * arguments `createRelationship` was given, plus `rel` — the live Sequelize
 * association object it produced. Nothing here reads `rel` back; it is kept
 * because it is the only handle onto the native association.
 */
export type SequelizeRelationship = {
  name: string;
  type: string;
  source: string;
  target: string;
  options: Relationship["options"];
  rel: unknown;
};

/**
 * A row as this adapter produces and consumes it: a Sequelize model instance.
 * The contract calls a row `AdapterRow` (`unknown`) because no caller may assume
 * a shape — but the adapter that produced it may, which is precisely why
 * `OrmAdapter` is declared with method syntax rather than function properties.
 */
export type SequelizeRow = Model<any, any>;

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

/**
 * The list arguments this adapter reads off a field's args bag. Open, because
 * everything not named here is forwarded verbatim — which is also why the
 * contract declares this parameter as an open bag.
 */
export type ListArgs = {
  first?: number;
  last?: number;
  orderBy?: SequelizeOrder[];
  where?: AdapterWhere;
  include?: IncludeMap[];
  [arg: string]: unknown;
};

/**
 * The hook dispatcher ormize threads down so a JOIN-loaded include can still
 * fire the child model's `beforeFind` — see `processIncludeStatement`. Typed as
 * the contract declares it: the hook name selects the value's shape, so neither
 * it nor the return can be narrowed here.
 */
export type RunHook = (defName: string, hookName: string, value: any, ...args: any[]) => Promise<any>;

/** An association prefix in an ORDER BY entry — Sequelize's `{model, as}` form. */
export type SequelizeOrderPrefix = { model: SequelizeModelClass; as: string };

/**
 * One ORDER BY entry as this adapter builds one: the association prefixes needed
 * to reach the column, then the column and its direction. Sequelize's own
 * `OrderItem` is a union of fixed-length tuples, which cannot describe an entry
 * assembled by spreading a variable number of prefixes onto an authored
 * `[column, direction]` pair.
 */
export type SequelizeOrder = (SequelizeOrderPrefix | string)[];

/**
 * One selected column: a name, or the `[expression, alias]` pair the inline
 * count is pushed on as.
 */
export type SequelizeAttribute = string | [ReturnType<Sequelize["literal"]>, string];

/**
 * One eager-load entry. Sequelize's own `IncludeOptions`, with three members
 * restated: `order` and `include` because they are built here in this adapter's
 * own shapes, and `getGraphQLArgs` because a `separate` include runs as its own
 * query — so the accessor has to ride on the include for the child model's find
 * hooks to reach the GraphQL args at all.
 */
export type SequelizeInclude = Omit<IncludeOptions, "order" | "include"> & {
  order?: SequelizeOrder[];
  include?: SequelizeInclude[];
  /**
   * `separate` only. Sequelize's `IncludeOptions` declares `limit` but not
   * `offset`, though a separate include is run as its own query and honours it —
   * which is what makes per-parent pagination of a `hasMany` possible at all.
   */
  offset?: number;
  getGraphQLArgs?: GetGraphQLArgs;
};

/** Reaches the live GraphQL execution args from inside an options bag. */
type GetGraphQLArgs = () => { context: RequestContext; info: unknown; source: unknown };

import createQueryType, { type QueryTypeConfig } from "@azerothian/graphql-types/query";

import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLID,
  GraphQLList,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLInputFieldConfigMap,
  type GraphQLInputType,
} from "graphql";
import { GraphQLInputObjectType } from "graphql";
import waterfall from "@azerothian/utilize/utils/waterfall";
import {
  isOrmizeDataType,
  type AdapterCreateFunction,
  type AdapterDeleteFunction,
  type AdapterQueryOptions,
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
  type OrderEntry,
  type Permission,
  type RequestContext,
  type Relationship,
  type Selection,
  type WhereOperators,
} from '@azerothian/utilize/types/index';
import type { GqlizeAdapter } from '@azerothian/gqlize/types/gqlize-adapter';
import { mapDataType as mapDataTypeImpl, toNativeType as toNativeTypeImpl } from "./data-type-mapper";
import { SequelizeDefinition, SqlClassMethod } from "./types";
import { replaceWhereOperators, reservedOperatorNames } from "./utils/where-ops";

// Pagination safety bounds. This is the central backstop that bounds every list
// query (GraphQL relay connections and REST list routes both funnel through
// `processListArgsToOptions`). Without it, an absent `first`/`last` produced an
// unbounded `findAll` (full-table dump) and an over-large value was passed
// straight through — a trivial DoS / data-exfiltration vector.
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;

/**
 * Coerce a client-supplied page size to a safe, bounded integer: falls back to
 * DEFAULT_PAGE_SIZE when absent/NaN/non-positive, and caps at MAX_PAGE_SIZE.
 */
function clampPageSize(value: unknown): number {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(n, MAX_PAGE_SIZE);
}

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
          description: attr.comment,
          defaultValue: attr.defaultValue,
          foreignKey,
          foreignTarget,
          autoPopulated,
          ignoreGlobalKey: attr.ignoreGlobalKey,
          // Opt-in that lets a pk/fk be set from client input (default: excluded
          // to prevent mass-assignment — see isStructurallyWritable).
          writable: attr.writable === true,
        } as DefinitionFieldMeta;
        return fields;
      }, {} as { [key: string]: DefinitionFieldMeta });
      this.setMetaObj(modelName, "fields", fields);
    }
    return this.getMetaObj(modelName, "fields") as { [key: string]: DefinitionFieldMeta };
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
  createModel = async (def: SequelizeDefinition, hooks?: HookMap): Promise<SequelizeModelClass> => {
    const { defaultAttr, defaultModel } = this.options;
    const newDef = Object.assign({}, def, {
      options: Object.assign({}, defaultModel, def.options, {
        hooks,
      }),
    });
    if(!newDef.name) {
      throw "Unable to create model with no name";
    }
    const defName = newDef.name;
    // Warn about columns whose name collides with a reserved where-operator:
    // replaceWhereOperators would silently reinterpret a filter on such a column
    // as the operator instead of an equality filter (a hard-to-diagnose footgun).
    for (const fieldName of Object.keys(newDef.define || {})) {
      if (reservedOperatorNames.has(fieldName)) {
        log.error(
          `Model "${defName}" field "${fieldName}" collides with a reserved where-operator; ` +
          `filters on this column may be misinterpreted. Consider renaming it.`,
        );
      }
    }
    this.sequelize.define(
      defName,
      this.resolveAttributeTypes(Object.assign({}, defaultAttr, newDef.define)),
      newDef.options
    );

    let { classMethods, instanceMethods, queries } = newDef;
    if (queries) {
      Object.keys(queries).forEach((k) => {
        const q = queries[k];
        if (q.drop) {
          this.startup.drop += `${isFunction(q.drop) ? q.drop() : q.drop}\n`;
        }
        if (q.create) {
          this.startup.create += `${
            isFunction(q.create) ? q.create() : q.create
          }\n`;
        }
      });
    }
    if (newDef.options) {
      if (newDef.disablePrimaryKey) {
        this.sequelize.models[newDef.name].removeAttribute("id");
      }
      if (newDef.removeAttributes) {
        newDef.removeAttributes.forEach((attr) => {
          this.sequelize.models[defName].removeAttribute(attr);
        });
      }
      if (newDef.options.classMethods) {
        classMethods = newDef.options.classMethods;
      }
      if (newDef.options.instanceMethods) {
        instanceMethods = newDef.options.instanceMethods;
      }
    }
    if (classMethods) {
      await Promise.all(
        Object.keys(classMethods).map(async (classMethod) => {
          if (classMethods) {
            const statics = staticsOf(this.model(defName));
            if (isFunction(classMethods[classMethod])) {
              statics[classMethod] = classMethods[classMethod];
            } else {
              // Not a function, so it is a {@link SqlClassMethod} descriptor —
              // a raw query or a Postgres function call — compiled into a static
              // here. `Definition.classMethods` names only the function form, so
              // the descriptor form is narrowed at this one branch.
              statics[classMethod] = await this.generateSQLFunction(
                classMethods[classMethod] as unknown as SqlClassMethod
              );
            }
          }
        })
      );
    }
    if (instanceMethods) {
      Object.keys(instanceMethods).forEach((instanceMethod) => {
        if (instanceMethods) {
          prototypeOf(this.sequelize.models[defName])[instanceMethod] =
            instanceMethods[instanceMethod];
        }
      });
    }
    const model = this.model(defName);
    prototypeOf(model).Model = model;
    model.definition = newDef;

    return model;
  };
  createSQLFunction = async (query: string, modelName: string | undefined, args: string[]) => {
    return (a: { [argName: string]: unknown }, _context: RequestContext) => {
      // security check?
      let opts = {
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
      if (modelName) {
        opts.model = this.sequelize.models[modelName];
      }
      return this.sequelize.query(query, opts);
    };
  };
  generateSQLFunction = async (sqlFunc: SqlClassMethod) => {
    // PostgreSQL supported only atm?
    let {
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
    return this.createSQLFunction(q, modelName, args);
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
      throw "no name set";
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
        "eq",
        "ne",
        "gte",
        "lte",
        "lt",
        "not",
        "is",
        "like",
        "notLike",
        "iLike",
        "notILike",
        "startsWith",
        "endsWith",
        "substring",
        // Regex operators are opt-in. On dialects that evaluate client-supplied
        // patterns (e.g. Postgres `~`/`~*`), a catastrophic-backtracking pattern
        // is a ReDoS vector, so they are excluded unless the adapter is
        // constructed with `{ enableRegexpOperators: true }`.
        ...(this.options.enableRegexpOperators
          ? ["regexp", "notRegexp", "iRegexp", "notIRegexp"]
          : []),
      ],
      arrayFuncs: ["or", "and", "any", "all"],
      arrayValues: [
        "in",
        "notIn",
        "contains",
        "contained",
        "between",
        "notBetween",
        "overlap",
        "adjacent",
        "strictLeft",
        "strictRight",
        "noExtendRight",
        "noExtendLeft",
      ],
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
  getFilterGraphQLType = (defName: string, definition: Definition, permission?: Permission): GraphQLInputObjectType => {
    if (!this.getMetaObj(defName, "queryType")) {
      this.setMetaObj(
        defName,
        "queryType",
        createQueryType(this.createQueryConfig(definition, permission))
      );
    }
    return this.getMetaObj(defName, "queryType") as GraphQLInputObjectType;
  };
  getOrderByGraphQLType = (defName: string, permission?: Permission): GraphQLInputObjectType => {
    if (!this.getMetaObj(defName, "orderByType")) {
      const perm = permission !== undefined ? permission : this._buildPermission;
      const fields = this.getFields(defName);
      // Only permission-allowed fields are orderable — a denied field must
      // not be sortable (another way to leak ordering-based information).
      const values = Object.keys(fields).reduce((o, fieldName) => {
        if (!isFieldAllowed(perm, defName, fieldName)) {
          return o;
        }
        o[`${fieldName}ASC`] = { value: [fieldName, "ASC"] };
        o[`${fieldName}DESC`] = { value: [fieldName, "DESC"] };
        return o;
      }, {} as { [enumValueName: string]: { value: [string, "ASC" | "DESC"] } });
      // An enum with no values is an invalid GraphQL type. When permissions deny
      // every orderable field, leave the meta unset so callers omit `orderBy`
      // entirely rather than emitting an empty `${defName}OrderBy`.
      if (Object.keys(values).length > 0) {
        this.setMetaObj(
          defName,
          "orderByType",
          new GraphQLList(
            new GraphQLEnumType({
              name: `${defName}OrderBy`,
              values,
              // description: "",
            })
          )
        );
      }
    }
    return this.getMetaObj(defName, "orderByType") as GraphQLInputObjectType;
  };

  getIncludeGraphQLType = (
    defName: string,
    definition: Definition,
    permission?: Permission
  ): GraphQLInputObjectType => {
    const perm = permission !== undefined ? permission : this._buildPermission;
    const relationships = definition.relationships || [];
    if (
      !this.getMetaObj(defName, "includeType") &&
      relationships.length > 0
    ) {
      const fields = relationships.reduce(
        (
          o: { [relName: string]: { type: GraphQLInputObjectType } },
          relationship: Relationship
        ) => {
          // Skip relationships the permission layer denies — otherwise a denied
          // association stays joinable/orderable via `include`.
          if (!isRelationshipAllowed(perm, defName, relationship.name, relationship.model)) {
            return o;
          }
          // A relationship whose target model is denied has no output type in the
          // schema either (see gqlize's create-related-fields), so it must not be
          // includable — that would expose a restricted datatype as a join target.
          if (!isModelAllowed(perm, relationship.model)) {
            return o;
          }
          const targetModel = this.getModel(relationship.model);
          // A relationship whose target lives on another adapter has no Sequelize
          // model here, and no SQL JOIN can reach it — it is resolved by the
          // target's own adapter as a separate query. Leaving it in would build
          // the nested input object against `undefined` and crash schema
          // construction, so omit it from `include` entirely.
          if (!targetModel) {
            return o;
          }
          o[relationship.name] = {
            type: new GraphQLInputObjectType({
              name: `GQLT${defName}Include${relationship.name}Object`,
              fields: () => {
                const includeFields: GraphQLInputFieldConfigMap = {
                  required: {
                    type: GraphQLBoolean,
                  },
                  separate: {
                    type: GraphQLBoolean,
                  },
                  where: {
                    type: this.getFilterGraphQLType(
                      targetModel.name,
                      (targetModel as SequelizeModelClass).definition,
                      permission
                    ),
                  },
                };
                // A target whose orderable fields are all denied has no orderBy
                // enum; only expose the field when one exists.
                const targetOrderByType = this.getOrderByGraphQLType(
                  targetModel.name,
                  permission
                );
                if (targetOrderByType) {
                  includeFields.orderBy = {
                    type: targetOrderByType,
                  };
                }
                // A leaf target (no relationships of its own) has no include type;
                // only expose the nested `include` field when one exists.
                const nestedIncludeType = this.getIncludeGraphQLType(
                  targetModel.name,
                  (targetModel as SequelizeModelClass).definition,
                  permission
                );
                if (nestedIncludeType) {
                  includeFields.include = {
                    type: nestedIncludeType,
                  };
                }
                return includeFields;
              },
            }),
          };
          return o;
        },
        {} as { [relName: string]: { type: GraphQLInputObjectType } }
      );
      // The `relationships.length` check above is against the raw list, before
      // permission filtering. If every relationship is denied (or targets a denied
      // model) the field map is empty, and an input object with no fields is an
      // invalid GraphQL type. Leave the meta unset so getDefaultListArgs and the
      // nested `include` guard omit the argument entirely.
      if (Object.keys(fields).length > 0) {
        const includeType = new GraphQLInputObjectType({
          name: `GQLT${defName}IncludeObject`,
          fields,
        });
        this.setMetaObj(defName, "includeType", new GraphQLList(includeType));
      }
    }
    return this.getMetaObj(defName, "includeType");
  };
  getDefaultListArgs = (defName: string, definition: Definition, permission?: Permission): GraphQLFieldConfigArgumentMap => {
    const includeType = this.getIncludeGraphQLType(defName, definition, permission);
    const retVal: GraphQLFieldConfigArgumentMap = {
      where: {
        type: this.getFilterGraphQLType(defName, definition, permission),
      },
    };

    if (includeType) {
      retVal.include = {
        type: includeType,
      };
    }
    return retVal;
  };
  hasInlineCountFeature = () => {
    if (this.options.disableInlineCount) {
      return false;
    }
    const dialect = this.sequelize.getDialect();
    return (
      dialect === "postgres" || dialect === "mssql" || dialect === "sqlite"
    );
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
  processListArgsToOptions = async (
    defName: string,
    args: ListArgs,
    offset?: number,
    _selection?: Selection,
    whereOperators?: WhereOperators,
    defaultOptions: AdapterQueryOptions = {},
    selectedFields?: string[],
    runHook?: RunHook
  ) => {
    let limit,
      include: SequelizeInclude[] = [],
      order: SequelizeOrder[] = [],
      // Clone rather than alias: the array is mutated in place below
      // (unshift/push), so aliasing a caller-provided `defaultOptions.attributes`
      // would accumulate entries across calls.
      attributes: SequelizeAttribute[] = [...(defaultOptions.attributes || [])],
      where;

    // Always bound the page size — an absent first/last must not mean "no limit".
    const requestedPageSize = args.first != null ? args.first : args.last;
    limit = clampPageSize(requestedPageSize);
    if (args.orderBy) {
      order = args.orderBy;
    }
    const fields = this.getFields(defName);
    Object.keys(fields).forEach((key) => {
      const field = fields[key];
      if (!field.primaryKey) {
        if (selectedFields) {
          const fieldForeignTarget = field.foreignTarget
            ? field.foreignTarget.toLowerCase()
            : undefined;
          if (selectedFields.indexOf(key) === -1) {
            if (fieldForeignTarget === undefined) {
              return;
            }
            if (
              fieldForeignTarget !==
              selectedFields[selectedFields.indexOf(fieldForeignTarget)]
            ) {
              return;
            }
          }
        }
        // `DefinitionFieldMeta.name` is optional because a user-authored field
        // carries none — the adapter fills it in. Either way the map is keyed by
        // field name, so `key` is the same value.
        attributes.unshift(field.name || key);
      }
    });
    this.getPrimaryKeyNameForModel(defName).forEach((key) => {
      if (key) {
        attributes.unshift(key);
      }
    });
    if (this.hasInlineCountFeature()) {
      // Either form counts as already present: a plain column named
      // `full_count`, or the `[expression, "full_count"]` alias pair this pushes.
      const hasCountColumn = attributes.some((a) =>
        typeof a === "string" ? a.indexOf("full_count") > -1 : a[1] === "full_count"
      );
      if (!hasCountColumn) {
        if (this.sequelize.getDialect() === "postgres") {
          attributes.push([
            this.sequelize.literal("COUNT(*) OVER()"),
            "full_count",
          ]);
        } else if (
          this.sequelize.getDialect() === "mssql" ||
          this.sequelize.getDialect() === "sqlite"
        ) {
          attributes.push([
            this.sequelize.literal("COUNT(1) OVER()"),
            "full_count",
          ]);
        } else {
          throw new Error(
            `Inline count feature enabled but dialect does not match`
          );
        }
      }
    }
    if (args.where) {
      where = await this.processFilterArgument(args.where, whereOperators, defaultOptions);
    }
    const includeStatements = args.include || [];
    if (includeStatements.length > 0) {
      const result = await this.processIncludeStatement(
        defName,
        includeStatements,
        order,
        defaultOptions,
        [],
        runHook
      );
      order = result.order;
      include = result.include;
    }
    return {
      getOptions: Object.assign(
        {
          order,
          where,
          limit,
          offset,
          include,
          attributes: unique(attributes),
        },
        defaultOptions
      ),
      countOptions: !this.hasInlineCountFeature()
        ? Object.assign(
            {
              where,
              attributes,
              include,
            },
            defaultOptions
          )
        : undefined,
    };
  };
  async processIncludeStatement(
    defName: string,
    includeStatements: IncludeMap[],
    order: SequelizeOrder[],
    options: AdapterQueryOptions,
    parentRelsForOrder: SequelizeOrderPrefix[] = [],
    runHook?: RunHook
  ) {
    let orders = order;
    const incs = await waterfall(
      includeStatements,
      (i, o) => {
        return waterfall(
          Object.keys(i),
          async (relName, oo) => {
            const inc = i[relName];
            const rel = this.getAssociation(defName, relName);
            const TargetModel = this.model(rel.target);
            const targetDefName = TargetModel.definition.name as string;
            const { whereOperators } = TargetModel.definition;
            const orderAssocPrefix = { model: TargetModel, as: relName };
            // A `separate` include runs as its own batched root query, so its
            // ordering/limit/offset live on the include entry itself rather than
            // being hoisted onto the parent query's order. A `required` include
            // must stay an INNER JOIN (it filters the parent rows), which a
            // separate query cannot do — so `required` always wins over separate.
            const separate = Boolean(inc.separate) && !inc.required && rel.associationType === "hasMany";
            if (!separate && (inc.orderBy || []).length > 0) {
              orders = [
                ...orders,
                ...inc.orderBy.map((ob: OrderEntry) => {
                  return [...parentRelsForOrder, orderAssocPrefix, ...ob];
                }),
              ];
            }
            let retVal = {
              model: TargetModel,
              required: inc.required,
              as: relName,
              where: await this.processFilterArgument(
                inc.where || {},
                whereOperators,
                options
              ),
            } as SequelizeInclude;
            if (separate) {
              retVal.separate = true;
              if ((inc.orderBy || []).length > 0) {
                retVal.order = inc.orderBy;
              }
              if (inc.limit != null) {
                retVal.limit = inc.limit;
              }
              if (inc.offset != null) {
                retVal.offset = inc.offset;
              }
              // propagate the GraphQL args accessor so the child model's native
              // find hooks (fired by the separate query) can read rootValue/args.
              if (options && options.getGraphQLArgs) {
                retVal.getGraphQLArgs = options.getGraphQLArgs;
              }
            } else if (runHook) {
              // JOIN-loaded relation: Sequelize does not fire the child model's
              // beforeFind for a JOIN include, so fire it manually with only this
              // relation's `where` and merge any change back into the include's
              // where (keeping the filter part of the single combined query).
              const hookOptions: AdapterQueryOptions = { where: retVal.where, getGraphQLArgs: options?.getGraphQLArgs };
              const res = await runHook(targetDefName, "beforeFind", hookOptions);
              if (res && res.where !== undefined) {
                retVal.where = res.where;
              }
            }
            if (inc.include) {
              const v = await this.processIncludeStatement(
                targetDefName,
                inc.include,
                order,
                options,
                separate ? [] : [...parentRelsForOrder, orderAssocPrefix],
                runHook
              );
              retVal.include = v.include;
              if (!separate) {
                orders = [...orders, ...(v.order || [])];
              }
            }
            return [...oo, retVal];
          },
          o
        );
      },
      []
    );
    return {
      include: incs,
      order: orders,
    };
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
  getGlobalKeys = (defName: string) => {
    const fields = this.getFields(defName);
    return Object.keys(fields).filter((key) => {
      return (
        (fields[key].foreignKey || fields[key].primaryKey) &&
        !fields[key].ignoreGlobalKey
      );
    });
  };
  replaceIdInWhere = (where: AdapterWhere | undefined, defName: string, variableValues?: {[name: string]: any}) => {
    const globalKeys = this.getGlobalKeys(defName);
    return replaceIdDeep(where, globalKeys, variableValues);
  };
  replaceIdInInclude = (
    arrIncludeVar: Selection["include"],
    defName: string,
    variableValues?: {[name: string]: any}
  ) => {
    return (arrIncludeVar || []).map(
      (iv) => {
        return Object.keys(iv).reduce((o, relName) => {
          let { include, where, ...rest } = iv[relName];
          o[relName] = rest;
          const rel = this.getAssociation(defName, relName);
          if (where) {
            o[relName].where = this.replaceIdInWhere(
              where,
              rel.target,
              variableValues
            );
          }
          if (include) {
            o[relName].include = this.replaceIdInInclude(
              include,
              rel.target,
              variableValues
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
    variableValues?: {[name: string]: any}
  ) => {
    let { where, include, ...rest } = args;
    if (include) {
      rest.include = this.replaceIdInInclude(include, defName, variableValues);
    }
    if (where) {
      rest.where = this.replaceIdInWhere(where, defName, variableValues);
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
    return Model.count(options) as Promise<number>;
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
  resolveSingleRelationship = async (
    _defName: string,
    relationship: Association,
    source: SequelizeRow,
    _args: {[name: string]: any},
    _context: RequestContext,
    _selection: Selection,
    options: AdapterQueryOptions
  ): Promise<SequelizeRow> => {
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
      } as AdapterQueryOptions) as Promise<number>;
    }
    return rowFields(source)[relationship.accessors.count]({ where, getGraphQLArgs: options?.getGraphQLArgs });
  };
  resolveManyRelationship = async (
    defName: string,
    relationship: Association,
    source: SequelizeRow,
    args: ListArgs,
    offset: number | undefined,
    whereOperators: WhereOperators | undefined,
    selection: Selection,
    options: AdapterQueryOptions,
    countOnly?: boolean
  ): Promise<AdapterRelationshipPage> => {
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
    const { getOptions, countOptions } = await this.processListArgsToOptions(
      defName,
      args,
      offset,
      selection,
      whereOperators,
      options
    );
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
  let targetOp = Op.eq;
  if (Array.isArray(value)) {
    targetOp = match ? Op.in : Op.notIn;
  } else {
    targetOp = match ? Op.eq : Op.ne;
  }
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
