import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from "graphql";

/**
 * The `csv` argument beside `createCsv` / `updateCsv` / `deleteCsv`. One
 * module-level type shared by every model, like `GQLTDeletedFilter`: nothing in
 * it varies by model, so a copy per model would only grow the schema.
 */
export default new GraphQLInputObjectType({
  name: "GQLTCsvOptions",
  description: "How a CSV upload is read",
  fields: {
    keys: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
      description: "The columns an `updateCsv` or `deleteCsv` row is matched on. Default: the primary key",
    },
    delimiter: {
      type: GraphQLString,
      description: "The field separator. Default: a comma",
    },
  },
});
