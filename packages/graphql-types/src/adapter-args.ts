import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLInputFieldConfigMap,
} from "graphql";
import { isFieldAllowed, isModelAllowed, isRelationshipAllowed } from "@azerothian/utilize/gate";
import type { Definition, OrderEntry, Permission } from "@azerothian/utilize/types/index";
import createQueryType, { type QueryTypeConfig } from "./query";

/**
 * The `where` / `orderBy` / `include` argument builders every ORM adapter needs.
 *
 * These four were written twice — once per adapter — and had to stay in step,
 * because gqlize calls them by name off the adapter and builds the whole list
 * field from what comes back. Worse, they carry the permission guards: a bug
 * that let a denied field through here would make it filterable or sortable
 * even though it never appears in the output type.
 *
 * They are free functions over a structural host rather than a base class, so an
 * adapter stays a plain object with no inheritance and declares exactly which of
 * its own members this layer may reach into.
 */

/** A relationship as this layer needs to see it. */
export interface HostRelationship {
  name: string;
  /** Target definition name. */
  model: string;
}

/** The target of a relationship, resolved on the *owning* adapter. */
export interface HostTarget {
  /** The target's registered name, which is what the recursion is keyed on. */
  name: string;
  definition: Definition;
}

/** What the builders below need from the adapter. */
export interface AdapterArgsHost {
  /** The permission captured for the duration of a schema build, if any. */
  _buildPermission?: Permission;
  getMetaObj(defName: string, key: string): unknown;
  setMetaObj(defName: string, key: string, value: unknown): void;
  /**
   * The filter-input description for one model. Deliberately still per-adapter:
   * the operator vocabularies differ, and so do the rules for which fields are
   * filterable at all (Valkey can only filter what it has indexed; the SQL
   * adapter adds a belongsTo foreign-key pass).
   */
  queryConfigFor(defName: string, definition: Definition | undefined, permission?: Permission): QueryTypeConfig;
  /** Every field name the model could be ordered by, before permission filtering. */
  orderableFields(defName: string): string[];
  /** Declared relationships, before permission filtering. */
  relationshipsOf(defName: string, definition: Definition | undefined): HostRelationship[];
  /**
   * Resolve a relationship target, or `undefined` when it is not this adapter's
   * model. A cross-adapter target cannot be eager-loaded in one round trip — it
   * is resolved by its own adapter as a separate query — so it is not includable.
   */
  targetOf(modelName: string): HostTarget | undefined;
  /**
   * Whether `include` is a list of include objects. True for a SQL adapter,
   * where an include is a JOIN and a model may be joined more than once; false
   * for a key-value adapter, which takes one object keyed by relationship name.
   * Also selects the type name, so both halves of the divergence move together.
   */
  readonly includeIsList: boolean;
}

/** Resolve the effective permission: an explicit argument wins over the build-time one. */
function effective(host: AdapterArgsHost, permission?: Permission): Permission | undefined {
  return permission !== undefined ? permission : host._buildPermission;
}

/** The `where` input for a model. Memoized on the adapter's meta store. */
export function getFilterGraphQLType(
  host: AdapterArgsHost, defName: string, definition?: Definition, permission?: Permission,
): GraphQLInputObjectType {
  if (!host.getMetaObj(defName, "queryType")) {
    const config = host.queryConfigFor(defName, definition, effective(host, permission));
    host.setMetaObj(defName, "queryType", createQueryType(config));
  }
  return host.getMetaObj(defName, "queryType") as GraphQLInputObjectType;
}

/**
 * The `orderBy` enum list for a model, or `undefined` when permissions deny
 * every orderable field — an enum with no values is an invalid GraphQL type, so
 * the meta is left unset and callers omit the argument entirely.
 */
