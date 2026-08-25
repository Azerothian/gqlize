import type { GraphQLInputFieldConfig, ThunkObjMap } from "graphql";

import type { GqlFieldConfig } from "../../types";
import {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLScalarType,
  GraphQLEnumType,
} from "graphql";


/**
 * The `type` slots on a definition — `override.*.type`, `override.*.inputType`,
 * `expose.*.type` — are `unknown` in `@azerothian/utilize` because that package
 * is deliberately graphql-free and cannot name what may go in them. gqlize is the
 * layer that does know, so the narrowing lives here rather than being guessed at
 * a dozen call sites.
 *
 * An author may write either a *built* GraphQL type or the *config object* for
 * one. The two guards below separate those cases; `AuthoredTypeSlot` describes
 * what both forms have in common, which is all a caller may read before choosing
 * a branch.
 */
export type AuthoredTypeSlot = {
  /** Present on a built type and required on a config — the builders read it either way. */
  name: string;
  /**
   * Only a config carries this; a built type exposes `getFields()` instead.
   *
   * Output and input configs are both authored into these slots and graphql's
   * two field-map shapes do not overlap, so the union is what an author may
   * legally write. Each reader hands it to the constructor matching the slot it
   * came out of — `override.type` builds an object type, `override.inputType`
   * an input object — and narrows to that arm there.
   */
  fields?: ThunkObjMap<GqlFieldConfig> | ThunkObjMap<GraphQLInputFieldConfig>;
};

/**
 * True when the author supplied an already-built output type rather than a config.
 * The narrowed type is the exact set tested for — all nullable and named — so a
 * caller may still wrap it in `GraphQLNonNull` or read `.name`.
 */
export function isBuiltOutputType(token: unknown): token is GraphQLObjectType | GraphQLScalarType | GraphQLEnumType {
  return token instanceof GraphQLObjectType
    || token instanceof GraphQLScalarType
    || token instanceof GraphQLEnumType;
}

/** True when the author supplied an already-built input type rather than a config. */
export function isBuiltInputType(token: unknown): token is GraphQLInputObjectType | GraphQLScalarType | GraphQLEnumType {
  return token instanceof GraphQLInputObjectType
    || token instanceof GraphQLScalarType
    || token instanceof GraphQLEnumType;
}
