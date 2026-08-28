import { Definition, GqlizeOptions, SchemaCache } from "../types";
import GQLManager from '../manager';
import { bindField } from "./resolvers/bind";
import { recordExternalType } from "./snapshot/ledger";
import { deprecationFor } from "@azerothian/utilize";
import type { GraphQLOutputType } from "graphql";


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
          const {type, args, deprecated} = instanceMethods[methodName];
          // A `string` names a model whose type is in the cache; anything else is
          // the built output type itself. The slot is `unknown` because the layer
          // that declares it is graphql-free — see `utils/authored-type`.
          const targetType = ((typeof type === "string") ? schemaCache.types[type] : type) as GraphQLOutputType | undefined;
          if (!targetType) {
            //target does not exist.. excluded from base types?
            return;
          }
          if (options.permission?.queryInstanceMethods) {
            const result = options.permission.queryInstanceMethods(defName, methodName, options.permission.options);
            if (!result) {
              return;
            }
          }
          // Recorded *after* the permission gate: a denied method contributes no
          // field, so its types are not in the schema and the loader must not be
          // asked to re-derive them.
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
          fields[methodName] = bindField({
            type: targetType,
            args,
            description: (definition.comments?.fields || {})[methodName],
            // Instance-method query fields take their description from
            // `comments.fields` rather than `comments.instanceMethods` (which
            // names the `apply` transforms) — deprecation follows the same key.
            deprecationReason: deprecationFor(definition, "fields", methodName, deprecated),
          }, {kind: "instanceMethod", defName, methodName}, {instance, options});
        });
      }
      schemaCache.complexFields[defName] = fields;
    }
    return fields;
  };
}