export function getOrderByGraphQLType(
  host: AdapterArgsHost, defName: string, permission?: Permission,
): GraphQLList<GraphQLEnumType> | undefined {
  if (!host.getMetaObj(defName, "orderByType")) {
    const perm = effective(host, permission);
    // Only permission-allowed fields are orderable — a denied field must not be
    // sortable, which is another way to leak its value.
    const values: {[enumValueName: string]: {value: OrderEntry}} = {};
    for (const fieldName of host.orderableFields(defName)) {
      if (!isFieldAllowed(perm, defName, fieldName)) {
        continue;
      }
      values[`${fieldName}ASC`] = { value: [fieldName, "ASC"] };
      values[`${fieldName}DESC`] = { value: [fieldName, "DESC"] };
    }
    if (Object.keys(values).length > 0) {
      host.setMetaObj(defName, "orderByType", new GraphQLList(new GraphQLEnumType({
        name: `${defName}OrderBy`,
        values,
      })));
    }
  }
  return host.getMetaObj(defName, "orderByType") as GraphQLList<GraphQLEnumType> | undefined;
}

/**
 * The `include` input for a model, or `undefined` when it has no includable
 * relationship — either because it declares none, or because every one of them
 * was filtered out below. An input object with no fields is an invalid GraphQL
 * type, so as with `orderBy` the meta is left unset and callers omit the
 * argument.
 */
export function getIncludeGraphQLType(
  host: AdapterArgsHost, defName: string, definition?: Definition, permission?: Permission,
): GraphQLInputObjectType | GraphQLList<GraphQLInputObjectType> | undefined {
  const perm = effective(host, permission);
  const relationships = host.relationshipsOf(defName, definition);
  if (!host.getMetaObj(defName, "includeType") && relationships.length > 0) {
    const fields: GraphQLInputFieldConfigMap = {};
    for (const relationship of relationships) {
      // A denied association must not stay joinable/orderable through `include`.
      if (!isRelationshipAllowed(perm, defName, relationship.name, relationship.model)) {
        continue;
      }
      // A relationship whose target model is denied has no output type in the
      // schema either (see gqlize's create-related-fields), so including it
      // would expose a restricted datatype as a join target.
      if (!isModelAllowed(perm, relationship.model)) {
        continue;
      }
      const target = host.targetOf(relationship.model);
      if (!target) {
        continue;
      }
      fields[relationship.name] = {
        type: new GraphQLInputObjectType({
          name: `GQLT${defName}Include${relationship.name}Object`,
          fields: () => {
            const includeFields: GraphQLInputFieldConfigMap = {
              required: { type: GraphQLBoolean },
              separate: { type: GraphQLBoolean },
              where: { type: getFilterGraphQLType(host, target.name, target.definition, permission) },
            };
            // A target whose orderable fields are all denied has no orderBy enum,
            // and a leaf target has no include type; expose each only when it exists.
            const targetOrderBy = getOrderByGraphQLType(host, target.name, permission);
            if (targetOrderBy) {
              includeFields.orderBy = { type: targetOrderBy };
            }
            const nested = getIncludeGraphQLType(host, target.name, target.definition, permission);
            if (nested) {
              includeFields.include = { type: nested };
            }
            return includeFields;
          },
        }),
      };
    }
    if (Object.keys(fields).length > 0) {
      const object = new GraphQLInputObjectType({
        name: host.includeIsList ? `GQLT${defName}IncludeObject` : `GQLT${defName}Include`,
        fields,
      });
      host.setMetaObj(defName, "includeType", host.includeIsList ? new GraphQLList(object) : object);
    }
  }
  return host.getMetaObj(defName, "includeType") as
    GraphQLInputObjectType | GraphQLList<GraphQLInputObjectType> | undefined;
}

/** The argument map gqlize puts on every list field of this model. */
export function getDefaultListArgs(
  host: AdapterArgsHost, defName: string, definition?: Definition, permission?: Permission,
): GraphQLFieldConfigArgumentMap {
  const includeType = getIncludeGraphQLType(host, defName, definition, permission);
  const args: GraphQLFieldConfigArgumentMap = {
    where: { type: getFilterGraphQLType(host, defName, definition, permission) },
  };
  if (includeType) {
    args.include = { type: includeType };
  }
  return args;
}
