import type { GraphQLResolveInfo } from "graphql";
import waterfall from "@azerothian/utilize/utils/waterfall";
import { CsvUploadError } from "@azerothian/ormize";
import type { CsvOperation, MutationFilter, MutationInputTree } from "@azerothian/ormize";
import { processAfter } from "../utils/after";
import Events from "../../events";
import type { AdapterRow, Definition, RequestContext } from "../../types";
import type { BindingContext, FieldBinding } from "./types";
import { csvGraphQLError, csvRequest, type CsvArgs } from "./csv";

/**
 * The generated model-mutation field's arguments — one list per operation, as
 * the golden schema declares them (`create: [XRequiredInput]` and so on), plus
 * the `apply` bag of pre-commit transforms shared by `create` and `update`.
 *
 * Every key is optional and the resolver runs whichever are present, which is
 * how one field serves all four operations in a single request.
 */
type MutationModelArgs = {
  create?: MutationInputTree[];
  update?: { input?: MutationInputTree; where: MutationFilter; limit?: number }[];
  delete?: MutationFilter[];
  restore?: MutationFilter[];
  select?: { input?: MutationInputTree; where?: MutationFilter; limit?: number }[];
  apply?: { [methodName: string]: unknown };
  /** CSV uploads — whatever the host's multipart layer put in the `GQLTUpload` slot. */
  createCsv?: unknown;
  updateCsv?: unknown;
  deleteCsv?: unknown;
  csv?: CsvArgs;
};

/** Each CSV argument, the operation it carries, and the event its rows report. */
const CSV_ARGS: [keyof MutationModelArgs, CsvOperation, Events][] = [
  ["createCsv", "create", Events.MUTATION_CREATE],
  ["updateCsv", "update", Events.MUTATION_UPDATE],
  ["deleteCsv", "delete", Events.MUTATION_DELETE],
];

/**
 * Process a batch of mutation operations that each return an array of rows,
 * running `processAfter` on every row. update/delete/restore/select all share
 * this shape — each operation yields an array and every element gets the same
 * post-processing.
 */
async function collectBatch<TArg>(
  items: TArg[],
  process: (arg: TArg) => Promise<AdapterRow[]>,
  args: MutationModelArgs,
  context: RequestContext,
  info: GraphQLResolveInfo,
  definition: Definition,
  event: Events,
  results: AdapterRow[],
): Promise<AdapterRow[]> {
  return waterfall(items, async (arg, arr) => {
    const result = await process(arg);
    const node = await waterfall(result, async (el, acc: AdapterRow[]) => acc.concat(await processAfter(el, args, context, info, definition, event)), []);
    return arr.concat(node);
  }, results);
}

export function buildMutationModelResolver(
  binding: Extract<FieldBinding, { kind: "mutationModel" }>,
  ctx: BindingContext,
) {
  const { instance } = ctx;
  const { defName } = binding;
  const definition = instance.getDefinition(defName);

  return async function resolve(source: AdapterRow, args: MutationModelArgs, context: RequestContext, info: GraphQLResolveInfo) {
    let results: AdapterRow[] = [];

    if (args.create) {
      results = await waterfall(args.create, async(arg, arr) => {
        const result = await instance.processCreate(defName, source, {input: arg, apply: args.apply}, context, info);
        const node = await processAfter(result, args, context, info, definition, Events.MUTATION_CREATE);
        return arr.concat(node);
      }, results);
    }
    if (args.update) {
      results = await collectBatch(args.update,
        (arg) => instance.processUpdate(defName, source, {...arg, apply: args.apply}, context, info),
        args, context, info, definition, Events.MUTATION_UPDATE, results);
    }
    if (args.delete) {
      results = await collectBatch(args.delete,
        (arg) => instance.processDelete(defName, source, arg, context, info),
        args, context, info, definition, Events.MUTATION_DELETE, results);
    }
    if (args.restore) {
      // `MUTATION_UPDATE` rather than an event of its own — see the same
      // choice in ormize's `processRestore`.
      results = await collectBatch(args.restore,
        (arg) => instance.processRestore(defName, source, arg, context, info),
        args, context, info, definition, Events.MUTATION_UPDATE, results);
    }
    if (args.select) {
      results = await collectBatch(args.select,
        (arg) => instance.processSelect(defName, source, arg, context, info),
        args, context, info, definition, Events.MUTATION_UPDATE, results);
    }
    // After the JSON lists, in the same create → update → delete order. Each
    // upload is one all-or-nothing unit (see ormize's `processCsv`); its rows
    // then get the same `after` processing a JSON write's do.
    for (const [argName, operation, event] of CSV_ARGS) {
      const upload = args[argName];
      if (upload === undefined || upload === null) {
        continue;
      }
      let rows: AdapterRow[];
      try {
        rows = await instance.processCsv(defName, operation, csvRequest(operation, info.parentType.getFields()[info.fieldName], upload, args.csv, args.apply), context, info);
      } catch (e) {
        throw e instanceof CsvUploadError ? csvGraphQLError(e) : e;
      }
      results = await waterfall(rows, async(el, acc: AdapterRow[]) => acc.concat(await processAfter(el, args, context, info, definition, event)), results);
    }
    return results;
  };
}
