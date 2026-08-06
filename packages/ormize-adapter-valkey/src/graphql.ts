import { GraphQLID, GraphQLList, GraphQLEnumType, GraphQLInputObjectType, GraphQLBoolean } from "graphql";
import createQueryType from "@azerothian/graphql-types/query";
import { isFieldAllowed, isModelAllowed, isRelationshipAllowed } from "@azerothian/utilize/gate";
import typeMapper from "./type-mapper";
import { ValkeyModel } from "./model";

/** Only indexed / unique / primary / foreign-key fields are filterable — nothing
 *  else can be searched without a keyspace scan. */
function filterableFields(model: ValkeyModel): string[] {
  return Object.keys(model.fields).filter((k) => model.isSearchable(k) || model.fields[k].foreignKey);
}

export function createQueryConfig(model: ValkeyModel, permission: any): any {
  const defName = model.name;
  const f: any = {};
  for (const k of filterableFields(model)) {
    if (!isFieldAllowed(permission, defName, k)) continue;
    const field = model.fields[k];
    f[k] = field.primaryKey || field.foreignKey ? GraphQLID : typeMapper(field.type, `GQLTWhere${defName}`, k);
  }
  const iso: any = {};
  if (model.definition.whereOperators) {
    for (const k of Object.keys(model.definition.whereOperators)) {
      iso[k] = model.definition.whereOperatorTypes?.[k] || GraphQLBoolean;
    }
  }
  return {
    modelName: defName,
    fields: f,
    isolatedFields: iso,
    valueFuncs: ["eq", "ne", "gte", "lte", "lt", "not", "is", "like", "notLike", "iLike", "notILike", "startsWith", "endsWith", "substring"],
    arrayFuncs: ["or", "and"],
    arrayValues: ["in", "notIn", "between", "notBetween"],
  };
}

export function getFilterGraphQLType(adapter: any, defName: string, _definition: any, permission?: any): any {
  const perm = permission !== undefined ? permission : adapter._buildPermission;
  if (!adapter.getMetaObj(defName, "queryType")) {
    adapter.setMetaObj(defName, "queryType", createQueryType(createQueryConfig(adapter.model(defName), perm)));
  }
  return adapter.getMetaObj(defName, "queryType");
}

export function getOrderByGraphQLType(adapter: any, defName: string, permission?: any): any {
  const perm = permission !== undefined ? permission : adapter._buildPermission;
  if (!adapter.getMetaObj(defName, "orderByType")) {
    const model: ValkeyModel = adapter.model(defName);
    const values = Object.keys(model.fields).reduce((o: any, fieldName) => {
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
  return adapter.getMetaObj(defName, "orderByType");
}

export function getIncludeGraphQLType(adapter: any, defName: string, _definition: any, permission?: any): any {
  const perm = permission !== undefined ? permission : adapter._buildPermission;
  const model: ValkeyModel = adapter.model(defName);
  if (!adapter.getMetaObj(defName, "includeType") && (model.relationships || []).length > 0) {
    const fields = model.relationships.reduce((o: any, relationship: any) => {
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
            const includeFields: any = {
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
  return adapter.getMetaObj(defName, "includeType");
}

export function getDefaultListArgs(adapter: any, defName: string, definition: any, permission?: any): any {
  const includeType = getIncludeGraphQLType(adapter, defName, definition, permission);
  const retVal: any = { where: { type: getFilterGraphQLType(adapter, defName, definition, permission) } };
  if (includeType) retVal.include = { type: includeType };
  return retVal;
}
