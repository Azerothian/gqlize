
import {
  GraphQLObjectType,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLString,
} from "graphql";

/**
 * The Relay Connections spec requires `hasNextPage` and `hasPreviousPage` to be
 * `Boolean!`. The connection resolver has always derived both from the returned
 * window's absolute position and returns real booleans either way, so the
 * nullable spelling only ever bought clients a null check they could not trigger
 * — and cost them, because codegen turns `Boolean` into `boolean | null`.
 *
 * The cursors stay nullable: an empty page genuinely has no first or last edge
 * to name, which the spec allows for.
 */
export default new GraphQLObjectType({
  name: "PageInfo",
  fields() {
    return {
      "hasNextPage": {
        type: new GraphQLNonNull(GraphQLBoolean),
      },
      "hasPreviousPage": {
        type: new GraphQLNonNull(GraphQLBoolean),
      },
      "startCursor": {
        type: GraphQLString,
      },
      "endCursor": {
        type: GraphQLString,
      },
    };
  },
});
