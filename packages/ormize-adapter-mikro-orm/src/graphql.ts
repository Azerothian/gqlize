import { GraphQLID, GraphQLBoolean, type GraphQLInputType } from "graphql";
import { type QueryTypeConfig } from "@azerothian/graphql-types/query";
import {
  CORE_ARRAY_FUNCS,
  CORE_ARRAY_VALUES,
  CORE_VALUE_FUNCS,
} from "@azerothian/graphql-types/operators";
import { isFieldAllowed } from "@azerothian/utilize/gate";
import type { Permission } from "@azerothian/utilize/types/index";
import typeMapper from "./type-mapper";
import type { MikroModel } from "./model";
import type { MikroAdapterOptions } from "./types/index";

// The `where`/`orderBy`/`include` builders themselves live in
// `@azerothian/graphql-types/adapter-args`, shared with the other adapters. What
// stays here is the one genuinely backend-specific piece: which fields are
// filterable, and with which operators.

/**
 * Postgres' array and range operators.
 *
 * Opt-in, for the reason the SQL adapter gates its regexp operators: MikroORM
 * only translates `$overlap`/`$contains`/`$contained` on Postgres, and the
 * filter vocabulary must not advertise an operator the configured driver will
 * reject at query time. Appended rather than interleaved — order is part of the
 * SDL contract, so the base list has to keep the positions it already has.
 */
const POSTGRES_ARRAY_VALUES = ["overlap", "contains", "contained"] as const;

export function createQueryConfig(
  model: MikroModel, permission?: Permission, options: MikroAdapterOptions = {},
): QueryTypeConfig {
  const defName = model.name;
  const fields: { [fieldName: string]: GraphQLInputType } = {};
  for (const key of Object.keys(model.fields)) {
    if (!isFieldAllowed(permission, defName, key)) {
      continue;
    }
    const field = model.fields[key];
    // A primary or foreign key is filtered on with the relay global id the
    // schema hands out for it, not with the raw column value — so it is typed
    // `ID` here and decoded by `replaceIdInWhere` on the way down.
    fields[key] = field.primaryKey || field.foreignKey
      ? GraphQLID
      : typeMapper(field.type, `GQLTWhere${defName}`, key);
  }
  const isolatedFields: { [operatorName: string]: GraphQLInputType } = {};
  if (model.definition.whereOperators) {
    for (const key of Object.keys(model.definition.whereOperators)) {
      // `whereOperatorTypes` is the author's own operator -> GraphQL type map;
      // `Definition` leaves its values open because it must not name a graphql
      // type, so it is narrowed here, where it is read.
      isolatedFields[key] = (model.definition.whereOperatorTypes?.[key] as GraphQLInputType) || GraphQLBoolean;
    }
  }
  return {
    modelName: defName,
    fields,
    isolatedFields,
    valueFuncs: [...CORE_VALUE_FUNCS],
    arrayFuncs: [...CORE_ARRAY_FUNCS],
    arrayValues: options.enablePostgresArrayOperators
      ? [...CORE_ARRAY_VALUES, ...POSTGRES_ARRAY_VALUES]
      : [...CORE_ARRAY_VALUES],
  };
}
