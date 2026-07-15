import { GraphQLInputType, GraphQLOutputType } from "graphql";
import { OrmAdapter, Definition, Association, WhereOperators } from "./index";

/**
 * The GraphQL-facing adapter contract. Extends the GraphQL-free {@link OrmAdapter}
 * with the methods that return `graphql` types or consume GraphQL execution `info`.
 * `@azerothian/gqlize` and the adapter implementation depend on this; `@azerothian/ormize`
 * depends only on `OrmAdapter` and stays graphql-free.
 */
export interface GqlizeAdapter extends OrmAdapter {
  getTypeMapper: () => ((type: any, modelName: string, newTypeName: string) => GraphQLInputType | GraphQLOutputType);
  getDefaultListArgs: (defName: string, definition: Definition) => GraphQLInputType;
  getOrderByGraphQLType: (defName: string, definition: Definition) => GraphQLInputType;
  getFilterGraphQLType: (defName: string, definition: Definition) => GraphQLInputType;
  replaceIdInArgs: (args: any, defName: string, variableValues: any) => any;
  replaceIdInInclude: (include: any, defName: string, variableValues: any) => any;
  resolveManyRelationship: (defName: string, association: Association, source: any, args: any, offset: any, whereOperators: WhereOperators | undefined, info: any, options: any, countOnly?: boolean) => Promise<any>;
  resolveSingleRelationship: (defName: string, association: Association, source: any, args: any, context: any, info: any, options: any) => Promise<any>;
  processListArgsToOptions: (defName: string, args: any, offset: any, info: any, whereOperators: WhereOperators | undefined, graphQLArgs: {getGraphQLArgs: () => {
      context: any;
      info: any;
      source: any;
  }}, selectedFields: any, runHook?: (defName: string, hookName: string, value: any, ...args: any) => Promise<any>) => any;
}
