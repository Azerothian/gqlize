import {GraphQLID, GraphQLNonNull} from "graphql";

/** The type/description half of a relay global-id field — no resolver. */
export function globalIdFieldConfig(isNullable: boolean | undefined) {
  return {
    description: "The ID of an object",
    type: isNullable ? GraphQLID : new GraphQLNonNull(GraphQLID),
  };
}
