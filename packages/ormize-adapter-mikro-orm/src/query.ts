// Portable `where`/`orderBy`/`include` -> MikroORM's own query shapes.
//
// Much smaller than the SQL adapter's equivalent: MikroORM's operators are plain
// string keys (`$eq`, `$in`, `$like`), so this is a rename rather than the
// `Op`-symbol reflection Sequelize needs. What it does carry is the field alias
// table — a synthesized foreign key like `authorId` has to become the relation
// property `author` before MikroORM sees it (see `DiscoveredEntity.aliases`).

import type {
  AdapterWhere, IncludeMap, OrderEntry, WhereOperators,
} from "@azerothian/utilize/types/index";
import type { MikroModel } from "./model";
import type { MikroQueryOptions } from "./types/index";

/**
 * Portable operator -> MikroORM operator.
 *
 * The portable vocabulary is `@azerothian/graphql-types/operators`; anything
 * absent from this table is handled by {@link translateOperator} because it
 * needs more than a rename.
 */
const DIRECT: { [portable: string]: string } = {
  eq: "$eq",
  ne: "$ne",
  gt: "$gt",
  gte: "$gte",
  lt: "$lt",
  lte: "$lte",
  in: "$in",
  notIn: "$nin",
  like: "$like",
  iLike: "$ilike",
  regexp: "$re",
  overlap: "$overlap",
  contains: "$contains",
  contained: "$contained",
};

/** The two boolean combinators, which take a list of whole `where` objects. */
const COMBINATORS: { [portable: string]: string } = { and: "$and", or: "$or" };

/** `%` and `_` are LIKE metacharacters; a literal prefix/suffix must not carry them. */
function escapeLike(value: unknown): string {
  return String(value).replace(/([%_\\])/g, "\\$1");
}

/**
 * One `{operator: value}` pair, as MikroORM spells it.
 *
 * The cases that are not a rename: `not`/`notLike`/`notILike`/`notBetween` wrap
 * in `$not`, the three affix operators build a `LIKE` pattern, `between` is a
 * pair of bounds, and `is` is a null test — `{is: null}` must become `$eq: null`
 * rather than a literal comparison against the string "null".
 */
function translateOperator(operator: string, value: unknown): object | undefined {
  const direct = DIRECT[operator];
  if (direct) {
    return { [direct]: value };
  }
  switch (operator) {
    case "is":
      return { $eq: value ?? null };
    case "not":
      return { $not: value };
    case "notLike":
      return { $not: { $like: value } };
    case "notILike":
      return { $not: { $ilike: value } };
    case "notRegexp":
      return { $not: { $re: value } };
    case "startsWith":
      return { $like: `${escapeLike(value)}%` };
    case "endsWith":
      return { $like: `%${escapeLike(value)}` };
    case "substring":
      return { $like: `%${escapeLike(value)}%` };
    case "between":
      return Array.isArray(value) ? { $gte: value[0], $lte: value[1] } : undefined;
    case "notBetween":
      return Array.isArray(value) ? { $not: { $gte: (value as unknown[])[0], $lte: (value as unknown[])[1] } } : undefined;
    default:
      return undefined;
  }
}

/** Whether every key of an object is a known operator, i.e. it is a condition rather than a value. */
function isConditionObject(value: unknown): value is { [operator: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => DIRECT[k] !== undefined || translateOperator(k, null) !== undefined
    || k === "between" || k === "notBetween");
}

/**
 * Apply an author's custom `whereOperators` to one field's condition.
 *
 * Each entry is a function the definition supplied: it is handed the value the
 * client sent and returns a MikroORM condition to use in its place. This is the
 * portable equivalent of the SQL adapter's `replaceDefWhereOperators`, and it is
 * why an exposed method with a declared `where` can be filtered on like a column.
 */
function applyCustomOperator(
  operator: string, value: unknown, whereOperators: WhereOperators | undefined,
): object | undefined {
  const fn = whereOperators?.[operator];
  return typeof fn === "function" ? (fn as (v: unknown) => object)(value) : undefined;
}

/**
 * Rewrite one portable `where` tree into a MikroORM `FilterQuery`.
 *
 * With a model in hand, field names are resolved through its alias table on the
 * way, so a synthesized foreign key becomes the relation property that holds it.
 * Without one — `OrmAdapter.processFilterArgument` is handed none — only the
 * operators are rewritten and {@link resolveAliases} finishes the job later.
 */
