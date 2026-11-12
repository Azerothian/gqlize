// The root `csvImport` mutation: several CSV files applied as one unit, rows
// linked across them by `@ref` labels.
//
// Each file is converted exactly as a `createCsv`/`updateCsv` upload on its
// model's own mutation field is (`./csv.ts`). Its types are read off that
// field, so a file is offered only the operations that field offers. The
// field's arguments already encode the operation gates, `mutationCsv` and the
// model's CSV switch, so a file the caller could not upload alone is refused
// here too. A file's `apply` is held to that field's own `apply` argument the
// same way, since the generic file type can only carry it as JSON. ormize's
// `processCsvImport` owns ordering, labels and the all-or-nothing writes.

import { coerceInputValue, getNamedType, isObjectType, validateInputValue } from "graphql";
import type { GraphQLError, GraphQLField, GraphQLResolveInfo } from "graphql";
import { CsvUploadError } from "@azerothian/ormize";
import type { CsvImportFile, CsvImportOperation } from "@azerothian/ormize";
import { defaultIdCodec } from "../../codecs/id";
import type { AdapterRow, RequestContext } from "../../types";
import Events from "../../events";
import { processAfter } from "../utils/after";
import { csvGraphQLError, csvRequest, type CsvModels } from "./csv";
import type { BindingContext } from "./types";

type CsvImportFileArg = {
  model: string;
  operation: CsvImportOperation;
  file: unknown;
  name?: string | null;
  keys?: string[] | null;
  delimiter?: string | null;
  apply?: unknown;
};

const EVENTS: { [op in CsvImportOperation]: Events } = {
  create: Events.MUTATION_CREATE,
  update: Events.MUTATION_UPDATE,
};

/** The model mutation fields under `Mutation.models`, by model name. */
function modelFields(info: GraphQLResolveInfo): { [defName: string]: GraphQLField<unknown, unknown> } {
  const models = info.schema.getMutationType()?.getFields().models;
  const type = models && getNamedType(models.type);
  return type && isObjectType(type) ? type.getFields() : {};
}

/**
 * A file's `apply`, validated and coerced against the model field's own
 * `apply` argument: the transforms the caller's permissions leave in, each
 * with its declared argument types. Refused when the field offers none.
 */
function fileApply(field: GraphQLField<unknown, unknown>, value: unknown, file: string): { [methodName: string]: unknown } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const arg = field.args.find((a) => a.name === "apply");
  if (!arg) {
    throw new CsvUploadError("CSV_UNSUPPORTED", `${field.name} has no transforms to apply`, { file });
  }
  let first: GraphQLError | undefined;
  validateInputValue(value, arg.type, (error) => {
    first = first || error;
  });
  if (first) {
    throw new CsvUploadError("CSV_UNSUPPORTED", `apply: ${first.message}`, { file });
  }
  return coerceInputValue(value, arg.type) as { [methodName: string]: unknown };
}

/** `Post.create`, then `Post.create#2` for a second unnamed file of the same kind. */
function defaultNames(files: CsvImportFileArg[]): string[] {
  const seen = new Map<string, number>();
  return files.map((f) => {
    if (f.name) {
      return f.name;
    }
    const base = `${f.model}.${f.operation}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

export function buildCsvImportResolver(ctx: BindingContext) {
  const { instance } = ctx;
  const codec = ctx.options.id || defaultIdCodec;
  const primaryKey = (defName: string): string | undefined => {
    const keys = instance.getModelAdapter(defName).getPrimaryKeyNameForModel(defName) || [];
    return keys.length === 1 ? keys[0] : undefined;
  };
  const models = (defName: string): CsvModels => ({
    defName,
    associations: (name) => Object.fromEntries(
      Object.entries(instance.getAssociations(name) || {}).map(([rel, a]) => [rel, a.target]),
    ),
    primaryKey,
    foreignTarget: (name, field) => {
      const fields = instance.getFields(name) || {};
      return Object.hasOwn(fields, field) ? fields[field].foreignTarget : undefined;
    },
  });
  /** A written row's id, encoded as every other id in the schema is. */
  const globalId = (defName: string, row: AdapterRow): string => {
    const pk = primaryKey(defName);
    if (pk === undefined) {
      throw new CsvUploadError("CSV_UNSUPPORTED", `${defName} has no single primary key to label its rows by`);
    }
    return codec.encode({ type: defName, id: instance.getValueFromInstance(defName, row, pk) as string | number, defName, fieldName: pk });
  };

  return async function resolve(_source: unknown, args: { files: CsvImportFileArg[] }, context: RequestContext, info: GraphQLResolveInfo) {
    const fields = modelFields(info);
    const names = defaultNames(args.files);
    let result;
    try {
      const files: CsvImportFile[] = args.files.map((f, i) => {
        const field = fields[f.model];
        if (!field?.args.some((a) => a.name === `${f.operation}Csv`)) {
          // Absent for the same reasons `<op>Csv` is absent on the model field:
          // CSV off for the model, `mutationCsv` denied, or the operation denied.
          throw new CsvUploadError("CSV_UNSUPPORTED", `${f.model} does not take a CSV ${f.operation}`, { file: names[i] });
        }
        return {
          name: names[i],
          defName: f.model,
          operation: f.operation,
          request: csvRequest(f.operation, field, f.file, { keys: f.keys, delimiter: f.delimiter }, fileApply(field, f.apply, names[i]), models(f.model)),
        };
      });
      result = await instance.processCsvImport({ files, refValue: globalId }, context);
    } catch (e) {
      throw e instanceof CsvUploadError ? csvGraphQLError(e) : e;
    }
    // The same `after` processing a model field's CSV rows get, per model.
    for (const file of result.files) {
      const definition = instance.getDefinition(file.defName);
      for (const row of file.rows) {
        await processAfter(row, args, context, info, definition, EVENTS[file.operation]);
      }
    }
    return {
      files: result.files.map((file) => ({
        name: file.name,
        model: file.defName,
        operation: file.operation,
        count: file.rows.length,
        ids: file.rows.map((row) => globalId(file.defName, row)),
      })),
      refs: Object.fromEntries(Object.entries(result.refs).map(([label, ref]) => [label, globalId(ref.defName, ref.row)])),
    };
  };
}
