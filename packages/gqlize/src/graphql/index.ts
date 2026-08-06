import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInterfaceType,
} from "graphql";

import createNodeInterface from "./utils/create-node-interface";

import waterfall from "@azerothian/utilize/utils/waterfall";
import { isModelAllowed, isMutationAllowed } from "@azerothian/utilize";
import createModelType from "./create-model-type";
import createListObject from "./create-list-object";
import createClassMethods from "./create-class-methods";
import createMutationModel from "./create-mutation-model";
import createMutationInput from "./create-mutation-input";
import createSchemaCache from "./create-schema-cache";
import computeVisibleModels from "./utils/visible-models";
import GQLManager from '../manager';
import { GqlizeOptions, SchemaCache } from '../types';

export function createModelTypes(instance: GQLManager, options: GqlizeOptions, nodeInterface: GraphQLInterfaceType, schemaCache: SchemaCache) {
  return async(defName: string, o: any) => {
    if (!isModelAllowed(options.permission, defName)) {
      return o;
    }
    o[defName] = await createModelType(defName, instance, options, nodeInterface, schemaCache);
    return o;
  };
}
export function createListObjects(instance: GQLManager, schemaCache: SchemaCache, options: GqlizeOptions) {
  return async(defName:string, o: any) => {
    if (schemaCache.types[defName]) {
      if (options.permission?.query) {
        const result = await options.permission.query(defName, options.permission.options);
        if (!result) {
          return o;
        }
      }
      o[defName] = createListObject(instance, schemaCache, defName, schemaCache.types[defName], (source, args, context, info) => {
        return instance.resolveFindAll(defName, source, args, context, info);
      }, "", "");
    }
    return o;
  };
}

function createMutationInputs(instance: GQLManager, options: GqlizeOptions, schemaCache: SchemaCache, mutableDefNames: Set<string>) {
  return async(defName: string, inputTypes: any) => {
    if (mutableDefNames.has(defName)) {
      inputTypes[defName] = await createMutationInput(instance, defName, schemaCache, inputTypes, options, mutableDefNames);
    }
    return inputTypes;
  };
}


function createMutationModels(instance: GQLManager, options: GqlizeOptions, schemaCache: SchemaCache, mutableDefNames: Set<string>) {
  return async(defName: string, o: any) => {
    if (mutableDefNames.has(defName)) {
      const updateResult = isMutationAllowed(options.permission, defName, "update");
      const deleteResult = isMutationAllowed(options.permission, defName, "delete");
      const createResult = isMutationAllowed(options.permission, defName, "create");
      if (createResult || updateResult || deleteResult) {
        const mutationModel = await createMutationModel(instance, defName, schemaCache, createResult, updateResult, deleteResult);
        // Every input the mutation would have accepted can be denied away — a
        // field with no arguments could not mutate anything, so drop it.
        if (Object.keys(mutationModel.args).length > 0) {
          o[defName] = mutationModel;
        }
      }
    }
    return o;
  };
}

