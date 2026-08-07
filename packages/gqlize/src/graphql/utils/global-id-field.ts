import {GraphQLID, GraphQLNonNull} from "graphql";

import { globalIdResolver } from "../resolvers/model-field";

/** The type/description half of a relay global-id field — no resolver. */
export function globalIdFieldConfig(isNullable: any) {
  return {
    description: "The ID of an object",
    type: isNullable ? GraphQLID : new GraphQLNonNull(GraphQLID),
  };
}

export default function globalIdField(typeName: any, idFetcher: (arg0: any, arg1: any, arg2: any) => any, isNullable: any) {
  return {
    ...globalIdFieldConfig(isNullable),
    resolve: globalIdResolver(typeName, idFetcher, isNullable),
  };
}
