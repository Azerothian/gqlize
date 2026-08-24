import {
  GraphQLObjectType,
  GraphQLList,
} from "graphql";

import createBasicFieldsFunc from "./create-basic-fields";
import createRelatedFieldsFunc from "./create-related-fields";
import createComplexFieldsFunc from "./create-complex-fields";
import { isModelAllowed } from "@azerothian/utilize";
import GQLManager from "../manager";
import { ModelTypeHatch, SchemaCache } from '../types';


export default async function createModelType(defName: string, instance: GQLManager, options: any, nodeInterface: any, schemaCache: SchemaCache, prefix = "") {
  if (!isModelAllowed(options.permission, defName)) {
    return undefined;
  }
  const definition = instance.getDefinition(defName);
  const basicFields = createBasicFieldsFunc(defName, instance, definition, options, schemaCache);
  const relatedFields = createRelatedFieldsFunc(defName, instance, definition, options, schemaCache);
  const complexFields = createComplexFieldsFunc(defName, instance, definition, options, schemaCache);

  const obj = new GraphQLObjectType({
    name: `${prefix}${defName}`,
    description: definition.comment,
    // isTypeOf(val) {
    //   return instance.isTypeOf(defName, definition, val);
    // },
    fields() {
      const basic = basicFields();
      const related = relatedFields();
      const complex = complexFields();
      return Object.assign({}, basic, related, complex);
      // if (!f.id) {
      //   throw new Error("id must be implemented");
      // }
      // return f;
    },
    interfaces() {
      const basic = basicFields();
      if (basic.id) {
        return [nodeInterface];
      }
      return [];
    },
  });
  (obj as GraphQLObjectType & {$sql2gql?: ModelTypeHatch}).$sql2gql = {
    basicFields: basicFields,
    complexFields: complexFields,
    relatedFields: relatedFields,
    fields: {},
    // events: {before, after}
  };
  schemaCache.types[defName] = obj;
  schemaCache.types[`${defName}[]`] = new GraphQLList(obj);
  return obj;
}
