import {
  // GraphQLSchema,
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLScalarType,
  GraphQLEnumType,
  // GraphQLList,
} from "graphql";

// import {
//   fromGlobalId,
//   connectionFromArray,
//   nodeDefinitions,
//   connectionDefinitions,
//   connectionArgs,
// } from "graphql-relay";
import { globalIdFieldConfig } from "./utils/global-id-field";
import { isFieldAllowed } from "@azerothian/utilize";
import GQLManager from '../manager';
import { Definition, GqlizeOptions, SchemaCache } from '../types';
import { bindField } from "./resolvers/bind";
import { recordExternalType } from "./snapshot/ledger";


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
          f[key] = bindField(globalIdFieldConfig(fieldDef.allowNull), {
            kind: "globalId",
            defName,
            fieldName: key,
            typeName: globalKeyName,
            nullable: fieldDef.allowNull,
          }, bindingContext);
        } else {
          const type = instance.getGraphQLOutputType(defName, key, fieldDef.type);
          const config = {
            type: fieldDef.allowNull ? type : new GraphQLNonNull(type as any),
            description: ((definition.comments || {}).fields || {})[key] || fieldDef.description,
            args: fieldDef.args,
          };
          // Only fields the user actually gave a resolver get a binding; the
          // rest fall through to graphql's default property resolver.
          f[key] = typeof fieldDef.resolve === "function"
            ? bindField(config, {kind: "modelField", defName, fieldName: key}, bindingContext)
            : config;
        }
        return f;
      }, {} as {[key: string]: any});
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
          let type;
          if (!(overrideFieldDefinition.type instanceof GraphQLObjectType) &&
            !(overrideFieldDefinition.type instanceof GraphQLScalarType) &&
            !(overrideFieldDefinition.type instanceof GraphQLEnumType)) {
            type = new GraphQLObjectType(overrideFieldDefinition.type);
          } else {
            type = overrideFieldDefinition.type;
          }
          recordExternalType(schemaCache, type, {
            via: "definitionOverride",
            defName,
            fieldName,
            use: "type",
          });
          if (!fieldDefinition.allowNull) {
            type = new GraphQLNonNull(type);
          }
          const config = {
            // description: overrideFieldDefinition.description || fieldDefinition.description,
            type,
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
