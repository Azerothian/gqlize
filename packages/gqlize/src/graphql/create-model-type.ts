import {
  GraphQLObjectType,
  GraphQLList,
} from "graphql";

import createBasicFieldsFunc from "./create-basic-fields";
import createRelatedFieldsFunc from "./create-related-fields";
import createComplexFieldsFunc from "./create-complex-fields";
import { isModelAllowed } from "@azerothian/utilize";
import { assertNoExposedMethodCollisions } from "@azerothian/utilize/exposed-methods";
import GQLManager from "../manager";
import { ModelTypeHatch, SchemaCache } from '../types';

export default async function createModelType(defName: string, instance: GQLManager, options: any, nodeInterface: any, schemaCache: SchemaCache, prefix = "") {
  if (!isModelAllowed(options.permission, defName)) {
    return undefined;
  }
  const definition = instance.getDefinition(defName);
  // Cheapest place to catch a name an exposed instance method can never own:
  // this is the one point that sees the model's columns and its expose block
  // together, and it runs before anything has had a chance to shadow the other.
  assertNoExposedMethodCollisions(defName, definition, Object.keys(instance.getFields(defName)));
  const basicFields = createBasicFieldsFunc(defName, instance, definition, options, schemaCache);
  const relatedFields = createRelatedFieldsFunc(defName, instance, definition, options, schemaCache);
  const complexFields = createComplexFieldsFunc(defName, instance, definition, options, schemaCache);

  const obj = new GraphQLObjectType({
    name: `${prefix}${defName}`,
    description: definition.comment,
    fields() {
      const basic = basicFields();
      const related = relatedFields();
      const complex = complexFields();
      return Object.assign({}, basic, related, complex);
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
  };
  schemaCache.types[defName] = obj;
  schemaCache.types[`${defName}[]`] = new GraphQLList(obj);
  return obj;
}
