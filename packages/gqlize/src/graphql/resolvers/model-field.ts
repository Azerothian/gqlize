import { toGlobalId } from "graphql-relay";
import type { GraphQLFieldResolver, GraphQLResolveInfo } from "graphql";
import type GQLManager from "../../manager";
import type { AdapterRow, RequestContext } from "../../types";
import type { BindingContext, FieldBinding } from "./types";

/**
 * The relay global-id resolver, extracted so both `utils/global-id-field` (the
 * live builder path) and the artifact materializer produce the same function.
 */
export function globalIdResolver(
  typeName: string | undefined,
  idFetcher: ((row: AdapterRow, context: RequestContext, info: GraphQLResolveInfo) => unknown) | undefined,
  isNullable: boolean | undefined,
): GraphQLFieldResolver<AdapterRow, RequestContext> {
  return (obj, args, context, info) => {
    const id = idFetcher ? idFetcher(obj, context, info) : (obj as {id?: unknown})?.id;
    if (!id && id !== 0 && isNullable) {
      return undefined;
    } else {
      // `toGlobalId` stringifies whatever it is handed; the value is a primary or
      // foreign key, so it is a string or a number in every backend here.
      return toGlobalId(typeName || info.parentType.name, id as string);
    }
  };
}

export function globalIdBindValue(defName: string, key: string, instance: GQLManager) {
  return (row: AdapterRow) => instance.getValueFromInstance(defName, row, key);
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
