import { toGlobalId } from "graphql-relay";
import type { BindingContext, FieldBinding } from "./types";

/**
 * The relay global-id resolver, extracted so both `utils/global-id-field` (the
 * live builder path) and the artifact materializer produce the same function.
 */
export function globalIdResolver(
  typeName: any,
  idFetcher: (arg0: any, arg1: any, arg2: any) => any,
  isNullable: any,
) {
  return (
    obj: { id: any },
    args: any,
    context: any,
    info: { parentType: { name: any } },
  ) => {
    const id = idFetcher ? idFetcher(obj, context, info) : obj.id;
    if (!id && id !== 0 && isNullable) {
      return undefined;
    } else {
      return toGlobalId(typeName || info.parentType.name, id);
    }
  };
}

export function globalIdBindValue(defName: string, key: string, instance: any) {
  return (i: any) => instance.getValueFromInstance(defName, i, key);
}

export function buildGlobalIdResolver(
  binding: Extract<FieldBinding, { kind: "globalId" }>,
  ctx: BindingContext,
) {
  return globalIdResolver(
    binding.typeName,
    globalIdBindValue(binding.defName, binding.fieldName, ctx.instance),
    binding.nullable,
  );
}

/** A `resolve` hung directly off a model field definition by the user. */
export function buildModelFieldResolver(
  binding: Extract<FieldBinding, { kind: "modelField" }>,
  ctx: BindingContext,
) {
  const fields = ctx.instance.getFields(binding.defName);
  const resolve = fields?.[binding.fieldName]?.resolve;
  if (typeof resolve !== "function") {
    throw new Error(
      `gqlize: no resolve function on field "${binding.defName}.${binding.fieldName}"`,
    );
  }
  return resolve;
}

/** `definition.override[fieldName].output` */
export function buildOverrideOutputResolver(
  binding: Extract<FieldBinding, { kind: "overrideOutput" }>,
  ctx: BindingContext,
) {
  const definition = ctx.instance.getDefinition(binding.defName);
  const resolve = definition?.override?.[binding.fieldName]?.output;
  if (typeof resolve !== "function") {
    throw new Error(
      `gqlize: no override output resolver for "${binding.defName}.${binding.fieldName}"`,
    );
  }
  return resolve;
}
