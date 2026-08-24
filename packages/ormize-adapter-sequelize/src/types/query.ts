// The Sequelize-shaped types this adapter builds queries out of. They live apart
// from `../index` because the query-options layer is built over them and would
// otherwise have to import back through the barrel that imports it.

import type {
  IncludeOptions,
  Model,
  ModelCtor,
  Sequelize,
} from "sequelize";
import type {
  AdapterWhere,
  IncludeMap,
  Relationship,
  RequestContext,
} from "@azerothian/utilize/types/index";
import type { SequelizeDefinition } from "./index";

/**
 * A model class, augmented with the two statics this adapter installs on it:
 * `createModel` stamps the authored definition onto the class, and
 * `createRelationship` builds `relationships` up on it as each one is wired.
 * Sequelize's `ModelCtor` knows about neither.
 *
 * Both are declared non-optional rather than `?`: every model reaching this
 * adapter's read paths came out of `createModel`, which installs `definition`
 * before it returns. A model without one is a wiring error, not a case for every
 * read site to branch on.
 */
export type SequelizeModelClass = ModelCtor<Model<any, any>> & {
  definition: SequelizeDefinition;
  relationships: { [relName: string]: SequelizeRelationship };
};

/**
 * A wired relationship as this adapter records it on the model class: the
 * arguments `createRelationship` was given, plus `rel` — the live Sequelize
 * association object it produced. Nothing here reads `rel` back; it is kept
 * because it is the only handle onto the native association.
 */
export type SequelizeRelationship = {
  name: string;
  type: string;
  source: string;
  target: string;
  options: Relationship["options"];
  rel: unknown;
};

/**
 * A row as this adapter produces and consumes it: a Sequelize model instance.
 * The contract calls a row `AdapterRow` (`unknown`) because no caller may assume
 * a shape — but the adapter that produced it may, which is precisely why
 * `OrmAdapter` is declared with method syntax rather than function properties.
 */
export type SequelizeRow = Model<any, any>;

/**
 * The list arguments this adapter reads off a field's args bag. Open, because
 * everything not named here is forwarded verbatim — which is also why the
 * contract declares this parameter as an open bag.
 */
export type ListArgs = {
  first?: number;
  last?: number;
  orderBy?: SequelizeOrder[];
  where?: AdapterWhere;
  include?: IncludeMap[];
  [arg: string]: unknown;
};

/**
 * The hook dispatcher ormize threads down so a JOIN-loaded include can still
 * fire the child model's `beforeFind` — see `processIncludeStatement`. Typed as
 * the contract declares it: the hook name selects the value's shape, so neither
 * it nor the return can be narrowed here.
 */
export type RunHook = (defName: string, hookName: string, value: any, ...args: any[]) => Promise<any>;

/** An association prefix in an ORDER BY entry — Sequelize's `{model, as}` form. */
export type SequelizeOrderPrefix = { model: SequelizeModelClass; as: string };

/**
 * One ORDER BY entry as this adapter builds one: the association prefixes needed
 * to reach the column, then the column and its direction. Sequelize's own
 * `OrderItem` is a union of fixed-length tuples, which cannot describe an entry
 * assembled by spreading a variable number of prefixes onto an authored
 * `[column, direction]` pair.
 */
export type SequelizeOrder = (SequelizeOrderPrefix | string)[];

/**
 * One selected column: a name, or the `[expression, alias]` pair the inline
 * count is pushed on as.
 */
export type SequelizeAttribute = string | [ReturnType<Sequelize["literal"]>, string];

/**
 * One eager-load entry. Sequelize's own `IncludeOptions`, with three members
 * restated: `order` and `include` because they are built here in this adapter's
 * own shapes, and `getGraphQLArgs` because a `separate` include runs as its own
 * query — so the accessor has to ride on the include for the child model's find
 * hooks to reach the GraphQL args at all.
 */
export type SequelizeInclude = Omit<IncludeOptions, "order" | "include"> & {
  order?: SequelizeOrder[];
  include?: SequelizeInclude[];
  /**
   * `separate` only. Sequelize's `IncludeOptions` declares `limit` but not
   * `offset`, though a separate include is run as its own query and honours it —
   * which is what makes per-parent pagination of a `hasMany` possible at all.
   */
  offset?: number;
  getGraphQLArgs?: GetGraphQLArgs;
};

/** Reaches the live GraphQL execution args from inside an options bag. */
export type GetGraphQLArgs = () => { context: RequestContext; info: unknown; source: unknown };