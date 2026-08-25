
import waterfall from "@azerothian/utilize/utils/waterfall";

import {
  GraphQLObjectType,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLOutputType,
} from "graphql";

import { capitalize } from "@azerothian/utilize/utils/word";
import GQLManager from '../manager';
import { Definitions, GqlFieldMap, GqlizeOptions, SchemaCache, Definition } from '../types';
import type { ExposedMethods } from "@azerothian/utilize/types/index";
import { bindField } from "./resolvers/bind";
import { recordExternalType } from "./snapshot/ledger";



export default function createClassMethods(instance: GQLManager, definitions: Definitions, options: GqlizeOptions, schemaCache: SchemaCache, targetName = "query") {
  return async(defName: string, o: GqlFieldMap) => {
    const definition = definitions[defName];
    let target;
    switch(targetName) {
      case "query": 
        target = definition.expose?.classMethods?.query;
        break;
      case "mutations":
        target = definition.expose?.classMethods?.mutations;
        break;
    }
    if (target) {
      const obj = await createClassMethodFields(instance, defName, definition, target, options, schemaCache, targetName);
      if (Object.keys(obj).length > 0) {
        o[defName] = bindField({
          type: new GraphQLObjectType({
            name: `${defName}${capitalize(targetName)}ClassMethods`,
            fields: obj,
          }),
        }, {kind: "container"}, {instance, options});
      }
    }
    return o;
  };
}

export function createClassMethodFields(instance: GQLManager, defName: string, definition: Definition, query: ExposedMethods, options: GqlizeOptions, schemaCache: SchemaCache, targetName: string) {
  return waterfall(Object.keys(query), (methodName: string, o: GqlFieldMap) => {
    if (options.permission) {
      if (options.permission.queryClassMethods && targetName === "query") {
        const result = options.permission.queryClassMethods(defName, methodName, options.permission.options);
        if (!result) {
          return o;
        }
      } else if (options.permission.mutationClassMethods && targetName === "mutations") {
        const result = options.permission.mutationClassMethods(defName, methodName, options.permission.options);
        if (!result) {
          return o;
        }
      }
    }
    const {type, args} = query[methodName];
    // `ExposedMethod.type` is `unknown`: a definition author supplies either a
    // name to look up or a live GraphQL type, and only the string case is
    // checkable here. Anything else is rejected by graphql when the type builds.
    const outputType = ((typeof type === "string") ? schemaCache.types[type] : type) as GraphQLOutputType | undefined;
    if (!outputType) {
      return o;
    }
    const group = "classMethods" as const;
    const exposeTarget = targetName as "query" | "mutations";
    if (typeof type !== "string") {
      recordExternalType(schemaCache, outputType, {
        via: "definitionExpose", defName, group, target: exposeTarget, methodName, use: "type",
      });
    }
    let newArgs;
    if (args) {
      newArgs = Object.keys(args).reduce((oa, argName) => {
        const arg = args[argName];
        const isNamedRef = arg.type instanceof String || typeof arg.type === "string";
        const argType = isNamedRef ? schemaCache.mutationInputFields[arg.type] : arg.type;
        if (argType) {
          if (!isNamedRef) {
            recordExternalType(schemaCache, argType, {
              via: "definitionExpose", defName, group, target: exposeTarget, methodName, use: "arg", argName,
            });
          }
          oa[argName] = {
            ...arg,
            type: argType,
          };
        }
        return oa;
      }, {} as GraphQLFieldConfigArgumentMap);
    }

    o[methodName] = bindField({
      type: outputType,
      args: newArgs,
      description: (definition.comments?.classMethods || {})[methodName],
    }, {
      kind: "classMethod",
      defName,
      methodName,
      target: targetName as "query" | "mutations",
    }, {instance, options});
    return o;

  }, {});
}