export async function createSchemaObjects(instance: GQLManager, gqlizeOptions: GqlizeOptions) {
  const rootSchema: any = {};
  const definitions = instance.getDefinitions();

  // Permissions can deny every field of a model, which would emit an output type
  // with no fields — an invalid GraphQL type. Resolve which models still have a
  // visible field and fold the answer back into the permission bag as a stricter
  // `model` predicate, so every builder below (and the adapters' include types)
  // sees the same set of models.
  const visibleModels = computeVisibleModels(instance, definitions, gqlizeOptions);
  const options: GqlizeOptions = visibleModels.size === Object.keys(definitions).length ? gqlizeOptions : {
    ...gqlizeOptions,
    permission: {
      ...(gqlizeOptions.permission || {}),
      model: (defName: string) => visibleModels.has(defName),
    },
  };

  const {nodeInterface, nodeField, nodeTypeMapper} = createNodeInterface(instance, options);
  const {subscriptions, extend = {}, root} = options;
  const schemaCache = createSchemaCache();

  // Capture the configured permission on each adapter so its GraphQL type
  // builders (filter/order/include) exclude permission-denied fields and
  // relationships — otherwise a hidden field stays filterable/orderable and a
  // denied relationship stays joinable (information-disclosure oracle).
  Object.keys(definitions).forEach((defName) => {
    const adapter: any = instance.getModelAdapter(defName);
    if (adapter && typeof adapter.setBuildPermission === "function") {
      adapter.setBuildPermission(options.permission);
    }
  });

  const types = await waterfall(Object.keys(definitions),
    createModelTypes(instance, options, nodeInterface, schemaCache), schemaCache.types);

  const queryLists = await waterfall(Object.keys(definitions),
    createListObjects(instance, schemaCache, options), schemaCache.lists);

  const classMethodQueries = await waterfall(Object.keys(definitions),
    createClassMethods(instance, definitions, options, schemaCache), schemaCache.classMethodQueries);

  // Which models get mutation inputs at all, resolved up-front. Each model's
  // input builder needs to know synchronously whether a relationship's target
  // will contribute a field; asking `schemaCache.mutationInputs` for that would
  // depend on the order of the waterfall below.
  const mutableDefNames = new Set<string>();
  for (const defName of Object.keys(definitions)) {
    if (!schemaCache.types[defName]) {
      continue;
    }
    if (options.permission?.mutation && !(await options.permission.mutation(defName, options.permission.options))) {
      continue;
    }
    mutableDefNames.add(defName);
  }

  await waterfall(Object.keys(definitions),
    createMutationInputs(instance, options, schemaCache, mutableDefNames), schemaCache.mutationInputs);

  const mutationCollection = await waterfall(Object.keys(definitions),
    createMutationModels(instance, options, schemaCache, mutableDefNames), schemaCache.mutationModels);

  const classMethodMutations = await waterfall(Object.keys(definitions),
    createClassMethods(instance, definitions, options, schemaCache, "mutations"), schemaCache.classMethodMutations);


  let queryRootFields: any = {
    node: nodeField,
  };
  let mutationRootFields: any = {};
  if (Object.keys(queryLists).length > 0) {
    queryRootFields.models = {
      type: new GraphQLObjectType({
        name: "QueryModels",
        fields() {
          return queryLists;
        },
      }),
      resolve() {
        return {};
      },
    };
  }
  if (Object.keys(classMethodQueries).length > 0) {
    queryRootFields.classMethods = {
      type: new GraphQLObjectType({name: "QueryClassMethods", fields: classMethodQueries}),
      resolve() {
        return {};
      },
    };
  }
  if (extend?.query) {
    queryRootFields = await waterfall(Object.keys(extend.query), async(k, o) => {
      if (options.permission?.queryExtension) {
        const result = await options.permission.queryExtension(k, options.permission.options);
        if (!result) {
          return o;
        }
      }
      o[k] = extend.query[k];
      return o;
    }, queryRootFields);
  }
  if (Object.keys(queryRootFields).length > 0) {
    rootSchema.query = new GraphQLObjectType({
      name: "RootQuery",
      fields: queryRootFields,
    });
  }



  if (Object.keys(mutationCollection).length > 0) {
    mutationRootFields.models = {
      type: new GraphQLObjectType({name: "MutationModels", fields: mutationCollection}),
      resolve() {
        return {};
      },
    };
  }
  if (Object.keys(classMethodMutations).length > 0) {
    mutationRootFields.classMethods = {
      type: new GraphQLObjectType({name: "MutationClassMethods", fields: classMethodMutations}),
      resolve() {
        return {};
      },
    };
  }
  if ((extend || {}).mutation) {
    mutationRootFields = await waterfall(Object.keys(extend.mutation), async(k, o) => {
      if (options.permission?.mutationExtension) {
        const result = await options.permission.mutationExtension(k, options.permission.options);
        if (!result) {
          return o;
        }
      }
      o[k] = extend.mutation[k];
      return o;
    }, mutationRootFields);
  }
  if (Object.keys(mutationRootFields).length > 0) {
    rootSchema.mutation = new GraphQLObjectType({
      name: "Mutation",
      fields: mutationRootFields,
    });
  }
  // rootSchema.INode = {
  //   __resolveType: (obj, context, info) => {
  //     return false;
  //   },
  // };

  // const relayTypes = Object.keys(sqlInstance.models).reduce((types, name) => {
  //   if (typeCollection[name]) {
  //     types[name] = typeCollection[name];
  //   }
  //   return types;
  // }, {});

  // const relayTypes = Object.keys(instance.getModels());
  nodeTypeMapper.mapTypes(schemaCache.types);

  // const subscriptionRootFields = Object.assign({}, subscriptions);

  // if ((sqlInstance.$sqlgql || {}).subscriptions) {
  //   const {pubsub} = (sqlInstance.$sqlgql || {}).subscriptions;
  //   subscriptionRootFields = await createSubscriptionFunctions(pubsub, sqlInstance.models, validKeys, typeCollection, options);
  //   if (Object.keys(subscriptionRootFields).length > 0) {
  //     rootSchema.subscription = new GraphQLObjectType({
  //       name: "Subscription",
  //       fields: subscriptionRootFields,
  //     });
  //   }
  // }
  // const extensions = {};
  // const schemaParams = Object.assign(rootSchema, extensions);

  if (!rootSchema.query) {
    throw new Error("GraphQLSchema requires query to be set. Are your permissions settings to aggressive?");
  }
  return {
    types: schemaCache.types,
    root: Object.assign(rootSchema, {...root})
  };
}


function searchForType(name: string, path: string, arr: any = {found: [], diff: []}, obj: any, typeCollection:any[] = []) {
  if (typeCollection.indexOf(obj) > -1) {
    return arr;
  }
  typeCollection.push(obj);
  let oo = obj;
  if (obj.ofType) {
    oo = obj.ofType;
  }
  if (oo.toConfig) {
    oo = oo.toConfig();
  }

  if (oo.name === name) {
    if(arr.found.indexOf(oo) === -1) {
      arr.found.push(oo);
      arr.diff.push(`${path}/${oo.name}`);
    }
  }
  if (oo.fields) {
    const k = Object.keys(oo.fields);
    for (let i = 0; i < k.length; i++) {
      let {type} = oo.fields[k[i]];
      searchForType(name, `${path}/${oo.name}/${k[i]}`, arr, type, typeCollection);
    }
  }
  return arr;
}


export async function createSchema(dbInstance: GQLManager, options: GqlizeOptions = {}) {
  const schemaObjects = await createSchemaObjects(dbInstance, options);
  let schema;
  try {
    schema = new GraphQLSchema(schemaObjects.root);
  } catch(err) {
    const test = searchForType("Node", "", undefined, schemaObjects.root.query);
    //const firstInstance = searchForType(, "", schemaObjects.root.query)
    throw err;
  }

  (schema as any).$sql2gql = {
    types: schemaObjects.types,
  };
  return schema;
}
