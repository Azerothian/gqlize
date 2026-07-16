import { GraphQLInputType, GraphQLOutputType } from "graphql";
import { OrmAdapter, Definition } from "./index";

/**
 * The GraphQL-facing adapter contract. Extends the GraphQL-free {@link OrmAdapter}
 * with the methods that return `graphql` types. The data-fetch methods
 * (`processListArgsToOptions`, `resolveManyRelationship`, `resolveSingleRelationship`)
 * now live on {@link OrmAdapter} so `@azerothian/ormize` can drive them graphql-free.
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
}
