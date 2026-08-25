// Turning list args into Sequelize find options: column projection, the inline
// count column, the `where`, and the include tree. Free functions over a
// structural host rather than methods, so each step is reachable (and testable)
// on its own — `processListArgsToOptions` was one 120-line function doing all
// four.

import type { Sequelize } from "sequelize";
import waterfall from "@azerothian/utilize/utils/waterfall";
import unique from "@azerothian/utilize/utils/unique";
import { clampPageSize } from "@azerothian/utilize/utils/page-size";
import type {
  AdapterListOptions,
  AdapterListRequest,
  AdapterQueryOptions,
  AdapterWhere,
  Association,
  DefinitionFieldMeta,
  IncludeMap,
  OrderEntry,
  WhereOperators,
} from "@azerothian/utilize/types/index";
import type {
  ListArgs,
  RunHook,
  SequelizeAttribute,
  SequelizeInclude,
  SequelizeModelClass,
  SequelizeOrder,
  SequelizeOrderPrefix,
} from "./types/query";
import { whereOperatorsFor } from "@azerothian/utilize/exposed-methods";

/**
 * What the option builders reach into. Structural, so `SequelizeAdapter`
 * satisfies it by having these members — no base class, and the list names
 * exactly what this layer is allowed to touch.
 */
export interface QueryOptionsHost {
  readonly sequelize: Sequelize;
  getModel(modelName: string): unknown;
  getFields(modelName: string): { [fieldName: string]: DefinitionFieldMeta };
  getPrimaryKeyNameForModel(modelName: string): string[];
  getAssociation(modelName: string, assocName: string): Association;
  hasInlineCountFeature(): boolean;
  processFilterArgument(
    where: AdapterWhere | undefined,
    whereOperators: WhereOperators | undefined,
    options: AdapterQueryOptions,
  ): Promise<AdapterWhere>;
}

/**
 * Dialects that can carry the page total on every row via a window function, so
 * a list query needs no second COUNT round-trip — and the expression each one
 * takes. Postgres accepts `COUNT(*) OVER()`; mssql and sqlite want an explicit
 * argument. One table rather than the two parallel dialect if-chains this
 * replaces (the feature test and the column builder), which could disagree.
 */
export const INLINE_COUNT_EXPRESSION: { [dialect: string]: string } = {
  postgres: "COUNT(*) OVER()",
  mssql: "COUNT(1) OVER()",
  sqlite: "COUNT(1) OVER()",
};

const modelOf = (host: QueryOptionsHost, name: string) => host.getModel(name) as SequelizeModelClass;

/**
 * The columns to select: every primary key, plus the non-key columns the caller
 * asked for. `selectedFields` absent means "all of them" — a non-GraphQL caller
 * has no selection set to narrow by.
 *
 * A foreign key survives a narrowing when the relation it points at was
 * selected: the relation is resolved from the key, so dropping it would leave
 * the resolver nothing to join on.
 */
export function selectedAttributes(
  host: QueryOptionsHost,
  defName: string,
  selectedFields: string[] | undefined,
  seed: SequelizeAttribute[] = [],
): SequelizeAttribute[] {
  const attributes = [...seed];
  const fields = host.getFields(defName);
  Object.keys(fields).forEach((key) => {
    const field = fields[key];
    if (field.primaryKey) {
      return;
    }
    if (selectedFields && selectedFields.indexOf(key) === -1) {
      const foreignTarget = field.foreignTarget ? field.foreignTarget.toLowerCase() : undefined;
      if (foreignTarget === undefined || selectedFields.indexOf(foreignTarget) === -1) {
        return;
      }
    }
    // `DefinitionFieldMeta.name` is optional because a user-authored field
    // carries none — the adapter fills it in. Either way the map is keyed by
    // field name, so `key` is the same value.
    attributes.unshift(field.name || key);
  });
  host.getPrimaryKeyNameForModel(defName).forEach((key) => {
    if (key) {
      attributes.unshift(key);
    }
  });
  return attributes;
}

/**
 * Append the window-function count column, unless one is already there. Either
 * form counts as present: a plain column named `full_count`, or the
 * `[expression, "full_count"]` alias pair this pushes.
 */
export function withInlineCount(
  host: QueryOptionsHost,
  attributes: SequelizeAttribute[],
): SequelizeAttribute[] {
  const present = attributes.some((a) =>
    typeof a === "string" ? a.indexOf("full_count") > -1 : a[1] === "full_count",
  );
  if (present) {
    return attributes;
  }
  const dialect = host.sequelize.getDialect();
  const expression = INLINE_COUNT_EXPRESSION[dialect];
  if (!expression) {
    throw new Error(`Inline count feature enabled but dialect does not match`);
  }
  return [...attributes, [host.sequelize.literal(expression), "full_count"]];
}

/**
 * Build the Sequelize `include` tree, hoisting nested ordering onto the parent
 * query's `order` where the include is a JOIN.
 */
