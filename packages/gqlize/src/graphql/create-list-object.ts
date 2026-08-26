
import pageInfo from "./objects/page-info";
import {
  GraphQLObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLInt,
  GraphQLString,
  GraphQLBoolean,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLOutputType,
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
export default function createListObject(instance: GQLManager, schemaCache: SchemaCache, targetDefName: string, targetType: GraphQLOutputType, data: DataSourceDescriptor, prefix = "", suffix = "", customArgs?: GraphQLFieldConfigArgumentMap, comment?: string, options: GqlizeOptions = {}) {
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
          // Non-null per the Relay Connections spec. `resolvers/connection.ts`
          // always returns a `pageInfo` and always an `edges` array, and it
          // mints every edge's cursor itself, so none of these three can be
          // null in practice — only in the types a client generates from them.
          pageInfo: {
            type: new GraphQLNonNull(pageInfo),
            description: "Pager object for cursor based operations",
          },
          // `total` stays nullable: it is a separate COUNT that
          // `build-include-from-selection.ts` may legitimately skip.
          total: {
            type: GraphQLInt,
            description: "Total amount of records available",
          },
          edges: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(new GraphQLObjectType({
              name: `${name}Edge`,
              fields: {
                // `node` stays nullable. The connection resolver drops edges
                // whose node an OUTPUT hook rejected, so it is non-null today,
                // but the value is fetched a page at a time and resolved per
                // edge — the row can go away in between, and a null node is a
                // better answer there than a null page.
                node: {
                  type: targetType,
                },
                cursor: {
                  type: new GraphQLNonNull(GraphQLString),
                },
              },
              description: `${name} edge`,
            })))),
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
      required: {
        type: GraphQLBoolean,
        description: "When true and this is a nested relationship, the relation is eager-loaded as an INNER JOIN so parents without a matching related row are excluded.",
      }
    }, orderBy ? {
      // Permissions can deny every orderable field, leaving no orderBy enum to
      // reference — omit the argument rather than emitting `type: undefined`.
      orderBy: {
        type: orderBy,
        description: "If provided this will sort the results by the supplied column and direction",
      },
    } : {}, instance.getDefaultListArgs(targetDefName)),
  }, {
    kind: "connection",
    connectionName: name,
    targetDefName,
    data,
  }, { instance, options });
  schemaCache.lists[name] = response;
  return schemaCache.lists[name];
}