export function translateWhere(
  model: MikroModel | undefined,
  where: AdapterWhere | undefined,
  whereOperators?: WhereOperators,
): AdapterWhere | undefined {
  if (!where || typeof where !== "object") {
    return undefined;
  }
  const out: { [key: string]: unknown } = {};
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) {
      continue;
    }
    const combinator = COMBINATORS[key];
    if (combinator) {
      const branches = (Array.isArray(value) ? value : [value])
        .map((branch) => translateWhere(model, branch as AdapterWhere, whereOperators))
        .filter((branch): branch is AdapterWhere => branch !== undefined && Object.keys(branch).length > 0);
      if (branches.length) {
        out[combinator] = branches;
      }
      continue;
    }
    if (key === "not") {
      const negated = translateWhere(model, value as AdapterWhere, whereOperators);
      if (negated) {
        out.$not = negated;
      }
      continue;
    }
    // An author-declared operator sits at field level in the portable tree, the
    // same place a column does, so it is tried before the key is taken for one.
    const custom = applyCustomOperator(key, value, whereOperators);
    if (custom) {
      Object.assign(out, custom);
      continue;
    }
    // No model means no alias table — see {@link resolveAliases} for who calls
    // this without one, and where the field names are resolved instead.
    const property = model ? model.resolve(key) : key;
    if (!isConditionObject(value)) {
      out[property] = value;
      continue;
    }
    const condition: { [operator: string]: unknown } = {};
    for (const [operator, operand] of Object.entries(value)) {
      const translated = translateOperator(operator, operand);
      if (translated) {
        Object.assign(condition, translated);
      }
    }
    if (Object.keys(condition).length) {
      out[property] = condition;
    }
  }
  return out;
}

/**
 * Portable `[column, direction]` pairs -> MikroORM's `{property: 'asc'}` map.
 *
 * A list rather than one object: MikroORM honours the key order of a single
 * object, but two entries for the same property would collapse, and an ordering
 * is a sequence.
 */
export function translateOrder(model: MikroModel, order?: OrderEntry[]): { [property: string]: "asc" | "desc" }[] | undefined {
  if (!order || !order.length) {
    return undefined;
  }
  return order.map(([column, direction]) => ({
    [model.resolve(column)]: String(direction).toUpperCase() === "DESC" ? "desc" as const : "asc" as const,
  }));
}

/** An include plan, flattened into what MikroORM's `FindOptions` takes. */
export interface PopulatePlan {
  populate: string[];
  populateWhere?: { [path: string]: unknown };
  populateHints: { [path: string]: { limit?: number; offset?: number; orderBy?: object } };
  /** Relation paths an include marked `required`. See {@link requiredCondition}. */
  required: string[];
}

/**
 * The root condition a `required` include contributes: the relation must have a
 * row, which is what makes the join an inner one.
 *
 * Expressed as part of `where` rather than as a per-path `joinType` hint,
 * because `required` filters the *parent* rows — so it has to reach the count
 * query too, and MikroORM's `CountOptions` takes `where`, `populate` and
 * `populateWhere` but no populate hints. A page whose `total` disagreed with it
 * would page wrongly at every cursor.
 */
export function requiredCondition(required: string[]): AdapterWhere | undefined {
  if (!required.length) {
    return undefined;
  }
  const out: { [key: string]: unknown } = {};
  for (const path of required) {
    setPath(out, path, { $ne: null });
  }
  return out;
}

/**
 * Walk an include tree into dotted populate paths.
 *
 * MikroORM populates by path and once per path, which is why this adapter's
 * include argument is one object keyed by relationship name rather than a list —
 * there is no alias to repeat a join under. Per-node `where` becomes a nested
 * `populateWhere`; per-node ordering and paging become `populateHints`, which is
 * MikroORM's per-parent limiting.
 */
