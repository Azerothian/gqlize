import Events from "../events";
import { DataTypeDescriptor } from "./data-type";

/**
 * An unmanaged, adapter-native transaction. `handle` is the token threaded onto
 * each operation's options (e.g. a Sequelize Transaction); `commit`/`rollback`
 * finalise it. Returned by `OrmAdapter.beginTransaction`.
 */
export interface AdapterTransaction {
  handle: any;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * The backend (ORM) adapter contract. This is GraphQL-free — it is the interface
 * `@azerothian/ormize` depends on. The GraphQL-typed extension lives in
 * `./gqlize-adapter` (`GqlizeAdapter extends OrmAdapter`) so importing ormize never
 * pulls `graphql`.
 */
export interface OrmAdapter {
  adapterName: string;
  createModel: (def: Definition, hooks?: any) => Promise<any>;
  getModel: (modelName: string) => Model;
  getAssociations: (defName: string) => {[relName: string]: Association};
  getValueFromInstance: (model: Model, sourceKey: string) => any;
  getFields: (defName: any) => {[fieldName: string]: DefinitionField};
  createRelationship: (defName: string, modelName: string, relName: string, relType: string, relOptons: any) => any;
  getPrimaryKeyNameForModel: (modelName: string) => string[];
  createFunctionForFind: (modelName: string) => (keyValue: string, filterKey: string, singular: boolean) => ((...args: any) => any);
  reset: (options?: any) => Promise<void>;
  initialise: () => Promise<void>;
  sync: (options?: any) => Promise<void>;
  hasInlineCountFeature: () => boolean;
  findAll: (defName: string, options: any) => Promise<any>
  getInlineCount: (models: any) => Promise<number>;
  count: (defName: string, options: any) => Promise<number>;
  processFilterArgument: (where: any, whereOperators: any, options: any) => any
  update: (model: any, i: any, defaultOptions: any) => Promise<any>;
  getCreateFunction: (defName: string) => any;
  getUpdateFunction: (defName: string, whereOperators: WhereOperators | undefined) => any;
  getDeleteFunction: (defName: string, whereOperators: WhereOperators | undefined) => any;
  /**
   * Optional: run a callback inside a transaction (auto-commit / auto-rollback).
   * When present, ormize wraps single-adapter multi-step mutations in it.
   * Adapters that cannot provide transactions may omit it — mutations then run
   * without one.
   */
  transaction?: (cb: (t: any) => Promise<any>) => Promise<any>;
  /**
   * Optional: begin an UNMANAGED transaction, returning a handle the caller
   * commits or rolls back explicitly. Required for cross-adapter coordination
   * (`orm.transaction`): the coordinator begins one per adapter and commits/rolls
   * back them together. `handle` is the adapter-native transaction token that is
   * threaded onto each operation's options.
   */
  beginTransaction?: () => Promise<AdapterTransaction>;
  /** Read: classify an adapter-native type into an abstract `DataTypeDescriptor`. */
  mapDataType: (nativeType: any) => DataTypeDescriptor;
  /** Write: convert an abstract type token/descriptor back to an adapter-native type. */
  toNativeType: (descriptor: DataTypeDescriptor) => any;
  /**
   * Turn list/relationship args into backend fetch options. GraphQL-free: the
   * caller passes a {@link Selection} carrying any selected-field/count hints; the
   * raw execution `info` (if any) rides along on `selection.raw`.
   */
  processListArgsToOptions: (defName: string, args: any, offset: any, selection: Selection, whereOperators: WhereOperators | undefined, graphQLArgs: {getGraphQLArgs: () => {
      context: any;
      info: any;
      source: any;
  }}, selectedFields: any, runHook?: (defName: string, hookName: string, value: any, ...args: any) => Promise<any>) => any;
  resolveManyRelationship: (defName: string, association: Association, source: any, args: any, offset: any, whereOperators: WhereOperators | undefined, selection: Selection, options: any, countOnly?: boolean) => Promise<any>;
  resolveSingleRelationship: (defName: string, association: Association, source: any, args: any, context: any, selection: Selection, options: any) => Promise<any>;
}

/**
 * Backend-agnostic description of what a resolver wants fetched. Replaces the
 * GraphQL execution `info` in the ormize engine so the engine stays graphql-free.
 * GraphQL callers (gqlize) populate this from `info`; other callers (e.g. REST)
 * build it directly. `translateFilter`/`translateId` default to identity — gqlize
 * injects relay global-id translation.
 */
export type Selection = {
  /** eager-include plan (relations to JOIN) */
  include?: any[];
  /** selected scalar field names */
  fields?: string[];
  /** fetch count without rows */
  countOnly?: boolean;
  /** raw arg variables (caller-provided) */
  variableValues?: any;
  /** opaque passthrough; gqlize stashes the real GraphQLResolveInfo here so hooks still see `info` */
  raw?: any;
  /** default identity; gqlize passes replaceIdDeep bound to variableValues */
  translateFilter?: (where: any, globalKeys: string[]) => any;
  /** default identity; gqlize passes v => fromGlobalId(v).id */
  translateId?: (value: any) => any;
};


export type GqlizeOptions = {
  globalHooks?: {[name: string]: {}}
  permission?: { 
    options?: any
    model?: (defName: string, options?: any) => boolean; 
    query?: (defName: string, options?: any) => boolean; 
    mutation?: (defName: string, options?: any) => boolean; 
    mutationUpdate?: (defName: string, options?: any) => boolean; 
    mutationDelete?: (defName: string, options?: any) => boolean;
    mutationCreate?: (defName: string, options?: any) => boolean;
    queryExtension?: (defName: string, options?: any) => boolean;
    mutationExtension?: (defName: string, options?: any) => boolean;
    mutationUpdateInput?: (defName: string, fieldName: string, options?: any) => boolean;
    mutationCreateInput?: (defName: string, fieldName: string, options?: any) => boolean;
    field?: (defName: string, fieldName: string, options?: any) => boolean; 
    queryClassMethods?: (defName: string, methodName: string, options?: any) => boolean;
    mutationClassMethods?: (defName: string, methodName: string, options?: any) => boolean;
    queryInstanceMethods?: (defName: string, methodName: string, options?: any) => boolean;
    relationship?: (defName: string, relName: string, targetName: string, options?: any) => boolean; 
  },
  extend?: any,
  root?: any,
  subscriptions?: any
}

export type SchemaCache = {
  mutationInputFields: { [x: string]: any; };
  basicFields: { [x: string]: any; };
  types: { [x: string]: any; };
  lists: { [x: string]: any; };
  complexFields: { [x: string]: any; };
  typeFields: { [x: string]: any; };
  orderBy: { [x: string]: any; };
  classMethodQueries:  { [x: string]: any; };
  classMethodMutations: { [x: string]: any; };
  mutationInputs: { [x: string]: any; };
  mutationModels: { [x: string]: any; };
  relatedFields: { [x: string]: any; };
}


export type Association = {
  name: string;
  target: string;
  source: string;
  foreignKey: string;
  targetKey: string;
  sourceKey: string;
  associationType: string;
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
    constraints?: boolean;
    through?: {
      model?: string;
      foreignKey?: string;
      otherKey?: string;
    } | string;
  };
}

