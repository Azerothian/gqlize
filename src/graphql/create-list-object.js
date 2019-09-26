
import pageInfo from "./objects/page-info";
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLScalarType,
  GraphQLEnumType,
  GraphQLList,
  GraphQLInt,
  GraphQLString,
} from "graphql";

import { fromCursor, toCursor } from "./objects/cursor";
import {capitalize} from "../utils/word";

function processDefaultArgs(args) {
  const newArgs = {};
  if (args.before) {
    newArgs.before = fromCursor(args.before);
  }
  if (args.after) {
    newArgs.after = fromCursor(args.after);
  }
  return Object.assign({}, args, newArgs);
}


export default function createListObject(instance, schemaCache, targetDefName, targetType, resolveData, prefix = "", suffix = "", customArgs) {
  const name = `${capitalize(prefix)}${capitalize(targetDefName)}${capitalize(suffix)}`;
  if (schemaCache.lists[name]) {
    return schemaCache.lists[name]; //TODO: figure out why this is getting hit?
  }
  const fields = instance.getFields(targetDefName);
  let orderBy = schemaCache.orderBy[`${name}OrderBy`];
  if (!orderBy) {
    schemaCache.orderBy[`${name}OrderBy`] = orderBy = new GraphQLList(new GraphQLEnumType({
      name: `${name}OrderBy`,
      values: Object.keys(fields).reduce((o, fieldName) => {
        o[`${fieldName}ASC`] = {value: [fieldName, "ASC"]};
        o[`${fieldName}DESC`] = {value: [fieldName, "DESC"]};
        return o;
      }, {}),
      // description: "",
    }));
  }
  const response = {
    type: new GraphQLObjectType({
      name: `${name}List`,
      fields() {
        return {
          pageInfo: {
            type: pageInfo,
          },
          total: {
            type: GraphQLInt,
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
                }
              },
            })),
          },
        };
      }
    }),
    args: customArgs || Object.assign({
      after: {
        type: GraphQLString,
      },
      first: {
        type: GraphQLInt,
      },
      before: {
        type: GraphQLString,
      },
      last: {
        type: GraphQLInt,
      },
      orderBy: {
        type: orderBy,
      }
    }, instance.getDefaultListArgs(targetDefName)),
    async resolve(source, args, context, info) {
      const a = processDefaultArgs(args);
      let cursor;
      if (args.after || args.before) {
        cursor = fromCursor(args.after || args.before);
      }
      const { total, models } = await resolveData(source, a, context, info);
      const edges = models.map((row, idx) => {
        let startIndex = null;
        if (cursor) {
          startIndex = Number(cursor.index);
        }
        if (startIndex !== null) {
          startIndex++;
        } else {
          startIndex = 0;
        }
        return {
          cursor: toCursor(name, idx + startIndex),
          node: row,
        };
      });

      let startCursor, endCursor;
      if (edges.length > 0) {
        startCursor = edges[0].cursor;
        endCursor = edges[edges.length - 1].cursor;
      }
      let hasNextPage = false;
      let hasPreviousPage = false;
      if (args.first || args.last) {
        const count = parseInt(args.first || args.last, 10);
        let index = cursor ? Number(cursor.index) : null;
        if (index !== null) {
          index++;
        } else {
          index = 0;
        }
        hasNextPage = index + 1 + count <= total;
        hasPreviousPage = index - count >= 0;
        if (args.last) {
          [hasNextPage, hasPreviousPage] = [hasPreviousPage, hasNextPage];
        }
      }
      return {
        pageInfo: {
          hasNextPage,
          hasPreviousPage,
          startCursor,
          endCursor,
        },
        total,
        edges,
      };
    }
  };
  schemaCache.lists[name] = response;
  return schemaCache.lists[name];
}

