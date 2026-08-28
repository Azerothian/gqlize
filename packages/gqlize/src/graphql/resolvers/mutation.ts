import type { GraphQLResolveInfo } from "graphql";
import waterfall from "@azerothian/utilize/utils/waterfall";
import type { MutationFilter, MutationInputTree } from "@azerothian/ormize";
import { processAfter } from "../utils/after";
import Events from "../../events";
import type { AdapterRow, RequestContext } from "../../types";
import type { BindingContext, FieldBinding } from "./types";

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
  update?: { input: MutationInputTree; where: MutationFilter; limit?: number }[];
  delete?: MutationFilter[];
  restore?: MutationFilter[];
  select?: { input?: MutationInputTree; where?: MutationFilter; limit?: number }[];
  apply?: { [methodName: string]: unknown };
};

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
      results = await waterfall(args.update, async(arg, arr) => {
        const result = await instance.processUpdate(defName, source, {...arg, apply: args.apply}, context, info);
        const node = await waterfall(result, async(el, acc: AdapterRow[]) => acc.concat(await processAfter(el, args, context, info, definition, Events.MUTATION_UPDATE)), []);
        return arr.concat(node);
      }, results);
    }
    if (args.delete) {
      results = await waterfall(args.delete, async(arg, arr) => {
        const result = await instance.processDelete(defName, source, arg, context, info);
        const node = await waterfall(result, async(el, acc: AdapterRow[]) => acc.concat(await processAfter(el, args, context, info, definition, Events.MUTATION_DELETE)), []);
        return arr.concat(node);
      }, results);
    }
    if (args.restore) {
      results = await waterfall(args.restore, async(arg, arr) => {
        const result = await instance.processRestore(defName, source, arg, context, info);
        // `MUTATION_UPDATE` rather than an event of its own — see the same
        // choice in ormize's `processRestore`.
        const node = await waterfall(result, async(el, acc: AdapterRow[]) => acc.concat(await processAfter(el, args, context, info, definition, Events.MUTATION_UPDATE)), []);
        return arr.concat(node);
      }, results);
    }
    if (args.select) {
      results = await waterfall(args.select, async(arg, arr) => {
        const result = await instance.processSelect(defName, source, arg, context, info);
        const node = await waterfall(result, async(el, acc: AdapterRow[]) => acc.concat(await processAfter(el, args, context, info, definition, Events.MUTATION_UPDATE)), []);
        return arr.concat(node);
      }, results);
    }
    return results;
  };
}