export type DefinitionFieldMeta = {
  name?: string;
  type: any;
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
  type: any;
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
  foreignTarget?: string;
  resolve?: any;
  args?: any;
  comment?: string;
  defaultValue?: any;
  values?: string[];
  validate?:  {
    [key: string]: {
      [key: string]: any
    };
  }
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
      type?: any,
      inputType?: any,
      input?: (o: any, args: any, context: any, info: any, model: any) => any;
      output?: any
    }
  }; 
  ignoreFields?: any;
  comments?: any;
  relationships?: Relationship[];
  whereOperators?: WhereOperators;
  whereOperatorTypes?: { [x: string]: any };
  before?: (options: { params: any, model?: any, args: any, context: any, info: any, modelDefinition: Definition, type: Events}) => any;
  after?: (options: { result: any, args: any, context: any, info: any, modelDefinition: Definition, type: Events}) => any;
  expose?: {
    classMethods?: {
      query?: {
        [name: string]: {
          type: any;
          args?: any;
          before?: any;
          after?: any;
        }
      }
      mutations?: {
        [name: string]: {
          type: any;
          args?: any;
          before?: any;
          after?: any;
        }
      }
    },
    instanceMethods?: {
      query?: {
        [name: string]: {
          type: any;
          args?: any;
          before?: any;
          after?: any;
        }
      }
      mutations?: {
        [name: string]: {
          type: any;
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

export type Definitions = {
  [name: string]: Definition
}

export type Model = {
  [name: string]: any
  prototype: any
}

export type HookMap = {
  [hookName: string]: ((...args: any) => any)[] |((...args: any) => any)
}

export * from "./orm";
export * from "./data-type";
// (arg0: any, arg1: any, arg2: any) => { (): any; new(): any; apply: { (arg0: any, arg1: any[]): any; new(): any; }; })
// type Models = {
//   [name: string]: Model
// }