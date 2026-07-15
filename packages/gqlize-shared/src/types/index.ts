import Events from "../events";

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
}


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
}

export type DefinitionField = {
  type: any;
  foreignKey?: boolean;
  unique?: boolean;
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
// (arg0: any, arg1: any, arg2: any) => { (): any; new(): any; apply: { (arg0: any, arg1: any[]): any; new(): any; }; })
// type Models = {
//   [name: string]: Model
// }