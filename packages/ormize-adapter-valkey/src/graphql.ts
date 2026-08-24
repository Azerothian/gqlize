import {
  GraphQLID, GraphQLList, GraphQLEnumType, GraphQLInputObjectType, GraphQLBoolean,
  type GraphQLFieldConfigArgumentMap, type GraphQLInputFieldConfigMap, type GraphQLInputType,
} from "graphql";
import createQueryType, { type QueryTypeConfig } from "@azerothian/graphql-types/query";
import {
  CORE_ARRAY_FUNCS,
  CORE_ARRAY_VALUES,
  CORE_VALUE_FUNCS,
} from "@azerothian/graphql-types/operators";
import { isFieldAllowed, isModelAllowed, isRelationshipAllowed } from "@azerothian/utilize/gate";
import type { Definition, OrderEntry, Permission } from "@azerothian/utilize/types/index";
import typeMapper from "./type-mapper";
import { ValkeyModel } from "./model";

/**
 * What these builders need off the adapter. Structural rather than importing
 * `ValkeyAdapter` itself: it is `./index` that imports this module, and naming
 * only the members actually used keeps the dependency one-directional — and the
 * list honest about how much of the adapter these reach into.
 */
export interface GraphQLTypeHost {
  /** The permission captured for the duration of a schema build, if any. */
  _buildPermission?: Permission;
  getMetaObj(defName: string, key: string): unknown;
  setMetaObj(defName: string, key: string, value: unknown): void;
  model(defName: string): ValkeyModel;
  /** Absent for a target that lives on another adapter — see `getIncludeGraphQLType`. */
  getModel(defName: string): unknown;
}

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

export function getFilterGraphQLType(
  adapter: GraphQLTypeHost, defName: string, _definition?: Definition, permission?: Permission,
): GraphQLInputObjectType {
  const perm = permission !== undefined ? permission : adapter._buildPermission;
  if (!adapter.getMetaObj(defName, "queryType")) {
    adapter.setMetaObj(defName, "queryType", createQueryType(createQueryConfig(adapter.model(defName), perm)));
  }
  return adapter.getMetaObj(defName, "queryType") as GraphQLInputObjectType;
}

/** Undefined when permissions deny every orderable field — see below. */
export function getOrderByGraphQLType(
  adapter: GraphQLTypeHost, defName: string, permission?: Permission,
): GraphQLList<GraphQLEnumType> | undefined {
  const perm = permission !== undefined ? permission : adapter._buildPermission;
  if (!adapter.getMetaObj(defName, "orderByType")) {
    const model = adapter.model(defName);
    const values = Object.keys(model.fields).reduce((o: {[enumValueName: string]: {value: OrderEntry}}, fieldName) => {
      if (!isFieldAllowed(perm, defName, fieldName)) return o;
      o[`${fieldName}ASC`] = { value: [fieldName, "ASC"] };
      o[`${fieldName}DESC`] = { value: [fieldName, "DESC"] };
      return o;
    }, {});
    // An enum with no values is an invalid GraphQL type — when permissions deny
    // every orderable field, leave the meta unset so callers omit `orderBy`.
    if (Object.keys(values).length) {
      adapter.setMetaObj(defName, "orderByType", new GraphQLList(new GraphQLEnumType({
        name: `${defName}OrderBy`,
        values,
      })));
    }
  }
  return adapter.getMetaObj(defName, "orderByType") as GraphQLList<GraphQLEnumType> | undefined;
}

/** Undefined when the model has no includable relationship — see below. */
export function getIncludeGraphQLType(
  adapter: GraphQLTypeHost, defName: string, _definition?: Definition, permission?: Permission,
): GraphQLInputObjectType | undefined {
  const perm = permission !== undefined ? permission : adapter._buildPermission;
  const model = adapter.model(defName);
  const relationships = model.relationships || [];
  if (!adapter.getMetaObj(defName, "includeType") && relationships.length > 0) {
    const fields = relationships.reduce((o: GraphQLInputFieldConfigMap, relationship) => {
      if (!isRelationshipAllowed(perm, defName, relationship.name, relationship.model)) return o;
      // A relationship whose target model is denied has no output type in the
      // schema either, so it must not be includable.
      if (!isModelAllowed(perm, relationship.model)) return o;
      // A relationship whose target lives on another adapter is not a model here
      // and cannot be eager-loaded in one Valkey round trip — it is resolved by
      // the target's own adapter as a separate query, so it is not includable.
      if (!adapter.getModel(relationship.model)) return o;
      const targetName = relationship.model;
      o[relationship.name] = {
        type: new GraphQLInputObjectType({
          name: `GQLT${defName}Include${relationship.name}Object`,
          fields: () => {
            const includeFields: GraphQLInputFieldConfigMap = {
              required: { type: GraphQLBoolean },
              separate: { type: GraphQLBoolean },
              where: { type: getFilterGraphQLType(adapter, targetName, adapter.model(targetName).definition, permission) },
            };
            const targetOrderBy = getOrderByGraphQLType(adapter, targetName, permission);
            if (targetOrderBy) includeFields.orderBy = { type: targetOrderBy };
            const nested = getIncludeGraphQLType(adapter, targetName, adapter.model(targetName).definition, permission);
            if (nested) includeFields.include = { type: nested };
            return includeFields;
          },
        }),
      };
      return o;
    }, {});
    if (Object.keys(fields).length) {
      adapter.setMetaObj(defName, "includeType", new GraphQLInputObjectType({ name: `GQLT${defName}Include`, fields }));
    }
  }
  return adapter.getMetaObj(defName, "includeType") as GraphQLInputObjectType | undefined;
}

export function getDefaultListArgs(
  adapter: GraphQLTypeHost, defName: string, definition?: Definition, permission?: Permission,
): GraphQLFieldConfigArgumentMap {
  const includeType = getIncludeGraphQLType(adapter, defName, definition, permission);
  const retVal: GraphQLFieldConfigArgumentMap = { where: { type: getFilterGraphQLType(adapter, defName, definition, permission) } };
  if (includeType) retVal.include = { type: includeType };
  return retVal;
}
