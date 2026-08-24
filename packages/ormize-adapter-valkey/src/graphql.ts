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
import { ValkeyModel } from "./model";

// The `where`/`orderBy`/`include` builders themselves live in
// `@azerothian/graphql-types/adapter-args`, shared with the SQL adapter. What
// stays here is the one piece that is genuinely Valkey-specific: which fields
// are filterable at all, and with which operators.

/** Only indexed / unique / primary / foreign-key fields are filterable — nothing
 *  else can be searched without a keyspace scan. */
function filterableFields(model: ValkeyModel): string[] {
  return Object.keys(model.fields).filter((k) => model.isSearchable(k) || model.fields[k].foreignKey);
}

export function createQueryConfig(model: ValkeyModel, permission?: Permission): QueryTypeConfig {
  const defName = model.name;
  const f: {[fieldName: string]: GraphQLInputType} = {};
  for (const k of filterableFields(model)) {
    if (!isFieldAllowed(permission, defName, k)) continue;
    const field = model.fields[k];
    f[k] = field.primaryKey || field.foreignKey ? GraphQLID : typeMapper(field.type, `GQLTWhere${defName}`, k);
  }
  const iso: {[operatorName: string]: GraphQLInputType} = {};
  if (model.definition.whereOperators) {
    for (const k of Object.keys(model.definition.whereOperators)) {
      // `whereOperatorTypes` is the author's own operator -> GraphQL type map;
      // `Definition` leaves its values open because it must not name a graphql
      // type, so it is narrowed here, where it is read.
      iso[k] = (model.definition.whereOperatorTypes?.[k] as GraphQLInputType) || GraphQLBoolean;
    }
  }
  return {
    modelName: defName,
    fields: f,
    isolatedFields: iso,
    valueFuncs: [...CORE_VALUE_FUNCS],
    arrayFuncs: [...CORE_ARRAY_FUNCS],
    arrayValues: [...CORE_ARRAY_VALUES],
  };
}
