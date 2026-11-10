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
//
// A header is a path into that argument (ormize's `csv/header.ts`), so a row
// reaches relationship verbs and every filter operator the input types offer,
// and the columns sharing a path prefix build one nested object between them.

import {
  GraphQLError, coerceInputValue, getNamedType, getNullableType, isInputObjectType, isListType,
  isScalarType, validateInputValue,
} from "graphql";
import type { GraphQLField, GraphQLInputObjectType, GraphQLInputType, GraphQLResolveInfo } from "graphql";
import JSONType from "@azerothian/graphql-types/json";
import { CSV_WHERE, CsvUploadError, csvBoolean, csvJson, csvList, csvNumber, isCsvWhereHeader, parseCsvHeader } from "@azerothian/ormize";
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
function cellValue(raw: unknown, type: GraphQLInputType): unknown {
  if (raw === null || typeof raw !== "string") {
    // `null` is the `\N` cell; anything else is an item a JSON list already typed.
    return raw;
  }
  const nullable = getNullableType(type);
  if (isListType(nullable)) {
    const item = nullable.ofType;
    // A list of objects is only ever JSON; a list of values (`in`, `between`)
    // may also be written `a|b|c`.
    return isInputObjectType(getNullableType(item)) ? csvJson(raw) : csvList(raw).map((v) => cellValue(v, item));
  }
  if (isInputObjectType(nullable)) {
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

/** A per-field operator object (`{eq, ne, in, …}`), which is what a filter field's type is. */
function operatorObject(type: GraphQLInputType): GraphQLInputObjectType | undefined {
  const nullable = getNullableType(type);
  return isInputObjectType(nullable) && nullable.getFields().eq ? nullable : undefined;
}

/** A `where` type: it combines with `and`/`or`, or holds operator objects. */
function isFilterType(type: GraphQLInputObjectType): boolean {
  const fields = Object.values(type.getFields());
  return fields.some((f) => f.name === "and" || f.name === "or" || operatorObject(f.type) !== undefined);
}

/** Where one header puts its cell: a path into the row's argument, and the type the cell becomes. */
type CsvTarget = { path: (string | number)[]; type: GraphQLInputType };

/**
 * Resolve a header against the type its row's argument has, walking one
 * segment per level (see ormize's `csv/header.ts` for the grammar).
 *
 * Two levels may be left out because they carry no choice: the `input` of an
 * `update`/`select` entry (`tags.update.done`, not `tags.update.input.done`),
 * and the `where` of an `add`/`set` entry on a many-to-many relationship. And
 * `where` may be written where the entry is a filter already (`owner.set.where.name`
 * means `owner.set.name`), so the same header reads the same on every verb.
 */
function resolveTarget(root: GraphQLInputObjectType, header: string, unknown: (segment: string) => string): CsvTarget {
  const { segments, op } = parseCsvHeader(header);
  const bad = (why: string): never => {
    throw new CsvUploadError("CSV_HEADER", `"${header}" ${why}`, { column: header });
  };
  const path: (string | number)[] = [];
  let type: GraphQLInputObjectType = root;
  let leaf: GraphQLInputType | undefined;
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    let fields = type.getFields();
    if (!fields[segment.name]) {
      if (segment.name === "where" && !last && segment.index === undefined && isFilterType(type)) {
        return;
      }
      const via = ["input", "where"].find((hop) => fields[hop] && inputObject(fields[hop].type)?.getFields()[segment.name]);
      if (!via) {
        return bad(i === 0 ? unknown(segment.name) : `reaches "${segment.name}", which ${type.name} does not have`);
      }
      path.push(via);
      type = inputObject(fields[via].type) as GraphQLInputObjectType;
      fields = type.getFields();
    }
    path.push(segment.name);
    let fieldType: GraphQLInputType = fields[segment.name].type;
    const nullable = getNullableType(fieldType);
    if (isListType(nullable)) {
      const item = nullable.ofType;
      const itemObject = isInputObjectType(getNullableType(item));
      if (itemObject && (!last || segment.index !== undefined)) {
        path.push(segment.index ?? 0);
        fieldType = item;
      } else if (segment.index !== undefined) {
        bad(`indexes "${segment.name}", which is a list of values, not of entries`);
      }
    } else if (segment.index !== undefined) {
      bad(`indexes "${segment.name}", which is not a list`);
    }
    if (last) {
      leaf = fieldType;
      return;
    }
    const next = getNullableType(fieldType);
    if (!isInputObjectType(next)) {
      bad(`goes past "${segment.name}", which holds a value`);
    }
    type = next as GraphQLInputObjectType;
  });
  const operators = operatorObject(leaf as GraphQLInputType);
  if (op !== undefined) {
    const operator = operators?.getFields()[op];
    if (!operator) {
      bad(operators ? `names "${op}", which is not an operator ${operators.name} offers` : "names an operator on something that is not a filter field");
    }
    return { path: [...path, op], type: (operator as { type: GraphQLInputType }).type };
  }
  if (operators) {
    return { path: [...path, "eq"], type: operators.getFields().eq.type };
  }
  return { path, type: leaf as GraphQLInputType };
}

