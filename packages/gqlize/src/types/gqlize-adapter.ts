import { GraphQLFieldConfigArgumentMap, GraphQLInputType, GraphQLOutputType } from "graphql";
import { OrmAdapter, Definition, IdTranslation, NativeDataType, Permission, Selection } from "./index";

/**
 * The GraphQL-facing adapter contract. Extends the GraphQL-free {@link OrmAdapter}
 * with the methods that return `graphql` types. The data-fetch methods
 * (`processListArgsToOptions`, `resolveManyRelationship`, `resolveSingleRelationship`)
 * now live on {@link OrmAdapter} so `@azerothian/ormize` can drive them graphql-free.
 * `@azerothian/gqlize` and the adapter implementation depend on this; `@azerothian/ormize`
 * depends only on `OrmAdapter` and stays graphql-free.
 */
export interface GqlizeAdapter extends OrmAdapter {
  getTypeMapper(): ((type: NativeDataType, modelName: string, newTypeName: string) => GraphQLInputType | GraphQLOutputType);
  /**
   * The extra arguments this adapter contributes to a list field — `where`, and
   * `include` when the model has any includable relationship. A *map* of argument
   * configs, not a single input type: gqlize merges it into the field's `args`
   * alongside the relay cursor arguments it adds itself.
   */
  getDefaultListArgs(defName: string, definition: Definition, permission?: Permission): GraphQLFieldConfigArgumentMap;
  /**
   * Undefined when the model has nothing orderable — which happens when the
   * permission bag denies every field. An enum with no members is an invalid
   * GraphQL type, so an adapter must return nothing rather than an empty one,
   * and callers omit the `orderBy` argument entirely.
   */
  getOrderByGraphQLType(defName: string, permission?: Permission): GraphQLInputType | undefined;
  getFilterGraphQLType(defName: string, definition: Definition, permission?: Permission): GraphQLInputType;
  /**
   * Ids arrive opaque; both hooks rewrite them to their underlying values in
   * place before the args reach the backend.
   *
   * `variableValues` is optional because an id may have arrived as a literal in
   * the query document rather than through a variable, and because a caller
   * driving a resolver outside a GraphQL request has no variables at all. Both
   * shipped adapters hand it straight to `replaceIdDeep`, which treats an absent
   * bag as "no variables to look through".
   *
   * `translation` carries `options.id`. It is a trailing parameter rather than a
   * replacement for `variableValues` so that an out-of-tree adapter that never
   * learned about it keeps working: it ignores the argument and decodes with the
   * default base64 `Type:id` codec, which is the only format it could have been
   * built against anyway. An adapter that wants to honour a custom codec passes
   * this straight through to `replaceIdDeep`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GraphQL argument and variable values: arbitrary client JSON on its way into the adapter's `where` builder. `unknown` would force a narrowing into every out-of-tree adapter that implements this interface and into every caller that indexes the returned map, which is a breaking change to the published 6.0.0 adapter contract.
  replaceIdInArgs(args: {[name: string]: any}, defName: string, variableValues?: {[name: string]: any}, translation?: IdTranslation): {[name: string]: any} | Promise<{[name: string]: any}>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same GraphQL variable-value map as `replaceIdInArgs` above, and part of the same published adapter contract.
  replaceIdInInclude(include: Selection["include"], defName: string, variableValues?: {[name: string]: any}, translation?: IdTranslation): Selection["include"];
  /**
   * Optional: capture the permission bag for the duration of a schema build.
   * The filter/order/include type builders above fall back to it when no
   * explicit permission is threaded through, so a denied field stays out of the
   * filter and order inputs too — otherwise a hidden field remains filterable
   * and a denied relationship joinable, which is an information-disclosure
   * oracle. Adapters whose builders take the permission explicitly may omit it.
   */
  setBuildPermission?(permission: Permission | undefined): void;
}
