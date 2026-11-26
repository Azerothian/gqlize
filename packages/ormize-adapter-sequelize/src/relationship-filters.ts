// Relationship quantifier compilation for the Sequelize adapter.
//
// Compiles `PortableWhere` quantifiers (`some`, `none`, `every`, `is`, `isNot`)
// into correlated `EXISTS` / `NOT EXISTS` subqueries. Called from
// `processFilterArgument` when the where-clause contains keys that match
// relationship names on the model.
//
// Every subquery level gets a unique alias (`_q0`, `_q1`, ...) so that
// self-referential models (e.g. Category.children.children) don't produce
// ambiguous column references. Identifiers are quoted through the dialect's
// query generator; values bound through `whereItemsQuery`. Nothing is
// string-interpolated raw.
//
// `belongsToMany` goes through the join table. A registered join model
// (`Association.throughModel`) gets its own read scope applied inside the
// subquery, matching `engine/through-reads.ts`. The engine embeds the join
// model's scope as a `PortableWhere` under the `__throughScope` key alongside
// the quantifier key (e.g. `{some: {...inner}, __throughScope: {...}}`).

import { Op, Sequelize as SequelizeClass } from "sequelize";
import type { Sequelize } from "sequelize";
import {
  parseQuantifier, MANY_QUANTIFIERS, SINGLE_QUANTIFIERS, LOGICAL_OPERATORS,
  ScopeConfigurationError,
} from "@azerothian/utilize/gate";
import type { PortableWhere } from "@azerothian/utilize/gate";
import type { Association, AdapterWhere, AdapterQueryOptions } from "@azerothian/utilize/types/index";
import { replaceWhereOperators, normalizeWhereForDialect } from "./utils/where-ops";

/** What the compiler needs from the adapter to build subqueries. */
export interface RelationshipFilterHost {
  sequelize: Sequelize;
  getAssociations(modelName: string): { [relName: string]: Association };
}

type QG = { quoteIdentifier(id: string): string; quoteTable(table: string | object): string };

/** Thread-safe alias counter, scoped per top-level compilation. */
class AliasCounter {
  private n = 0;
  next(qg: QG): string { return qg.quoteIdentifier(`_q${this.n++}`); }
}

/**
 * Walk a `PortableWhere` and compile any relationship quantifier into a
 * Sequelize-native where clause containing `Sequelize.literal()` subqueries.
 *
 * `parentRef` is how the enclosing table is referenced in SQL, and is only
 * known inside a subquery this compiler wrote (the alias it gave that level's
 * FROM). At the outermost level it is undefined on purpose: the alias of the
 * table this `where` lands on is Sequelize's choice and differs by path (the
 * model name on a root read, the association name, `notes` or `doc`, on an
 * eager-loaded include). So an outermost quantifier compiles to
 * `pk IN (SELECT _qN.pk FROM table AS _qN WHERE <quantifier on _qN>)`, keyed
 * on the primary key as a normal attribute, and Sequelize writes the outer
 * column reference with whatever alias it is using.
 */
export async function compileRelationshipFilters(
  host: RelationshipFilterHost,
  modelName: string,
  where: PortableWhere,
  options: AdapterQueryOptions,
  parentRef?: string,
  counter?: AliasCounter,
): Promise<AdapterWhere> {
  const associations = host.getAssociations(modelName);
  const sequelize = host.sequelize;
  const qg = sequelize.getQueryInterface().queryGenerator as QG;
  const ctx = counter || new AliasCounter();

  const clauses: AdapterWhere[] = [];
  const fieldWhere: { [key: string]: unknown } = {};

  for (const key of Object.keys(where)) {
    const lower = key.toLowerCase();
    if (LOGICAL_OPERATORS.has(lower)) {
      const branch = where[key];
      if (lower === "not") {
        const compiled = await compileRelationshipFilters(
          host, modelName, branch as PortableWhere, options, parentRef, ctx,
        );
        clauses.push({ [Op.not]: compiled });
      } else {
        const opSymbol = lower === "and" ? Op.and : Op.or;
        const branches = Array.isArray(branch) ? branch : [branch];
        const compiledBranches = await Promise.all(
          branches.map((b) => compileRelationshipFilters(
            host, modelName, b as PortableWhere, options, parentRef, ctx,
          )),
        );
        clauses.push({ [opSymbol]: compiledBranches });
      }
      continue;
    }

    const quantifier = parseQuantifier(where[key]);
    const association = associations[key];
    if (quantifier && association) {
      if (parentRef) {
        const sql = await compileQuantifier(
          host, association, quantifier.quantifier, quantifier.inner,
          quantifier.throughScope, parentRef, qg, sequelize, options, ctx,
        );
        clauses.push(SequelizeClass.literal(sql));
      } else {
        clauses.push(await compileOutermost(
          host, modelName, association, quantifier.quantifier, quantifier.inner,
          quantifier.throughScope, qg, sequelize, options, ctx,
        ));
      }
      continue;
    }

    fieldWhere[key] = where[key];
  }

  if (Object.keys(fieldWhere).length > 0) {
    clauses.push(replaceWhereOperators(fieldWhere));
  }

  if (clauses.length === 0) {
    return {};
  }
  if (clauses.length === 1) {
    return clauses[0];
  }
  return { [Op.and]: clauses };
}