/** Two headers that write the same place, or one inside the other's value, cannot both be honoured. */
function assertDistinct(targets: Map<string, CsvTarget>) {
  const seen: { header: string; key: string }[] = [];
  for (const [header, { path }] of targets) {
    const key = path.join("\u0000");
    const clash = seen.find((s) => s.key === key || s.key.startsWith(`${key}\u0000`) || key.startsWith(`${s.key}\u0000`));
    if (clash) {
      throw new CsvUploadError("CSV_HEADER", `"${header}" and "${clash.header}" write the same value`, { column: header });
    }
    seen.push({ header, key });
  }
}

function place(tree: { [key: string]: unknown }, path: (string | number)[], value: unknown) {
  let node: { [key: string | number]: unknown } = tree;
  path.forEach((key, i) => {
    if (i === path.length - 1) {
      node[key] = value;
      return;
    }
    if (node[key] === undefined) {
      node[key] = typeof path[i + 1] === "number" ? [] : {};
    }
    node = node[key] as { [key: string | number]: unknown };
  });
}

/**
 * Drop the holes an index leaves: `tags.add[1]` filled on a row whose
 * `tags.add[0]` cells are all empty is that row's only entry. The index groups
 * columns into an entry; it is not a position anyone is counting on.
 */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((v) => v !== undefined).map(compact);
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v)]));
  }
  return value;
}

/** A row's cells, each placed at its header's target, as the value of `type`. */
function buildArgument(cells: CsvCells, type: GraphQLInputObjectType, targets: Map<string, CsvTarget>): unknown {
  const tree: { [key: string]: unknown } = {};
  for (const column of Object.keys(cells)) {
    const target = targets.get(column) as CsvTarget;
    place(tree, target.path, inColumn(column, () => cellValue(cells[column], target.type)));
  }
  return validated(compact(tree) as { [key: string]: unknown }, type);
}

/** A top-level `where.name` key column is a path into the where type itself. */
function keyHeader(column: string): string {
  return isCsvWhereHeader(column) ? column.slice(CSV_WHERE.length + 1) : column;
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
  const inputTargets = new Map<string, CsvTarget>();
  const keyTargets = new Map<string, CsvTarget>();
  const resolveAll = ({ input, keys }: { input: string[]; keys: string[] }) => {
    for (const column of input) {
      if (!types.input) {
        throw new CsvUploadError("CSV_HEADER", `"${column}" is not a field this ${operation} can write`, { column });
      }
      inputTargets.set(column, resolveTarget(types.input, column, () => `is not a field this ${operation} can write`));
    }
    for (const column of keys) {
      if (!types.where) {
        throw new CsvUploadError("CSV_HEADER", `"${column}" is not a field rows can be matched on`, { column });
      }
      keyTargets.set(column, resolveTarget(types.where, keyHeader(column), () => "is not a field rows can be matched on"));
    }
    assertDistinct(inputTargets);
    assertDistinct(keyTargets);
  };
  return {
    upload,
    keys: args?.keys || undefined,
    delimiter: args?.delimiter ?? undefined,
    apply,
    checkColumns: resolveAll,
    toArgs: ({ input, keys }: CsvRowCells) => ({
      input: types.input ? buildArgument(input, types.input, inputTargets) as MutationInputTree : undefined,
      where: types.where ? buildArgument(keys, types.where, keyTargets) as MutationFilter : undefined,
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
