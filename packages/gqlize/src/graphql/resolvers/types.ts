import type { GraphQLFieldResolver } from "graphql";
import type GQLManager from "../../manager";
import type { GqlizeOptions } from "../../types";

/**
 * Key under a field's `extensions` where its binding descriptor is stamped.
 * Namespaced so it cannot collide with user-supplied extensions.
 */
export const GQLIZE_EXT = "gqlize" as const;

/**
 * Where a connection's page of rows comes from. `defName` is always the model
 * the rows belong to; for a relationship it is the *target* of the association,
 * while `parentDefName` owns the association itself.
 */
export type DataSourceDescriptor =
  | { source: "findAll"; defName: string }
  | {
      source: "manyRelationship";
      defName: string;
      parentDefName: string;
      relName: string;
    };

/**
 * A serializable description of one gqlize resolver. Every variant carries only
 * plain data: the runtime pieces (hooks, user resolvers, associations) are
 * looked back up from the live ormize definitions when the resolver is built.
 */
export type FieldBinding =
  /** create-list-object: root lists and hasMany/belongsToMany connections */
  | {
      kind: "connection";
      connectionName: string;
      targetDefName: string;
      data: DataSourceDescriptor;
    }
  /** create-related-fields: hasOne/belongsTo. `defName` is the parent. */
  | {
      kind: "singleRelationship";
      defName: string;
      relName: string;
      targetDefName: string;
    }
  /** create-basic-fields: primary/foreign keys rendered as relay global ids */
  | {
      kind: "globalId";
      defName: string;
      fieldName: string;
      typeName: string;
      nullable: boolean;
    }
  /** create-basic-fields: a user `resolve` hung off the model field definition */
  | { kind: "modelField"; defName: string; fieldName: string }
  /** create-basic-fields: `definition.override[fieldName].output` */
  | { kind: "overrideOutput"; defName: string; fieldName: string }
  /** create-complex-fields: `expose.instanceMethods.query` */
  | { kind: "instanceMethod"; defName: string; methodName: string }
  /** create-class-methods: `expose.classMethods.{query,mutations}` */
  | {
      kind: "classMethod";
      defName: string;
      methodName: string;
      target: "query" | "mutations";
    }
  /** create-mutation-model: the create/update/delete/select entry point */
  | { kind: "mutationModel"; defName: string }
  /** grouping objects whose only job is to return `{}` so children resolve */
  | { kind: "container" }
  /** the relay `node` root field — rebuilt live, never serialized */
  | { kind: "nodeField" }
  /** `options.extend.*` — user config passed through verbatim, never serialized */
  | { kind: "extend"; target: "query" | "mutation"; key: string };

export type FieldBindingKind = FieldBinding["kind"];

/** Everything a resolver factory needs to close over. */
export interface BindingContext {
  instance: GQLManager;
  options: GqlizeOptions;
}

export interface BindingHandler<B extends FieldBinding> {
  /** Returns undefined when the binding needs no resolver of its own. */
  build(binding: B, ctx: BindingContext): GraphQLFieldResolver<any, any> | undefined;
}
