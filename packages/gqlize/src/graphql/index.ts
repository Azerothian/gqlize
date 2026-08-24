import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInterfaceType,
} from "graphql";

import createNodeInterface from "./utils/create-node-interface";

import waterfall from "@azerothian/utilize/utils/waterfall";
import { PERMISSION_KEYS, isModelAllowed, isMutationAllowed, unknownPermissionKeys } from "@azerothian/utilize";
import createModelType from "./create-model-type";
import createListObject from "./create-list-object";
import createClassMethods from "./create-class-methods";
import createMutationModel from "./create-mutation-model";
import createMutationInput from "./create-mutation-input";
import createSchemaCache from "./create-schema-cache";
import computeVisibleModels from "./utils/visible-models";
import GQLManager from '../manager';
import { GqlizeOptions, GqlizeAdapter, SchemaCache, SchemaHatch } from '../types';
import { bindField } from "./resolvers/bind";
import { applyExtendFields } from "./extend";
import { createLedger, recordExternalType, setLedger } from "./snapshot/ledger";
import { recordBuild } from "./snapshot/build-registry";
import { GQLIZE_EXT } from "./resolvers/types";
import { enrichDuplicateTypeError } from "./utils/duplicate-types";

/**
 * Deliberately `console.warn` and not the `debug`-based logger, for the same
 * reason the artifact loader gives (`snapshot/materialize.ts`): `debug` is
 * silent unless `DEBUG` is set, which would make an unread permission predicate
 * an invisible event — the exact thing this check exists to surface.
 */
const log = {
  warn: (message: string) => console.warn(message), // eslint-disable-line no-console
};

/**
 * Report permission keys that no builder will ever read.
 *
 * An absent predicate means ALLOW, so a misspelled key does not fail closed —
 * it produces a schema quietly more permissive than its author intended. Warn
 * rather than throw: the schema is still valid, and failing a build over a
 * stray key would be a worse trade than a loud message.
 *
 * Exported because `materializeSchema` needs the same check: the artifact path
 * never runs this builder, but it still takes a live `options.permission` (for
 * `applyExtendFields` and the `node(id:)` fetcher), so a typo is exactly as
 * invisible there.
 */
