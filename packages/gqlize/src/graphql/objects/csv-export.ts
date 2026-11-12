// The `csv` field on a model's root list connection (`<Model>List.csv`): CSV
// export, resolved by `resolvers/csv-export.ts`. Its arguments are the same in
// every schema; whether a connection has the field is decided by the caller
// (CSV on for the model, `permission.queryCsv`).

import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLString } from "graphql";
import type { GraphQLFieldConfig } from "graphql";

export function csvExportFieldConfig(defName: string): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: new GraphQLNonNull(GraphQLString),
    description: `This page of ${defName} rows as CSV text: a header line of column names, then one line per row. ` +
      "Ids are the same global ids the rows carry, `\\N` is NULL, and the file can be uploaded back through `updateCsv`.",
    args: {
      columns: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
        description: `Which of ${defName}'s columns to write, in this order. Default: every column the caller may read.`,
      },
      delimiter: {
        type: GraphQLString,
        description: "The field separator, one character. Default `,`.",
      },
      header: {
        type: GraphQLBoolean,
        description: "Whether to write the header line. Default `true`.",
      },
    },
  };
}
