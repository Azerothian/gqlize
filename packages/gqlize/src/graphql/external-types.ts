import {
  GraphQLObjectType,
  getNamedType,
  type GraphQLInputFieldConfig,
  type GraphQLNamedType,
  type GraphQLObjectTypeConfig,
  type GraphQLType,
  type ThunkObjMap,
} from "graphql";

import { capitalize } from "@azerothian/utilize/utils/word";
import type GQLManager from "../manager";
import type { AdapterRow, Definition, RequestContext, SchemaCache } from "../types";
import { isBuiltInputType, isBuiltOutputType, type AuthoredTypeSlot } from "./utils/authored-type";
import createGQLInputObject from "./create-gql-input-object";
import type { ExternalTypeRef } from "./snapshot/ledger";

/** One entry of `definition.override`, as the definition author wrote it. */
type AuthoredOverride = NonNullable<Definition["override"]>[string];

/**
 * Re-derives a user-authored type from the live ormize definitions.
 *
 * These types are the reason the artifact is an IR and not SDL: they carry
 * scalar coercion, nested resolvers and thunks, all of which are code. Rather
 * than attempt to describe them, the ledger records *where each one came from*
 * and this re-runs the exact normalisation the builder ran — so the loaded
 * schema holds the same live objects the user handed to `createSchema`.
 *
 * Each branch mirrors one builder site; if a builder's normalisation changes,
 * the roundtrip suite fails rather than the loader silently diverging.
 */
export function resolveExternalType(
  expectedName: string,
  ref: ExternalTypeRef,
  instance: GQLManager,
  schemaCache: SchemaCache,
): GraphQLNamedType {
  const type = build(expectedName, ref, instance, schemaCache);
  const named = (type ? getNamedType(type as GraphQLType) : undefined) as GraphQLNamedType | undefined;
  if (!named) {
    throw new Error(
      `gqlize: external type "${expectedName}" (${describeRef(ref)}) resolved to nothing on the ` +
        "live definitions",
    );
  }
  if (named.name !== expectedName) {
    throw new Error(
      `gqlize: external type "${expectedName}" (${describeRef(ref)}) is now named ` +
        `"${named.name}" on the live definitions — the artifact is stale, rebuild it`,
    );
  }
  return named;
}

function build(
  expectedName: string,
  ref: ExternalTypeRef,
  instance: GQLManager,
  schemaCache: SchemaCache,
): unknown {
  const definition = instance.getDefinition(ref.defName);
  if (!definition) {
    throw new Error(
      `gqlize: external type "${expectedName}" needs definition "${ref.defName}", which the ` +
        "live ormize instance does not have",
    );
  }
  if (ref.via === "definitionWhereOperator") {
    const type = definition.whereOperatorTypes?.[ref.operator];
    if (!type) {
      throw new Error(
        `gqlize: external type "${expectedName}" needs ` +
          `${ref.defName}.whereOperatorTypes.${ref.operator}, which the live definition does not ` +
          "have",
      );
    }
    return type;
  }
  if (ref.via === "definitionField") {
    const field = instance.getFields(ref.defName)?.[ref.fieldName];
    const arg = field?.args?.[ref.argName];
    if (!arg) {
      throw new Error(
        `gqlize: external type "${expectedName}" needs argument "${ref.argName}" on ` +
          `${ref.defName}.${ref.fieldName}, which the live definition does not have`,
      );
    }
    return arg.type;
  }
  if (ref.via === "definitionOverride") {
    const override = definition.override?.[ref.fieldName];
    if (!override) {
      throw new Error(
        `gqlize: external type "${expectedName}" needs ${ref.defName}.override.${ref.fieldName}, ` +
          "which the live definition does not have",
      );
    }
    return ref.use === "type"
      ? overrideOutputType(override)
      : overrideInputType(override, ref, definition, instance, schemaCache);
  }
  // definitionExpose — these are used verbatim by the builders, so the live
  // value *is* the type; no normalisation to repeat.
  const group = ref.group === "classMethods"
    ? definition.expose?.classMethods?.[ref.target]
    : definition.expose?.instanceMethods?.[ref.target];
  const method = group?.[ref.methodName];
  if (!method) {
    throw new Error(
      `gqlize: external type "${expectedName}" needs ` +
        `${ref.defName}.expose.${ref.group}.${ref.target}.${ref.methodName}, which the live ` +
        "definition does not have",
    );
  }
  if (ref.use === "type") {
    return method.type;
  }
  const arg = method.args?.[ref.argName!];
  if (!arg) {
    throw new Error(
      `gqlize: external type "${expectedName}" needs argument "${ref.argName}" on ` +
        `${ref.defName}.expose.${ref.group}.${ref.target}.${ref.methodName}, which the live ` +
        "definition does not have",
    );
  }
  return arg.type;
}

/** mirrors `create-basic-fields.ts` — the override output-type branch */
function overrideOutputType(override: AuthoredOverride) {
  if (!isBuiltOutputType(override.type)) {
    return new GraphQLObjectType(override.type as GraphQLObjectTypeConfig<AdapterRow, RequestContext>);
  }
  return override.type;
}

/** mirrors `create-mutation-input.ts` — the override input-type branch, naming included */
function overrideInputType(
  override: AuthoredOverride,
  ref: Extract<ExternalTypeRef, {via: "definitionOverride"}>,
  definition: Definition,
  instance: GQLManager,
  schemaCache: SchemaCache,
) {
  const {fieldName, forceOptional} = ref;
  const type = (override.inputType || override.type) as AuthoredTypeSlot;
  let name = type.name;
  if (!override.inputType) {
    name = `${type.name}${capitalize(fieldName)}Input`;
  }
  if (forceOptional) {
    name = `${capitalize(type.name)}Optional${capitalize(fieldName)}`;
  }
  if (!isBuiltInputType(override.type)) {
    const field = instance.getFields(ref.defName)?.[fieldName];
    const comment = (definition.comments?.fields || {})[fieldName] || field?.description;
    return createGQLInputObject(name, type.fields as ThunkObjMap<GraphQLInputFieldConfig>, schemaCache, comment);
  }
  return type;
}

export function describeRef(ref: ExternalTypeRef): string {
  switch (ref.via) {
    case "definitionOverride":
      return `${ref.defName}.override.${ref.fieldName} ${ref.use}`;
    case "definitionWhereOperator":
      return `${ref.defName}.whereOperatorTypes.${ref.operator}`;
    case "definitionField":
      return `${ref.defName}.${ref.fieldName}(${ref.argName}:)`;
    default:
      return `${ref.defName}.expose.${ref.group}.${ref.target}.${ref.methodName} ${ref.use}`;
  }
}
