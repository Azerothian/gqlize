import { Definition, GqlizeOptions, SchemaCache } from "../types";
import GQLManager from '../manager';
import { bindField } from "./resolvers/bind";
import { recordExternalType } from "./snapshot/ledger";


export default function createComplexFieldsFunc(
  defName: string,
  instance: GQLManager,
  definition: Definition,
  options: GqlizeOptions,
  schemaCache: SchemaCache
) {
  return function complexFields() {

    let fields = schemaCache.complexFields[defName];
    if (!fields && schemaCache.types[defName]) {
      fields = {};
      if (definition.expose?.instanceMethods?.query) {
        const instanceMethods = definition.expose.instanceMethods.query;
        Object.keys(instanceMethods).forEach((methodName) => {
          const {type, args} = instanceMethods[methodName];
          let targetType = (typeof type === "string") ? schemaCache.types[type] : type;
          if (!targetType) {
            //target does not exist.. excluded from base types?
            return;
          }
          if (typeof type !== "string") {
            recordExternalType(schemaCache, targetType, {
              via: "definitionExpose",
              defName,
              group: "instanceMethods",
              target: "query",
              methodName,
              use: "type",
            });
          }
          // Instance-method args are passed through verbatim, so their types are
          // whatever the user wrote — always external.
          Object.keys(args || {}).forEach((argName) => {
            recordExternalType(schemaCache, args[argName]?.type, {
              via: "definitionExpose",
              defName,
              group: "instanceMethods",
              target: "query",
              methodName,
              use: "arg",
              argName,
            });
          });
          if (options.permission?.queryInstanceMethods) {
            const result = options.permission.queryInstanceMethods(defName, methodName, options.permission.options);
            if (!result) {
              return;
            }
          }
          fields[methodName] = bindField({
            type: targetType,
            args,
            description: (definition.comments?.fields || {})[methodName],
          }, {kind: "instanceMethod", defName, methodName}, {instance, options});
        });
      }
      schemaCache.complexFields[defName] = fields;
    }
    return fields;
  };
}
