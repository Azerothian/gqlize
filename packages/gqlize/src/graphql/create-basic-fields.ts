import {
  // GraphQLSchema,
  GraphQLObjectType,
  GraphQLNonNull,
  // GraphQLList,
} from "graphql";
import type { GraphQLNullableOutputType, GraphQLObjectTypeConfig, GraphQLOutputType } from "graphql";

// import {
//   fromGlobalId,
//   connectionFromArray,
//   nodeDefinitions,
//   connectionDefinitions,
//   connectionArgs,
// } from "graphql-relay";
import { globalIdFieldConfig } from "./utils/global-id-field";
import { deprecationFor, isFieldAllowed } from "@azerothian/utilize";
import GQLManager from '../manager';
import { AdapterRow, Definition, GqlFieldMap, GqlizeOptions, RequestContext, SchemaCache } from '../types';
import { bindField } from "./resolvers/bind";
import { recordExternalType } from "./snapshot/ledger";
import { isBuiltOutputType } from "./utils/authored-type";


export default function createBasicFieldsFunc(defName: string, instance: GQLManager, definition: Definition, options: GqlizeOptions, schemaCache: SchemaCache) {
  const bindingContext = {instance, options};
  return function basicFields() {
    let fields = schemaCache.basicFields[defName];
    if (!fields) {
      const modelFields = instance.getFields(defName);
      let exclude = Object.keys(definition.override || {})
        .concat(definition.ignoreFields || []);
      exclude = exclude.concat(Object.keys(modelFields)
        .filter((keyName) => !isFieldAllowed(options.permission, defName, keyName)));
      const fieldKeys = Object.keys(modelFields)
        .filter((k) => exclude.indexOf(k) === -1);
      if (fieldKeys.length === 0) { // no need to continue
        return {};
      }
      fields = fieldKeys.reduce((f, key) => {
        const fieldDef = modelFields[key];
        if (fieldDef.primaryKey || fieldDef.foreignKey) {
          let globalKeyName;
          if (fieldDef.primaryKey) {
            globalKeyName = defName;
          } else {
            globalKeyName = fieldDef.foreignTarget;
          }
          f[key] = bindField({
            ...globalIdFieldConfig(fieldDef.allowNull),
            deprecationReason: deprecationFor(definition, "fields", key, fieldDef.deprecated),
          }, {
            kind: "globalId",
            defName,
            fieldName: key,
            typeName: globalKeyName,
            nullable: fieldDef.allowNull,
          }, bindingContext);
        } else {
          // The adapter's type mapper serves both output and input positions and
          // is declared over the whole type union; this call asks for the output
          // side, and graphql rejects an input-only type when the field builds.
          const type = instance.getGraphQLOutputType(defName, key, fieldDef.type) as GraphQLOutputType;
          // Field args are passed through verbatim, so their types are whatever
          // the user wrote — always external, and invisible to every other
          // recording site.
          Object.keys(fieldDef.args || {}).forEach((argName) => {
            recordExternalType(schemaCache, fieldDef.args[argName]?.type, {
              via: "definitionField",
              defName,
              fieldName: key,
              use: "arg",
              argName,
            });
          });
          const config = {
            type: fieldDef.allowNull ? type : new GraphQLNonNull(type as GraphQLNullableOutputType),
            description: ((definition.comments || {}).fields || {})[key] || fieldDef.description,
            deprecationReason: deprecationFor(definition, "fields", key, fieldDef.deprecated),
            args: fieldDef.args,
          };
          // Only fields the user actually gave a resolver get a binding; the
          // rest fall through to graphql's default property resolver.
          f[key] = typeof fieldDef.resolve === "function"
            ? bindField(config, {kind: "modelField", defName, fieldName: key}, bindingContext)
            : config;
        }
        return f;
      }, {} as GqlFieldMap);
      if (definition.override) {
        const overrideDefs = definition.override;
        fields = Object.keys(definition.override).reduce((f, fieldName) => {
          if (!isFieldAllowed(options.permission, defName, fieldName)) {
            return f;
          }
          const fieldDefinition = modelFields[fieldName]; // modelDefinition.define[fieldName];
          if (!fieldDefinition) {
            throw new Error(`Unable to find the field definition for ${defName}->${fieldName}. Please check your model definition for invalid configuration.`);
          }
          const overrideFieldDefinition = overrideDefs[fieldName];
          // An override may name an already-built type or the config to build one.
          // See `isBuiltOutputType` for why the slot arrives here as `unknown`.
          const namedType = isBuiltOutputType(overrideFieldDefinition.type)
            ? overrideFieldDefinition.type
            : new GraphQLObjectType(overrideFieldDefinition.type as GraphQLObjectTypeConfig<AdapterRow, RequestContext>);
          recordExternalType(schemaCache, namedType, {
            via: "definitionOverride",
            defName,
            fieldName,
            use: "type",
          });
          const type = fieldDefinition.allowNull ? namedType : new GraphQLNonNull(namedType);
          const config = {
            // description: overrideFieldDefinition.description || fieldDefinition.description,
            type,
            // An override replaces the column's *type*, not its identity — the
            // field is still `fieldName` on this model, so it deprecates through
            // the same key as any other field.
            deprecationReason: deprecationFor(definition, "fields", fieldName, fieldDefinition.deprecated),
          };
          f[fieldName] = typeof overrideFieldDefinition.output === "function"
            ? bindField(config, {kind: "overrideOutput", defName, fieldName}, bindingContext)
            : config;
          return f;
        }, fields);
      }
      // if(!fields.id) {
      //   throw new Error("id needs to be supplied");
      // }

      schemaCache.basicFields[defName] = fields;
    }
    return fields;
  };
}