/**
 * An outermost quantifier, as `pk IN (SELECT pk FROM table AS alias WHERE ...)`.
 * See {@link compileRelationshipFilters} for why the outer alias is never
 * written by hand.
 */
async function compileOutermost(
  host: RelationshipFilterHost,
  modelName: string,
  association: Association,
  quantifier: string,
  innerFilter: PortableWhere,
  throughScope: PortableWhere | false | undefined,
  qg: QG,
  sequelize: Sequelize,
  options: AdapterQueryOptions,
  ctx: AliasCounter,
): Promise<AdapterWhere> {
  const model = sequelize.models[modelName];
  const pkAttribute = model?.primaryKeyAttributes?.length === 1 ? model.primaryKeyAttributes[0] : undefined;
  if (!model || !pkAttribute) {
    throw new ScopeConfigurationError(
      `Relationship quantifier on '${modelName}' needs a single-column primary key to correlate on.`,
    );
  }
  const pkColumn = qg.quoteIdentifier(model.getAttributes()[pkAttribute]?.field ?? pkAttribute);
  const alias = ctx.next(qg);
  const sql = await compileQuantifier(
    host, association, quantifier, innerFilter, throughScope, alias, qg, sequelize, options, ctx,
  );
  const table = qg.quoteTable(model.getTableName());
  return { [pkAttribute]: { [Op.in]: SequelizeClass.literal(`(SELECT ${alias}.${pkColumn} FROM ${table} AS ${alias} WHERE ${sql})`) } };
}

/**
 * Compile one quantifier into a SQL string.
 *
 * - `some`   -> `EXISTS (SELECT 1 FROM t AS _qN WHERE ...)`
 * - `none`   -> `NOT EXISTS (...)`
 * - `every`  -> with empty inner: vacuously true (literal `1=1`)
 *               with inner: `NOT EXISTS (... AND NOT COALESCE((inner), FALSE))`
 *               A related row whose inner predicate is NULL (a NULL in a
 *               compared column) has not matched, so it counts as a violation.
 *               `some` treats that row as no match too; `every` must agree, or
 *               a NULL would widen a scope that `some` would have narrowed.
 * - `is`     -> `EXISTS (...)` (singular relationship)
 * - `isNot`  -> `NOT EXISTS (...)`
 */
