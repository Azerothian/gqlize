// CSV uploads on the model mutation field: turning a row's string cells into
// the `input` / `where` a JSON caller would have sent.
//
// ormize reads the file and runs the writes (`processCsv`); what it cannot do
// is type a cell, because only the schema knows what the field is. So every
// cell is converted against the very input type the same field takes on the
// JSON path, then put through graphql's own input validation and coercion. A
// CSV can therefore send nothing a JSON argument could not: a column the
// permissions or the mass-assignment guard keep off the input type is simply
// not there to name.

import {
  GraphQLError, coerceInputValue, getNamedType, getNullableType, isInputObjectType, isListType,
  isScalarType, validateInputValue,
} from "graphql";
import type { GraphQLField, GraphQLInputObjectType, GraphQLInputType, GraphQLResolveInfo } from "graphql";
import JSONType from "@azerothian/graphql-types/json";
import { CsvUploadError, csvBoolean, csvJson, csvNumber } from "@azerothian/ormize";
import type { CsvCells, CsvOperation, CsvRequest, CsvRowCells, MutationFilter, MutationInputTree } from "@azerothian/ormize";

/** The `input` and `where` types one operation's rows are held to. */
type CsvTypes = { input?: GraphQLInputObjectType; where?: GraphQLInputObjectType };

/** The `csv: GQLTCsvOptions` argument. */
export type CsvArgs = { keys?: string[] | null; delimiter?: string | null };

function inputObject(type: GraphQLInputType | undefined): GraphQLInputObjectType | undefined {
  const named = type && getNamedType(type);
  return named && isInputObjectType(named) ? named : undefined;
}

/**
 * Read the types off the field being resolved rather than out of the schema
 * cache, so the same code serves a live schema and one materialized from an
 * artifact — the arguments are there in both, the builder's cache is not.
 */
function csvTypes(field: GraphQLField<unknown, unknown> | undefined, operation: CsvOperation): CsvTypes {
  const arg = (name: string) => inputObject(field?.args.find((a) => a.name === name)?.type);
  switch (operation) {
    case "create":
      return { input: arg("create") };
    case "update": {
      const fields = arg("update")?.getFields();
      return { input: inputObject(fields?.input?.type), where: inputObject(fields?.where?.type) };
    }
    case "delete":
      return { where: arg("delete") };
  }
}

/**
 * A cell as the value its field's type takes. Only the types whose JSON value
 * is not a string need converting; everything else — `ID`, `String`, enums,
 * dates, big integers — is the string the scalar's own `parseValue` expects.
 */
function cellValue(raw: string | null, type: GraphQLInputType): unknown {
  if (raw === null) {
    return null;
  }
  const nullable = getNullableType(type);
  if (isListType(nullable) || isInputObjectType(nullable)) {
    return csvJson(raw);
  }
  if (isScalarType(nullable)) {
    switch (nullable.name) {
      case "Int":
        return csvNumber(raw, true);
      case "Float":
        return csvNumber(raw, false);
      case "Boolean":
        return csvBoolean(raw);
      case JSONType.name:
        return csvJson(raw);
    }
  }
  return raw;
}

/** Run `fn`, pinning a column-less conversion error on `column`. */
function inColumn<T>(column: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CsvUploadError && e.column === undefined) {
      throw new CsvUploadError(e.code, `"${column}": ${e.message}`, { column, cause: e.cause });
    }
    throw e;
  }
}

/** graphql's own verdict on a value, as the first error it reports. */
function validated(value: { [key: string]: unknown }, type: GraphQLInputObjectType): unknown {
  let first: { error: GraphQLError; path: ReadonlyArray<string | number> } | undefined;
  validateInputValue(value, type, (error, path) => {
    first = first || { error, path };
  });
  if (first) {
    const column = typeof first.path[0] === "string" ? first.path[0] : undefined;
    throw new CsvUploadError("CSV_ROW_INVALID", first.error.message, { column });
  }
  return coerceInputValue(value, type);
}

/**
 * A key column's filter: equality, through the field's `eq` operator when the
 * where type has the per-field operator objects the built-in adapters generate,
 * or the bare value when an adapter's where takes one.
 */
function keyFilter(raw: string | null, type: GraphQLInputType): unknown {
  const nullable = getNullableType(type);
  const eq = isInputObjectType(nullable) ? nullable.getFields().eq : undefined;
  return eq ? { eq: cellValue(raw, eq.type) } : cellValue(raw, type);
}

function buildInput(cells: CsvCells, type: GraphQLInputObjectType): MutationInputTree {
  const fields = type.getFields();
  const value: { [key: string]: unknown } = {};
  for (const column of Object.keys(cells)) {
    value[column] = inColumn(column, () => cellValue(cells[column], fields[column].type));
  }
  return validated(value, type) as MutationInputTree;
}

function buildWhere(cells: CsvCells, type: GraphQLInputObjectType): MutationFilter {
  const fields = type.getFields();
  const value: { [key: string]: unknown } = {};
  for (const column of Object.keys(cells)) {
    value[column] = inColumn(column, () => keyFilter(cells[column], fields[column].type));
  }
  return validated(value, type) as MutationFilter;
}

/**
 * The surface half of an ormize {@link CsvRequest} for one model field: header
 * checks and row conversion against that field's own argument types.
 */
export function csvRequest(
  operation: CsvOperation, info: GraphQLResolveInfo, upload: unknown, args: CsvArgs | undefined,
  apply: { [methodName: string]: unknown } | undefined,
): CsvRequest {
  const types = csvTypes(info.parentType.getFields()[info.fieldName], operation);
  return {
    upload,
    keys: args?.keys || undefined,
    delimiter: args?.delimiter ?? undefined,
    apply,
    checkColumns: ({ input, keys }) => {
      const inputFields = types.input?.getFields() || {};
      const whereFields = types.where?.getFields() || {};
      for (const column of input) {
        if (!inputFields[column]) {
          throw new CsvUploadError("CSV_HEADER", `"${column}" is not a field this ${operation} can write`, { column });
        }
      }
      for (const column of keys) {
        // `or`/`and` are where-type fields too, and nothing a cell can fill.
        if (!whereFields[column] || column === "or" || column === "and") {
          throw new CsvUploadError("CSV_HEADER", `"${column}" is not a field rows can be matched on`, { column });
        }
      }
    },
    toArgs: ({ input, keys }: CsvRowCells) => ({
      input: types.input ? buildInput(input, types.input) : undefined,
      where: types.where ? buildWhere(keys, types.where) : undefined,
    }),
  };
}

/**
 * A {@link CsvUploadError} as the `GraphQLError` a client sees. `code`, `row`
 * and `column` ride in `extensions` so a client can point at the cell; a
 * failed write also carries the code of what failed it, when it had one
 * (`GLOBAL_ID_TYPE_MISMATCH`, say).
 */
export function csvGraphQLError(e: CsvUploadError): GraphQLError {
  const cause = e.cause as { extensions?: { code?: unknown }; code?: unknown } | undefined;
  const causeCode = cause?.extensions?.code ?? cause?.code;
  const extensions: { [key: string]: unknown } = { code: e.code };
  if (e.row !== undefined) {
    extensions.row = e.row;
  }
  if (e.column !== undefined) {
    extensions.column = e.column;
  }
  if (typeof causeCode === "string") {
    extensions.causeCode = causeCode;
  }
  // No `originalError`: hosts that mask unexpected errors (graphql-yoga's
  // default) treat a GraphQLError wrapping a plain Error as one, and would
  // replace the row and column with "Unexpected error." This one is meant for
  // the client.
  return new GraphQLError(e.message, { extensions });
}
