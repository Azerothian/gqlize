// Relay global-id translation: decoding opaque IDs in where clauses and include
// trees before they reach Sequelize. The adapter class in `index.ts` delegates here.

import replaceIdDeep from "@azerothian/gqlize/utils/replace-id-deep";
import { globalKeysFromFields, globalKeyTargets } from "@azerothian/utilize/utils/global-keys";
import type {
  AdapterWhere,
  Association,
  DefinitionFieldMeta,
  IdTranslation,
  IncludeDescriptor,
  IncludeMap,
  Selection,
} from "@azerothian/utilize/types/index";

/**
 * What the id-translation functions reach into.
 */
export interface IdTranslationHost {
  getFields(modelName: string): { [fieldName: string]: DefinitionFieldMeta };
  getAssociation(modelName: string, assocName: string): Association;
  getGlobalKeys(defName: string): string[];
  replaceIdInWhere(
    where: AdapterWhere | undefined,
    defName: string,
    variableValues?: unknown,
    translation?: IdTranslation,
  ): unknown;
  replaceIdInInclude(
    arrIncludeVar: Selection["include"],
    defName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches GqlizeAdapter.replaceIdInInclude's published signature
    variableValues?: {[name: string]: any},
    translation?: IdTranslation,
  ): unknown;
}

export function getGlobalKeysImpl(
  host: { getFields(modelName: string): { [fieldName: string]: DefinitionFieldMeta } },
  defName: string,
): string[] {
  return globalKeysFromFields(host.getFields(defName));
}

/**
 * Each hop re-derives `targets` for the model it is about to decode against,
 * rather than carrying the caller's down: a nested relation's `where` filters
 * the *target's* keys, and typing them with the parent's map is how a
 * cross-type id would slip through the check it exists to make.
 */
export function buildIdTranslation(
  host: { getFields(modelName: string): { [fieldName: string]: DefinitionFieldMeta } },
  defName: string,
  translation?: IdTranslation,
): IdTranslation {
  return {
    ...translation,
    defName,
    targets: globalKeyTargets(host.getFields(defName), defName),
  };
}

export function replaceIdInWhereImpl(
  host: IdTranslationHost,
  where: AdapterWhere | undefined,
  defName: string,
  variableValues?: unknown,
  translation?: IdTranslation,
) {
  const globalKeys = host.getGlobalKeys(defName);
  return replaceIdDeep(where, globalKeys, variableValues, buildIdTranslation(host, defName, translation));
}

// `GqlizeAdapter.replaceIdInInclude` declares `variableValues` with this exact
// permissive shape, so it stays here rather than narrowing to `unknown` the
// way the internal `replaceIdInWhere` does.
export function replaceIdInIncludeImpl(
  host: IdTranslationHost,
  arrIncludeVar: Selection["include"],
  defName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches GqlizeAdapter.replaceIdInInclude's published signature
  variableValues?: {[name: string]: any},
  translation?: IdTranslation,
) {
  return (arrIncludeVar || []).map(
    (iv) => {
      return Object.keys(iv).reduce((o, relName) => {
        const { include, where, ...rest } = iv[relName];
        o[relName] = rest;
        const rel = host.getAssociation(defName, relName);
        if (where) {
          o[relName].where = host.replaceIdInWhere(
            where,
            rel.target,
            variableValues,
            translation
          ) as AdapterWhere;
        }
        if (include) {
          o[relName].include = host.replaceIdInInclude(
            include,
            rel.target,
            variableValues,
            translation
          ) as IncludeMap[];
        }
        return o;
      }, {} as { [relName: string]: IncludeDescriptor });
    }
  );
}

// `GqlizeAdapter.replaceIdInArgs` declares both `args` and `variableValues`
// with this exact permissive shape — kept to match.
export function replaceIdInArgsImpl(
  host: IdTranslationHost,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches GqlizeAdapter.replaceIdInArgs's published signature
  args: { [name: string]: any },
  defName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches GqlizeAdapter.replaceIdInArgs's published signature
  variableValues?: {[name: string]: any},
  translation?: IdTranslation,
) {
  const { where, include, ...rest } = args;
  if (include) {
    rest.include = host.replaceIdInInclude(include, defName, variableValues, translation);
  }
  if (where) {
    rest.where = host.replaceIdInWhere(where, defName, variableValues, translation);
  }
  return rest;
}