async function compileQuantifier(
  host: RelationshipFilterHost,
  association: Association,
  quantifier: string,
  innerFilter: PortableWhere,
  throughScope: PortableWhere | false | undefined,
  parentRef: string,
  qg: QG,
  sequelize: Sequelize,
  options: AdapterQueryOptions,
  counter?: AliasCounter,
): Promise<string> {
  const ctx = counter || new AliasCounter();
  const isBtm = association.associationType === "belongsToMany";
  const isBelongsTo = association.associationType === "belongsTo";
  const isHasOne = association.associationType === "hasOne";
  const isHasMany = association.associationType === "hasMany";

  if ((isHasMany || isBtm) && !MANY_QUANTIFIERS.has(quantifier)) {
    throw new ScopeConfigurationError(
      `Quantifier '${quantifier}' is not valid for ${association.associationType} relationship '${association.name}'.` +
      ` Use one of: some, none, every.`,
    );
  }
  if ((isBelongsTo || isHasOne) && !SINGLE_QUANTIFIERS.has(quantifier)) {
    throw new ScopeConfigurationError(
      `Quantifier '${quantifier}' is not valid for ${association.associationType} relationship '${association.name}'.` +
      ` Use one of: is, isNot.`,
    );
  }

  if (isBtm) {
    return compileBtmQuantifier(
      host, association, quantifier, innerFilter, throughScope,
      parentRef, qg, sequelize, options, ctx,
    );
  }

  // hasMany, hasOne, belongsTo: direct relationship through FK.
  const targetModel = sequelize.models[association.target];
  if (!targetModel) {
    throw new ScopeConfigurationError(
      `Relationship quantifier references model '${association.target}' which is not registered with Sequelize.`,
    );
  }
  const targetTable = qg.quoteTable(targetModel.getTableName());
  const alias = ctx.next(qg);

  let parentCol: string;
  let targetCol: string;
  if (isBelongsTo) {
    parentCol = qg.quoteIdentifier(association.foreignKey);
    targetCol = qg.quoteIdentifier(association.targetKey);
  } else {
    parentCol = qg.quoteIdentifier(association.sourceKey);
    targetCol = qg.quoteIdentifier(association.foreignKey);
  }

  const isEmpty = Object.keys(innerFilter).length === 0;
  const isEvery = quantifier === "every";

  // `every: {}` is vacuously true — every row matches the empty predicate.
  if (isEvery && isEmpty) {
    return "1=1";
  }

  // Compile the inner filter using the alias as the prefix.
  const innerSql = await compileInnerWhere(
    host, association.target, innerFilter, alias, qg, sequelize, options, ctx,
  );

  const negate = quantifier === "none" || quantifier === "isNot" || isEvery;

  let subquery = `SELECT 1 FROM ${targetTable} AS ${alias} WHERE ${alias}.${targetCol} = ${parentRef}.${parentCol}`;
  if (innerSql) {
    if (isEvery) {
      // every = NOT EXISTS(related row WHERE correlation AND NOT inner)
      // A NULL inner (a NULL in a compared column) is "did not match", the
      // same answer `some` gives, so it counts as a violation. TRUE here would
      // let a row with a NULL satisfy `every` and widen the scope.
      subquery += ` AND NOT COALESCE((${innerSql}), FALSE)`;
    } else {
      subquery += ` AND ${innerSql}`;
    }
  }

  return negate ? `NOT EXISTS (${subquery})` : `EXISTS (${subquery})`;
}

/**
 * Compile a belongsToMany quantifier through the join table.
 *
 * Through-scopes (read scope of a registered join model) arrive as a
 * `PortableWhere` under the `throughScope` parameter, embedded by the engine
 * before the where reached the adapter. The adapter normalises it for the
 * dialect and converts it to SQL here.
 */
async function compileBtmQuantifier(
  host: RelationshipFilterHost,
  association: Association,
  quantifier: string,
  innerFilter: PortableWhere,
  throughScope: PortableWhere | false | undefined,
  parentRef: string,
  qg: QG,
  sequelize: Sequelize,
  options: AdapterQueryOptions,
  counter?: AliasCounter,
): Promise<string> {
  const ctx = counter || new AliasCounter();
  const joinModelName = association.through as string;
  const joinModel = sequelize.models[joinModelName];
  if (!joinModel) {
    throw new ScopeConfigurationError(
      `Relationship quantifier references join model '${joinModelName}' which is not registered with Sequelize.`,
    );
  }
  const joinTable = qg.quoteTable(joinModel.getTableName());
  const joinAlias = ctx.next(qg);

  const targetModel = sequelize.models[association.target];
  if (!targetModel) {
    throw new ScopeConfigurationError(
      `Relationship quantifier references model '${association.target}' which is not registered with Sequelize.`,
    );
  }
  const targetTable = qg.quoteTable(targetModel.getTableName());
  const targetAlias = ctx.next(qg);

  const sourceKey = qg.quoteIdentifier(association.sourceKey);
  const foreignKey = qg.quoteIdentifier(association.foreignKey);
  const otherKey = qg.quoteIdentifier(association.otherKey as string);
  const targetKey = qg.quoteIdentifier(association.targetKey);

  const isEmpty = Object.keys(innerFilter).length === 0;
  const isEvery = quantifier === "every";

  // `every: {}` on btm is vacuously true.
  if (isEvery && isEmpty) {
    return "1=1";
  }

  // Compile the inner filter against the target's alias.
  const innerSql = await compileInnerWhere(
    host, association.target, innerFilter, targetAlias, qg, sequelize, options, ctx,
  );

  let targetExists: string;
  if (innerSql !== undefined) {
    if (isEvery) {
      targetExists = `EXISTS (SELECT 1 FROM ${targetTable} AS ${targetAlias} WHERE ${targetAlias}.${targetKey} = ${joinAlias}.${otherKey} AND NOT COALESCE((${innerSql}), FALSE))`;
    } else {
      targetExists = `EXISTS (SELECT 1 FROM ${targetTable} AS ${targetAlias} WHERE ${targetAlias}.${targetKey} = ${joinAlias}.${otherKey} AND ${innerSql})`;
    }
  } else {
    targetExists = `EXISTS (SELECT 1 FROM ${targetTable} AS ${targetAlias} WHERE ${targetAlias}.${targetKey} = ${joinAlias}.${otherKey})`;
  }

  // Apply join model's read scope (embedded by the engine as a PortableWhere).
  // The through-scope may itself contain quantifiers on the join model's
  // relationships, so it goes through the full compilation pipeline.
  let joinScopeClause = "";
  if (throughScope === false) {
    // The join model's scope denies outright: no link qualifies.
    joinScopeClause = " AND 1=0";
  } else if (throughScope && Object.keys(throughScope).length > 0) {
    const normalizedThrough = normalizeWhereForDialect(throughScope, sequelize.getDialect());
    const joinAssociations = host.getAssociations(joinModelName);
    const hasNestedQuantifiers = Object.keys(normalizedThrough).some((k) => {
      return parseQuantifier(normalizedThrough[k]) !== undefined && joinAssociations[k] !== undefined;
    });
    let throughSql: string | undefined;
    if (hasNestedQuantifiers) {
      const compiled = await compileRelationshipFilters(
        host, joinModelName, normalizedThrough, options, joinAlias, ctx,
      );
      throughSql = whereToSql(compiled, joinModelName, joinAlias, qg, sequelize);
    } else {
      const nativeThrough = replaceWhereOperators(normalizedThrough);
      throughSql = whereToSql(nativeThrough, joinModelName, joinAlias, qg, sequelize);
    }
    if (throughSql) {
      joinScopeClause = ` AND ${throughSql}`;
    }
  }

  const negate = quantifier === "none" || isEvery;

  let subquery = `SELECT 1 FROM ${joinTable} AS ${joinAlias} WHERE ${joinAlias}.${foreignKey} = ${parentRef}.${sourceKey}`;
  subquery += ` AND ${targetExists}`;
  subquery += joinScopeClause;

  return negate ? `NOT EXISTS (${subquery})` : `EXISTS (${subquery})`;
}

