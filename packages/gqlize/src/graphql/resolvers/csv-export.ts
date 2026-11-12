// CSV export: the `csv` field on a model's root list connection
// (`<Model>List.csv`), the read side of the `createCsv`/`updateCsv` uploads.
//
// It formats the page the connection already fetched, so it inherits all of
// that read's rules without restating them: `where`/`orderBy`/paging, row scope,
// OUTPUT hooks (the connection drops a node its hook rejects), and the field
// permissions that decide which columns the node type has at all. Each cell is
// the value the node's own field resolver returns, serialised by the field's
// own type — so a key is the same global id a JSON read returns, an enum is its
// name, and the file reads back through an `updateCsv` upload as is.
//
// The columns are the node type's leaf fields that take no arguments and are
// not exposed methods: the model's columns, in schema order. Relationships are
// not flattened in; read those with their own connection.

import {
  GraphQLError, defaultFieldResolver, getNamedType, getNullableType, isLeafType, isListType, isObjectType,
} from "graphql";
import type { GraphQLField, GraphQLObjectType, GraphQLOutputType, GraphQLResolveInfo } from "graphql";
import { CsvUploadError, writeCsv } from "@azerothian/ormize";
import type { AdapterRow, RequestContext } from "../../types";
import { readBinding } from "./bind";
import type { BindingContext, FieldBinding } from "./types";

type CsvExportArgs = { columns?: string[] | null; delimiter?: string | null; header?: boolean | null };
type ConnectionValue = { edges?: ({ node?: AdapterRow | null } | null)[] | null };
type NodeField = GraphQLField<unknown, unknown>;

/** The node type behind a `<Model>List` connection: `edges` → edge → `node`. */
function nodeTypeOf(connection: GraphQLObjectType): GraphQLObjectType | undefined {
  const edge = getNamedType(connection.getFields().edges?.type);
  const node = isObjectType(edge) ? getNamedType(edge.getFields().node?.type) : undefined;
  return isObjectType(node) ? node : undefined;
}

/** The fields a CSV column can be: leaf-typed, argument-free, and not an exposed method. */
export function csvExportColumns(nodeType: GraphQLObjectType): NodeField[] {
  return Object.values(nodeType.getFields()).filter((field) => {
    const kind = readBinding(field)?.kind;
    return isLeafType(getNamedType(field.type)) && field.args.length === 0 && kind !== "instanceMethod";
  }) as NodeField[];
}

/** A resolved value as the JSON response would carry it: through the field type's `serialize`. */
function serialise(type: GraphQLOutputType, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  const nullable = getNullableType(type);
  if (isListType(nullable)) {
    return Array.isArray(value) ? value.map((item) => serialise(nullable.ofType, item)) : null;
  }
  const named = getNamedType(nullable);
  return isLeafType(named) ? named.serialize(value) : value;
}

function pickColumns(available: NodeField[], requested: string[] | null | undefined): NodeField[] {
  if (!requested) {
    return available;
  }
  const byName = new Map(available.map((f) => [f.name, f]));
  const seen = new Set<string>();
  return requested.map((name) => {
    const field = byName.get(name);
    if (!field) {
      throw new GraphQLError(`"${name}" is not a column this CSV can hold`, { extensions: { code: "CSV_UNSUPPORTED", column: name } });
    }
    if (seen.has(name)) {
      throw new GraphQLError(`"${name}" is named twice`, { extensions: { code: "CSV_UNSUPPORTED", column: name } });
    }
    seen.add(name);
    return field;
  });
}

export function buildConnectionCsvResolver(
  _binding: Extract<FieldBinding, { kind: "connectionCsv" }>,
  _ctx: BindingContext,
) {
  return async function resolve(source: ConnectionValue, args: CsvExportArgs, context: RequestContext, info: GraphQLResolveInfo) {
    const nodeType = nodeTypeOf(info.parentType);
    if (!nodeType) {
      throw new GraphQLError(`${info.parentType.name} has no node type to export`);
    }
    const columns = pickColumns(csvExportColumns(nodeType), args.columns);
    const rows: { [column: string]: unknown }[] = [];
    for (const edge of source?.edges || []) {
      const node = edge?.node;
      if (!node) {
        continue;
      }
      const row: { [column: string]: unknown } = {};
      for (const field of columns) {
        // The node field's own resolver, as if the client had selected it on
        // this node: the info it reads (`fieldName`, `parentType`) is that field's.
        const fieldInfo = { ...info, fieldName: field.name, parentType: nodeType, returnType: field.type } as GraphQLResolveInfo;
        const resolveField = field.resolve || defaultFieldResolver;
        const value = await resolveField(node, {}, context, fieldInfo);
        row[field.name] = serialise(field.type, value);
      }
      rows.push(row);
    }
    try {
      return writeCsv(columns.map((f) => f.name), rows, {
        delimiter: args.delimiter ?? undefined,
        header: args.header ?? true,
      });
    } catch (e) {
      if (e instanceof CsvUploadError) {
        throw new GraphQLError(e.message, { extensions: { code: e.code } });
      }
      throw e;
    }
  };
}