export async function processIncludeStatement(
  host: QueryOptionsHost,
  defName: string,
  includeStatements: IncludeMap[],
  order: SequelizeOrder[],
  options: AdapterQueryOptions,
  parentRelsForOrder: SequelizeOrderPrefix[] = [],
  runHook?: RunHook,
): Promise<{ include: SequelizeInclude[]; order: SequelizeOrder[] }> {
  let orders = order;
  const incs: SequelizeInclude[] = await waterfall(
    includeStatements,
    (i: IncludeMap, o: SequelizeInclude[]) => waterfall(
      Object.keys(i),
      async (relName: string, oo: SequelizeInclude[]) => {
        const inc = i[relName];
        const rel = host.getAssociation(defName, relName);
        const TargetModel = modelOf(host, rel.target);
        const targetDefName = TargetModel.definition.name as string;
        // The target's own operators *plus* the ones its computed filters imply —
        // a `where` declared by an exposed method has to expand at include depth
        // exactly as it does at the root.
        const whereOperators = whereOperatorsFor(TargetModel.definition);
        const orderAssocPrefix = { model: TargetModel, as: relName };
        // A `separate` include runs as its own batched root query, so its
        // ordering/limit/offset live on the include entry itself rather than
        // being hoisted onto the parent query's order. A `required` include
        // must stay an INNER JOIN (it filters the parent rows), which a
        // separate query cannot do — so `required` always wins over separate.
        const separate = Boolean(inc.separate) && !inc.required && rel.associationType === "hasMany";
        if (!separate && (inc.orderBy || []).length > 0) {
          orders = [
            ...orders,
            ...(inc.orderBy || []).map((ob: OrderEntry) => [...parentRelsForOrder, orderAssocPrefix, ...ob]),
          ];
        }
        const retVal = {
          model: TargetModel,
          required: inc.required,
          as: relName,
          where: await host.processFilterArgument(inc.where || {}, whereOperators, options),
        } as SequelizeInclude;
        if (separate) {
          retVal.separate = true;
          if ((inc.orderBy || []).length > 0) {
            retVal.order = inc.orderBy;
          }
          if (inc.limit != null) {
            retVal.limit = inc.limit;
          }
          if (inc.offset != null) {
            retVal.offset = inc.offset;
          }
          // propagate the GraphQL args accessor so the child model's native
          // find hooks (fired by the separate query) can read rootValue/args.
          if (options && options.getGraphQLArgs) {
            retVal.getGraphQLArgs = options.getGraphQLArgs;
          }
        } else if (runHook) {
          // JOIN-loaded relation: Sequelize does not fire the child model's
          // beforeFind for a JOIN include, so fire it manually with only this
          // relation's `where` and merge any change back into the include's
          // where (keeping the filter part of the single combined query).
          const hookOptions: AdapterQueryOptions = { where: retVal.where, getGraphQLArgs: options?.getGraphQLArgs };
          const res = await runHook(targetDefName, "beforeFind", hookOptions);
          if (res && res.where !== undefined) {
            retVal.where = res.where;
          }
        }
        if (inc.include) {
          const v = await processIncludeStatement(
            host,
            targetDefName,
            inc.include,
            order,
            options,
            separate ? [] : [...parentRelsForOrder, orderAssocPrefix],
            runHook,
          );
          retVal.include = v.include;
          if (!separate) {
            orders = [...orders, ...(v.order || [])];
          }
        }
        return [...oo, retVal];
      },
      o,
    ),
    [],
  );
  return { include: incs, order: orders };
}

/** Turn one list request into the options for the fetch and, if needed, the count. */
export async function processListArgsToOptions(
  host: QueryOptionsHost,
  defName: string,
  request: AdapterListRequest,
): Promise<AdapterListOptions> {
  const {
    offset,
    whereOperators,
    options: defaultOptions = {},
    selectedFields,
    runHook,
  } = request as AdapterListRequest & { runHook?: RunHook };
  const args = (request.args || {}) as ListArgs;

  // Clone rather than alias: `selectedAttributes` mutates in place (unshift), so
  // aliasing a caller-provided `defaultOptions.attributes` would accumulate
  // entries across calls.
  let attributes = selectedAttributes(host, defName, selectedFields, [...(defaultOptions.attributes || [])]);
  if (host.hasInlineCountFeature()) {
    attributes = withInlineCount(host, attributes);
  }

  // Always bound the page size — an absent first/last must not mean "no limit".
  const limit = clampPageSize(args.first != null ? args.first : args.last);
  const where = args.where
    ? await host.processFilterArgument(args.where, whereOperators, defaultOptions)
    : undefined;

  let order: SequelizeOrder[] = args.orderBy || [];
  let include: SequelizeInclude[] = [];
  if ((args.include || []).length > 0) {
    const result = await processIncludeStatement(
      host, defName, args.include as IncludeMap[], order, defaultOptions, [], runHook,
    );
    order = result.order;
    include = result.include;
  }

  // `defaultOptions` first: everything after it is computed for *this* request
  // and must win. `attributes` in particular is the permission-filtered column
  // list (plus the inline-count expression), so a caller-supplied one silently
  // overriding it would widen the query and drop the count.
  return {
    getOptions: Object.assign({}, defaultOptions, {
      order,
      where,
      limit,
      offset,
      include,
      attributes: unique(attributes),
    }),
    countOptions: !host.hasInlineCountFeature()
      ? Object.assign({}, defaultOptions, { where, attributes, include })
      : undefined,
  };
}