/**
 * Compile an inner `PortableWhere` to a SQL fragment for use inside a subquery.
 *
 * `alias` is the quoted alias of the FROM table in the enclosing subquery.
 * It is passed as `prefix` to `whereItemsQuery` so column references resolve
 * to that alias, and it becomes the `parentRef` for any nested quantifiers.
 */
async function compileInnerWhere(
  host: RelationshipFilterHost,
  modelName: string,
  innerFilter: PortableWhere,
  alias: string,
  qg: QG,
  sequelize: Sequelize,
  options: AdapterQueryOptions,
  counter?: AliasCounter,
): Promise<string | undefined> {
  if (Object.keys(innerFilter).length === 0) {
    return undefined;
  }

  const ctx = counter || new AliasCounter();
  const associations = host.getAssociations(modelName);
  const hasQuantifiers = Object.keys(innerFilter).some((k) => {
    return parseQuantifier(innerFilter[k]) !== undefined && associations[k] !== undefined;
  });

  if (hasQuantifiers) {
    const compiled = await compileRelationshipFilters(
      host, modelName, innerFilter, options, alias, ctx,
    );
    return whereToSql(compiled, modelName, alias, qg, sequelize);
  }

  // Dialect normalisation for inner wheres (e.g. iLike -> like on SQLite).
  const normalized = normalizeWhereForDialect(innerFilter, sequelize.getDialect());
  const nativeWhere = replaceWhereOperators(normalized);
  return whereToSql(nativeWhere, modelName, alias, qg, sequelize);
}

/**
 * Convert a Sequelize where clause to a SQL fragment, using the dialect's
 * query generator. The `alias` is used as the table prefix so column references
 * resolve to the right subquery level.
 */
function whereToSql(
  where: AdapterWhere,
  modelName: string,
  alias: string,
  qg: QG,
  sequelize: Sequelize,
): string | undefined {
  if (!where || (typeof where === "object" && Object.keys(where).length === 0)) {
    return undefined;
  }
  const model = sequelize.models[modelName];
  const generator = sequelize.getQueryInterface().queryGenerator as {
    whereItemsQuery(where: unknown, options?: { model?: unknown; prefix?: string | object }): string;
  };
  // Use the alias (not the table name) as the prefix. The alias is what the
  // FROM clause names, so column references must match it.
  const fragment = generator.whereItemsQuery(where, {
    model,
    prefix: alias,
  });
  return fragment || undefined;
}