export function buildPopulatePlan(
  model: MikroModel,
  include: IncludeMap | IncludeMap[] | undefined,
  modelFor: (name: string) => MikroModel | undefined,
  prefix = "",
  plan: PopulatePlan = { populate: [], populateHints: {}, required: [] },
): PopulatePlan {
  // An adapter with `includeIsList = false` is handed one include object by the
  // resolver and a one-element list by the engine's own plan, so both arrive.
  for (const level of normaliseInclude(include)) {
    for (const [relName, node] of Object.entries(level)) {
      const relationship = model.relationships.find((r) => (r.options?.as || r.name) === relName);
      if (!relationship) {
        continue;
      }
      const path = prefix ? `${prefix}.${relName}` : relName;
      plan.populate.push(path);
      if (node.required) {
        plan.required.push(path);
      }
      const target = modelFor(node.target || relationship.model);
      if (target && node.where && Object.keys(node.where).length) {
        const translated = translateWhere(target, node.where);
        if (translated && Object.keys(translated).length) {
          plan.populateWhere = plan.populateWhere || {};
          setPath(plan.populateWhere, path, translated);
        }
      }
      const orderBy = target ? translateOrder(target, node.orderBy) : undefined;
      const hint = {
        ...(node.limit != null ? { limit: node.limit } : {}),
        ...(node.offset != null ? { offset: node.offset } : {}),
        ...(orderBy ? { orderBy: Object.assign({}, ...orderBy) } : {}),
      };
      if (Object.keys(hint).length) {
        plan.populateHints[path] = hint;
      }
      if (target && node.include) {
        buildPopulatePlan(target, node.include, modelFor, path, plan);
      }
    }
  }
  return plan;
}

/** Both include shapes as one list — see the note in {@link buildPopulatePlan}. */
export function normaliseInclude(include: IncludeMap | IncludeMap[] | undefined): IncludeMap[] {
  if (!include) {
    return [];
  }
  return Array.isArray(include) ? include : [include];
}

/** Write `value` at a dotted path, creating the intermediate objects. */
function setPath(target: { [key: string]: unknown }, path: string, value: unknown): void {
  const segments = path.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    cursor[segment] = cursor[segment] || {};
    cursor = cursor[segment] as { [key: string]: unknown };
  }
  const last = segments[segments.length - 1];
  cursor[last] = { ...(cursor[last] || {}), ...(value as object) };
}

/**
 * Resolve a condition's field names through a model's alias table, leaving its
 * operators alone.
 *
 * The two halves of the translation are separated because they need different
 * things: an operator rename needs nothing but the tree, while an alias needs
 * the model, and {@link OrmAdapter.processFilterArgument} is handed no model —
 * its signature is `(where, whereOperators, options)`, and every call site the
 * engine makes builds the options bag from a request context that does not name
 * one. So a scope or a cross-adapter join filter arrives here already
 * operator-translated but still spelled with `authorId`, and this is the pass
 * that runs just before the query, where the model is finally known.
 *
 * Idempotent: `resolve()` is the identity for anything that is not an alias, so
 * a condition that already went through {@link translateWhere} is unchanged.
 */
export function resolveAliases(model: MikroModel, where: AdapterWhere | undefined): AdapterWhere | undefined {
  if (!where || typeof where !== "object") {
    return where;
  }
  const out: { [key: string]: unknown } = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === "$and" || key === "$or") {
      out[key] = (value as AdapterWhere[]).map((branch) => resolveAliases(model, branch));
      continue;
    }
    if (key === "$not") {
      out[key] = resolveAliases(model, value as AdapterWhere);
      continue;
    }
    // A `$`-prefixed key is an operator, and operators are not field names.
    out[key.startsWith("$") ? key : model.resolve(key)] = value;
  }
  return out;
}

/** Combine two MikroORM conditions, dropping an empty one rather than nesting it. */
export function andWhere(a: AdapterWhere | undefined, b: AdapterWhere | undefined): AdapterWhere | undefined {
  if (!a || Object.keys(a).length === 0) {
    return b;
  }
  if (!b || Object.keys(b).length === 0) {
    return a;
  }
  return { $and: [a, b] };
}

/** The query bag a read is issued with, minus anything MikroORM would reject. */
export function findOptions(options: MikroQueryOptions): MikroQueryOptions {
  const {
    // Ormize's own keys, which MikroORM knows nothing about.
    transaction: _transaction, whereOperators: _whereOperators, where: _where,
    deleted: _deleted, context: _context, through: _through,
    ...rest
  } = options;
  return rest;
}