export function warnUnknownPermissionKeys(options: GqlizeOptions) {
  const unknown = unknownPermissionKeys(options.permission);
  if (unknown.length === 0) {
    return;
  }
  log.warn(
    `gqlize: options.permission has ${unknown.length === 1 ? "a key" : "keys"} nothing reads — ` +
      `${unknown.join(", ")}. An absent predicate means ALLOW, so ${unknown.length === 1 ? "this key gates" : "these keys gate"} ` +
      `nothing and the schema is more permissive than it looks. Accepted keys: ${PERMISSION_KEYS.join(", ")}.`,
  );
}

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
      o[defName] = createListObject(instance, schemaCache, defName, schemaCache.types[defName], {
        source: "findAll",
        defName,
      }, "", "", undefined, undefined, options);
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
        const mutationModel = await createMutationModel(instance, defName, schemaCache, createResult, updateResult, deleteResult, options);
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

  warnUnknownPermissionKeys(gqlizeOptions);

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
  const {extend = {}, root} = options;
  const schemaCache = createSchemaCache();
  const bindingContext = {instance, options};
  // Rides on the schema cache: same per-build lifetime, and it is already
  // threaded through every builder that can meet a user-supplied type.
  const ledger = setLedger(schemaCache, createLedger());

  // Capture the configured permission on each adapter so its GraphQL type
  // builders (filter/order/include) exclude permission-denied fields and
  // relationships — otherwise a hidden field stays filterable/orderable and a
  // denied relationship stays joinable (information-disclosure oracle).
  Object.keys(definitions).forEach((defName) => {
    const adapter = instance.getModelAdapter(defName) as GqlizeAdapter | undefined;
    adapter?.setBuildPermission?.(options.permission);
    // `whereOperatorTypes` is read straight off the definition by the adapters'
    // filter builders, so a user type declared there reaches the schema without
    // passing any gqlize builder that could record it. Record it here instead:
    // it is user-authored, and an artifact that clones it duplicates the name
    // against the live instance the same type reaches through any other path.
    const whereOperatorTypes: Record<string, any> = (definitions[defName] as any)?.whereOperatorTypes || {};
    Object.keys(whereOperatorTypes).forEach((operator) => {
      recordExternalType(schemaCache, whereOperatorTypes[operator], {
        via: "definitionWhereOperator",
        defName,
        operator,
      });
    });
  });

  // Side-effecting: populates `schemaCache.types`, which is what is read below.
  await waterfall(Object.keys(definitions),
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
    // The relay node field closes over a live id-fetcher that re-checks
    // permissions per request; it is always rebuilt, never serialized.
    node: bindField(nodeField, {kind: "nodeField"}, bindingContext),
  };
  let mutationRootFields: any = {};
  if (Object.keys(queryLists).length > 0) {
    queryRootFields.models = bindField({
      type: new GraphQLObjectType({
        name: "QueryModels",
        fields() {
          return queryLists;
        },
      }),
    }, {kind: "container"}, bindingContext);
  }
  if (Object.keys(classMethodQueries).length > 0) {
    queryRootFields.classMethods = bindField({
      type: new GraphQLObjectType({name: "QueryClassMethods", fields: classMethodQueries}),
    }, {kind: "container"}, bindingContext);
  }
  queryRootFields = await applyExtendFields(queryRootFields, extend?.query, "query", options, bindingContext, ledger);
  if (Object.keys(queryRootFields).length > 0) {
    rootSchema.query = new GraphQLObjectType({
      name: "RootQuery",
      fields: queryRootFields,
    });
  }

  if (Object.keys(mutationCollection).length > 0) {
    mutationRootFields.models = bindField({
      type: new GraphQLObjectType({name: "MutationModels", fields: mutationCollection}),
    }, {kind: "container"}, bindingContext);
  }
  if (Object.keys(classMethodMutations).length > 0) {
    mutationRootFields.classMethods = bindField({
      type: new GraphQLObjectType({name: "MutationClassMethods", fields: classMethodMutations}),
    }, {kind: "container"}, bindingContext);
  }
  mutationRootFields = await applyExtendFields(mutationRootFields, extend?.mutation, "mutation", options, bindingContext, ledger);
  if (Object.keys(mutationRootFields).length > 0) {
    rootSchema.mutation = new GraphQLObjectType({
      name: "Mutation",
      fields: mutationRootFields,
    });
  }

  // Record the exact key set handed to the mapper rather than re-deriving it
  // later — `node(id:)` and `__resolveType` break silently if it differs.
  ledger.modelTypes = Object.keys(schemaCache.types);
  nodeTypeMapper.mapTypes(schemaCache.types);

  if (!rootSchema.query) {
    throw new Error("GraphQLSchema requires query to be set. Are your permissions settings to aggressive?");
  }
  return {
    types: schemaCache.types,
    ledger,
    root: Object.assign(rootSchema, {...root})
  };
}

export async function createSchema(dbInstance: GQLManager, options: GqlizeOptions = {}) {
  const schemaObjects = await createSchemaObjects(dbInstance, options);
  let schema;
  try {
    schema = new GraphQLSchema({
      ...schemaObjects.root,
      extensions: {
        ...(schemaObjects.root.extensions || {}),
        [GQLIZE_EXT]: schemaObjects.ledger,
      },
    });
  } catch(err) {
    // A duplicate name here means two instances of one type reached the build —
    // most often the same name declared twice across `extend`, `root` and a
    // definition. Report where each one sits rather than graphql's bare name.
    throw enrichDuplicateTypeError(
      err,
      schemaObjects.root,
      new Map(),
      "Check `options.extend` and `options.root` for a type whose name a definition also produces.",
    );
  }

  (schema as GraphQLSchema & {$sql2gql?: SchemaHatch}).$sql2gql = {
    types: schemaObjects.types,
  };
  // Lets `snapshotSchema(schema)` fingerprint the definitions later without the
  // caller threading the orm back in. Off the hot path — a WeakMap set, no hashing.
  recordBuild(schema, dbInstance, options);
  return schema;
}
