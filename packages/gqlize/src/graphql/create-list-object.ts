
import pageInfo from "./objects/page-info";
import {
  GraphQLObjectType,
  GraphQLList,
  GraphQLInt,
  GraphQLString,
  GraphQLBoolean,
} from "graphql";

import {capitalize} from "@azerothian/utilize/utils/word";
import { GqlizeOptions, SchemaCache } from '../types';
import GQLManager from "../manager";
import { bindField } from "./resolvers/bind";
import { DataSourceDescriptor } from "./resolvers/types";

/**
 * `data` describes where the page of rows comes from rather than being a
 * closure over it, so the same connection can be rebuilt from a serialized
 * schema. The resolver itself lives in `resolvers/connection.ts`.
 */
export default function createListObject(instance: GQLManager, schemaCache: SchemaCache, targetDefName: string, targetType: any, data: DataSourceDescriptor, prefix = "", suffix = "", customArgs?: any, comment?: string, options: GqlizeOptions = {}) {
  const name = `${capitalize(prefix)}${capitalize(targetDefName)}${capitalize(suffix)}`;
  if (schemaCache.lists[name]) {
    return schemaCache.lists[name]; //TODO: figure out why this is getting hit?
  }
  const orderBy = instance.getOrderByGraphQLType(targetDefName);
  const response = bindField({
    description: comment,
    type: new GraphQLObjectType({
      name: `${name}List`,
      fields() {
        return {
          pageInfo: {
            type: pageInfo,
            description: "Pager object for cursor based operations",
          },
          total: {
            type: GraphQLInt,
            description: "Total amount of records available",
          },
          edges: {
            type: new GraphQLList(new GraphQLObjectType({
              name: `${name}Edge`,
              fields: {
                node: {
                  type: targetType,
                },
                cursor: {
                  type: GraphQLString,
                },
              },
              description: `${name} edge`,
            })),
            description: `List of edges for ${name}`,
          },
        };
      },
    }),
    args: customArgs || Object.assign({
      after: {
        type: GraphQLString,
        description: "If provided it will return results after the provided cursor",
      },
      first: {
        type: GraphQLInt,
        description: "If provided the results will be the first ${amount} of records from provided cursor, if a cursor is not provided the results will be the first ${amount} of records.",
      },
      before: {
        type: GraphQLString,
        description: "If provided it will return results before the provided cursor",
      },
      last: {
        type: GraphQLInt,
        description: "If provided the results will be the first ${amount} of records from provided cursor, if a cursor is not provided  the results will be the last ${amount} of records.",
      },
      orderBy: {
        type: orderBy,
        description: "If provided this will sort the results by the supplied column and direction",
      },
      required: {
        type: GraphQLBoolean,
        description: "When true and this is a nested relationship, the relation is eager-loaded as an INNER JOIN so parents without a matching related row are excluded.",
      }
    }, instance.getDefaultListArgs(targetDefName)),
  }, {
    kind: "connection",
    connectionName: name,
    targetDefName,
    data,
  }, { instance, options });
  schemaCache.lists[name] = response;
  return schemaCache.lists[name];
}

