import waterfall from "@azerothian/utilize/utils/waterfall";
import { processAfter } from "../utils/after";
import Events from "../../events";
import type { BindingContext, FieldBinding } from "./types";

export function buildMutationModelResolver(
  binding: Extract<FieldBinding, { kind: "mutationModel" }>,
  ctx: BindingContext,
) {
  const { instance } = ctx;
  const { defName } = binding;
  const definition = instance.getDefinition(defName);

  return async function resolve(source: any, args: any, context: any, info: any) {
    let results: any[] = [];

    if (args.create) {
      results = await waterfall(args.create, async(arg: any, arr: any[]) => {
        const result = await instance.processCreate(defName, source, {input: arg}, context, info);
        const node = await processAfter(result, args, context, info, definition, Events.MUTATION_CREATE);
        return arr.concat(node);
      }, results);
    }
    if (args.update) {
      results = await waterfall(args.update, async(arg: any, arr: any[]) => {
        const result = await instance.processUpdate(defName, source, arg, context, info);
        const node = await waterfall(result, (el: any) => processAfter(el, args, context, info, definition, Events.MUTATION_UPDATE));
        return arr.concat(node);
      }, results);
    }
    if (args.delete) {
      results = await waterfall(args.delete, async(arg: any, arr: any[]) => {
        const result = await instance.processDelete(defName, source, arg, context, info);
        const node = await waterfall(result, (el: any) => processAfter(el, args, context, info, definition, Events.MUTATION_DELETE));
        return arr.concat(node);
      }, results);
    }
    if (args.select) {
      results = await waterfall(args.select, async(arg: any, arr: any[]) => {
        const result = await instance.processSelect(defName, source, arg, context, info);
        const node = await waterfall(result, (el: any) => processAfter(el, args, context, info, definition, Events.MUTATION_UPDATE));
        return arr.concat(node);
      }, results);
    }
    return results;
  };
}
