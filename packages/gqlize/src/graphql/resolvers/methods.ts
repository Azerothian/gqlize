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

  return async function resolve(source: any, args: any, context: any, info: any) {
    if (before) {
      args = await before(args, context);
    }
    const implementation = source?.[methodName];
    // An entry that declares `output` needs no implementation at all: the
    // formatter produces the value from the loaded row. Without one, an absent
    // implementation is still an error — there is nothing to resolve from.
    if (typeof implementation !== "function") {
      if (!output) {
        throw new Error(
          `gqlize: instance method "${defName}.${methodName}" is exposed but the model has no such method, `
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

  return async function resolve(source: any, args: any, context: any, info: any) {
    return instance.resolveClassMethod(defName, methodName, args, context, before, after);
  };
}
