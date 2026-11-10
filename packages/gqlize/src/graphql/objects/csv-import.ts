// The types of the root `csvImport` mutation: several CSV files, each a
// create or an update on its own model, applied as one unit with `@ref`
// labels linking rows across them (ormize's `engine/csv-import.ts`).
//
// The operation enum and the result types are the same in every schema, so
// they are module-level like `GQLTCsvOptions`. The file input is not: its
// `model` is an enum of the models this schema lets take a CSV, so it is
// built per schema by `csvImportField`.

import {
  GraphQLEnumType,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import type { GraphQLFieldConfig, GraphQLNullableType } from "graphql";
import JSONType from "@azerothian/graphql-types/json";
import UploadType from "@azerothian/graphql-types/upload";

const nonNull = <T extends GraphQLNullableType>(type: T) => new GraphQLNonNull(type);

export const CsvImportOperationType = new GraphQLEnumType({
  name: "GQLTCsvImportOperation",
  description: "What one file of a CSV import does to its rows",
  values: {
    create: { description: "Create one row per line" },
    update: { description: "Update the rows each line's key columns match" },
  },
});

export const CsvImportFileResultType = new GraphQLObjectType({
  name: "GQLTCsvImportFileResult",
  description: "What one file of a CSV import wrote",
  fields: {
    name: { type: nonNull(GraphQLString), description: "The file's name, as given or defaulted" },
    model: { type: nonNull(GraphQLString) },
    operation: { type: nonNull(CsvImportOperationType) },
    count: { type: nonNull(GraphQLInt), description: "Rows written" },
    ids: { type: nonNull(new GraphQLList(nonNull(GraphQLID))), description: "The written rows' ids, in file order" },
  },
});

export const CsvImportResultType = new GraphQLObjectType({
  name: "GQLTCsvImportResult",
  fields: {
    files: { type: nonNull(new GraphQLList(nonNull(CsvImportFileResultType))), description: "One entry per file, in the order given" },
    refs: { type: nonNull(JSONType), description: "Each `@ref` label and the id of the row it labelled" },
  },
});

/**
 * The `csvImport(files: [CsvImportFile!]!)` field for the models given, or
 * `undefined` when there are none. The resolver is the caller's to bind.
 */
export function csvImportFieldConfig(models: string[]): GraphQLFieldConfig<unknown, unknown> | undefined {
  if (models.length === 0) {
    return undefined;
  }
  const modelType = new GraphQLEnumType({
    name: "CsvImportModel",
    description: "A model that takes CSV rows in a `csvImport`",
    values: Object.fromEntries(models.map((name) => [name, {}])),
  });
  const fileType = new GraphQLInputObjectType({
    name: "CsvImportFile",
    description: "One file of a `csvImport`",
    fields: {
      model: { type: nonNull(modelType) },
      operation: { type: nonNull(CsvImportOperationType) },
      file: { type: nonNull(UploadType) },
      name: { type: GraphQLString, description: "How errors and results name this file. Default: `<model>.<operation>`, numbered if repeated" },
      keys: {
        type: new GraphQLList(nonNull(GraphQLString)),
        description: "The columns an `update` row is matched on, beside any `where.…` columns. Default: the primary key",
      },
      delimiter: { type: GraphQLString, description: "The field separator. Default: a comma" },
    },
  });
  return {
    type: nonNull(CsvImportResultType),
    description: "Create or update rows of several models from CSV files in one all-or-nothing unit. "
      + "A file's `@ref` column labels its rows; a `<relationship>.@ref` or `<foreignKey>.@ref` column in any file points at them",
    args: {
      files: { type: nonNull(new GraphQLList(nonNull(fileType))) },
    },
  };
}
