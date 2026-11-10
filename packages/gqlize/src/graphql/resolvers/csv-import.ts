// The root `csvImport` mutation: several CSV files applied as one unit, rows
// linked across them by `@ref` labels.
//
// Each file is converted exactly as a `createCsv`/`updateCsv` upload on its
// model's own mutation field is (`./csv.ts`). Its types are read off that
// field, so a file is offered only the operations that field offers. The
// field's arguments already encode the operation gates, `mutationCsv` and the
// model's CSV switch, so a file the caller could not upload alone is refused
// here too. ormize's `processCsvImport` owns ordering, labels and the
// all-or-nothing writes.

import { getNamedType, isObjectType } from "graphql";
import type { GraphQLField, GraphQLResolveInfo } from "graphql";
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
          request: csvRequest(f.operation, field, f.file, { keys: f.keys, delimiter: f.delimiter }, undefined, models(f.model)),
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
