import type { GraphQLResolveInfo } from "graphql";
import { definitionMethods } from "@azerothian/utilize/exposed-methods";
import type { AdapterRow, RequestContext } from "../../types";
import type { BindingContext, FieldBinding } from "./types";

/** `definition.expose.instanceMethods.query[methodName]` */
export function buildInstanceMethodResolver(
  binding: Extract<FieldBinding, { kind: "instanceMethod" }>,
  ctx: BindingContext,
) {
  const definition = ctx.instance.getDefinition(binding.defName);
  const methodDef =
    definition?.expose?.instanceMethods?.query?.[binding.methodName];
  if (!methodDef) {
    throw new Error(
      `gqlize: instance method "${binding.defName}.${binding.methodName}" is not exposed`,
    );
  }
  const { before, after, output } = methodDef;
  const { methodName, defName } = binding;
  // The definition's own implementation, for a row the adapter never built:
  // a class or instance method that returns plain objects typed as this model
  // hands back values with no prototype to find the method on (#72).
  const declared = definitionMethods(definition, "instanceMethods")[methodName];

  return async function resolve(source: AdapterRow, args: unknown, context: RequestContext, info: GraphQLResolveInfo) {
    if (before) {
      args = await before(args, context);
    }
    // The row's own method first — the adapter installs it on the prototype and
    // may have bound something richer. Reaching it is a widening, and the
    // `typeof` below is what decides whether there is anything to call. A plain
    // object falls back to the definition's implementation, run with the row as
    // `this` exactly as the prototype method would be.
    const own = (source as Record<string, unknown> | null | undefined)?.[methodName];
    const implementation = typeof own === "function" ? own : declared;
    // An entry that declares `output` needs no implementation at all: the
    // formatter produces the value from the loaded row. Without one, an absent
    // implementation is still an error — there is nothing to resolve from.
    if (typeof implementation !== "function") {
      if (!output) {
        throw new Error(
          `gqlize: instance method "${defName}.${methodName}" is exposed but neither the row nor the definition `
          + "(`instanceMethods` / `options.instanceMethods`) has an implementation, "
          + "and the entry declares no `output` to produce the value from the row instead.",
        );
      }
    }
    let result = typeof implementation === "function"
      ? await implementation.apply(source, [args, context])
      : undefined;
    if (output) {
      result = await output(result, { source, args, context, info, modelDefinition: definition });
    }
    if (after) {
      result = await after(result, context);
    }
    return result;
  };
}

/** `definition.expose.classMethods.{query,mutations}[methodName]` */
export function buildClassMethodResolver(
  binding: Extract<FieldBinding, { kind: "classMethod" }>,
  ctx: BindingContext,
) {
  const { instance } = ctx;
  const definition = instance.getDefinition(binding.defName);
  const methodDef =
    definition?.expose?.classMethods?.[binding.target]?.[binding.methodName];
  if (!methodDef) {
    throw new Error(
      `gqlize: class method "${binding.defName}.${binding.methodName}" is not exposed on "${binding.target}"`,
    );
  }
  const { before, after } = methodDef;
  const { defName, methodName } = binding;

  return async function resolve(source: AdapterRow, args: unknown, context: RequestContext, info: GraphQLResolveInfo) {
    return instance.resolveClassMethod(defName, methodName, args, context, before, after);
  };
}
