// Relationship quantifier compilation for the Sequelize adapter.
//
// Compiles `PortableWhere` quantifiers (`some`, `none`, `every`, `is`, `isNot`)
// into correlated `EXISTS` / `NOT EXISTS` subqueries. Called from
// `processFilterArgument` when the where-clause contains keys that match
// relationship names on the model.
//
// Identifiers are quoted through the dialect's query generator; values are
// escaped through `sequelize.escape()`. Nothing is string-interpolated raw.
//
// `belongsToMany` goes through the join table. A registered join model
// (`Association.throughModel`) gets its own read scope applied inside the
// subquery, matching `engine/through-reads.ts`.

import { Op, Sequelize as SequelizeClass } from "sequelize";
import type { Sequelize } from "sequelize";
import {
  parseQuantifier, MANY_QUANTIFIERS, SINGLE_QUANTIFIERS, LOGICAL_OPERATORS,
  ScopeConfigurationError,
} from "@azerothian/utilize/gate";
import type { PortableWhere } from "@azerothian/utilize/gate";
import type { Association, AdapterWhere, AdapterQueryOptions, WhereOperators } from "@azerothian/utilize/types/index";
import { replaceWhereOperators } from "./utils/where-ops";

/** What the compiler needs from the adapter to build subqueries. */
export interface RelationshipFilterHost {
  sequelize: Sequelize;
  getAssociations(modelName: string): { [relName: string]: Association };
  processFilterArgument(
    where: AdapterWhere | undefined,
    whereOperators: WhereOperators | undefined,
    options: AdapterQueryOptions,
  ): Promise<AdapterWhere>;
}

type QG = { quoteIdentifier(id: string): string; quoteTable(table: string | object): string };

/**
 * Walk a `PortableWhere` and compile any relationship quantifier into a
 * Sequelize-native where clause containing `Sequelize.literal()` subqueries.
 *
 * Returns the rewritten where, with quantifier keys replaced by literal SQL
 * and non-quantifier keys left for the normal `replaceWhereOperators` path.
 *
 * `parentRef` is how the outer query's table is referenced in SQL: for the
 * outermost level it is the model name (Sequelize's alias), for inner
 * subquery levels it is the table name.
 */
export async function compileRelationshipFilters(
  host: RelationshipFilterHost,
  modelName: string,
  where: PortableWhere,
  options: AdapterQueryOptions,
  scopeForThrough?: (joinModel: string) => Promise<AdapterWhere | undefined>,
  parentRef?: string,
): Promise<AdapterWhere> {
  const associations = host.getAssociations(modelName);
  const sequelize = host.sequelize;
  const qg = sequelize.getQueryInterface().queryGenerator as QG;

  // For the outermost level, Sequelize aliases the table as the model name.
  // For inner levels, the caller passes the actual table reference.
  const pRef = parentRef || qg.quoteIdentifier(modelName);

  const clauses: AdapterWhere[] = [];
  const fieldWhere: { [key: string]: unknown } = {};

  for (const key of Object.keys(where)) {
    const lower = key.toLowerCase();
    if (LOGICAL_OPERATORS.has(lower)) {
      const branch = where[key];
      if (lower === "not") {
        const compiled = await compileRelationshipFilters(
          host, modelName, branch as PortableWhere, options, scopeForThrough, pRef,
        );
        clauses.push({ [Op.not]: compiled });
      } else {
        const opSymbol = lower === "and" ? Op.and : Op.or;
        const branches = Array.isArray(branch) ? branch : [branch];
        const compiledBranches = await Promise.all(
          branches.map((b) => compileRelationshipFilters(
            host, modelName, b as PortableWhere, options, scopeForThrough, pRef,
          )),
        );
        clauses.push({ [opSymbol]: compiledBranches });
      }
      continue;
    }

    const quantifier = parseQuantifier(where[key]);
    const association = associations[key];
    if (quantifier && association) {
      const sql = await compileQuantifier(
        host, association, quantifier.quantifier, quantifier.inner,
        pRef, qg, sequelize, options, scopeForThrough,
      );
      clauses.push(SequelizeClass.literal(sql));
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
 * Compile one quantifier into a SQL string.
 *
 * - `some` -> `EXISTS`
 * - `none` -> `NOT EXISTS`
 * - `every` -> `NOT EXISTS (... AND NOT (inner))`
 * - `is` -> `EXISTS` (singular relationship)
 * - `isNot` -> `NOT EXISTS`
 */
async function compileQuantifier(
  host: RelationshipFilterHost,
  association: Association,
  quantifier: string,
  innerFilter: PortableWhere,
  parentRef: string,
  qg: QG,
  sequelize: Sequelize,
  options: AdapterQueryOptions,
  scopeForThrough?: (joinModel: string) => Promise<AdapterWhere | undefined>,
): Promise<string> {
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
      host, association, quantifier, innerFilter,
      parentRef, qg, sequelize, options, scopeForThrough,
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

  let parentCol: string;
  let targetCol: string;
  if (isBelongsTo) {
    parentCol = qg.quoteIdentifier(association.foreignKey);
    targetCol = qg.quoteIdentifier(association.targetKey);
  } else {
    parentCol = qg.quoteIdentifier(association.sourceKey);
    targetCol = qg.quoteIdentifier(association.foreignKey);
  }

  // Compile the inner filter. For nested quantifiers, the target table name
  // becomes the parent reference of the inner level.
  const innerSql = await compileInnerWhere(
    host, association.target, innerFilter, targetTable, qg, sequelize, options, scopeForThrough,
  );

  const negate = quantifier === "none" || quantifier === "isNot" || quantifier === "every";
  const innerNegate = quantifier === "every";

  let subquery = `SELECT 1 FROM ${targetTable} WHERE ${targetTable}.${targetCol} = ${parentRef}.${parentCol}`;
  if (innerSql) {
    subquery += innerNegate ? ` AND NOT (${innerSql})` : ` AND ${innerSql}`;
  }

  return negate ? `NOT EXISTS (${subquery})` : `EXISTS (${subquery})`;
}

/**
 * Compile a belongsToMany quantifier through the join table.
 */
async function compileBtmQuantifier(
  host: RelationshipFilterHost,
  association: Association,
  quantifier: string,
  innerFilter: PortableWhere,
  parentRef: string,
  qg: QG,
  sequelize: Sequelize,
  options: AdapterQueryOptions,
  scopeForThrough?: (joinModel: string) => Promise<AdapterWhere | undefined>,
): Promise<string> {
  const joinModelName = association.through as string;
  const joinModel = sequelize.models[joinModelName];
  if (!joinModel) {
    throw new ScopeConfigurationError(
      `Relationship quantifier references join model '${joinModelName}' which is not registered with Sequelize.`,
    );
  }
  const joinTable = qg.quoteTable(joinModel.getTableName());

  const targetModel = sequelize.models[association.target];
  if (!targetModel) {
    throw new ScopeConfigurationError(
      `Relationship quantifier references model '${association.target}' which is not registered with Sequelize.`,
    );
  }
  const targetTable = qg.quoteTable(targetModel.getTableName());

  const sourceKey = qg.quoteIdentifier(association.sourceKey);
  const foreignKey = qg.quoteIdentifier(association.foreignKey);
  const otherKey = qg.quoteIdentifier(association.otherKey as string);
  const targetKey = qg.quoteIdentifier(association.targetKey);

  const innerSql = await compileInnerWhere(
    host, association.target, innerFilter, targetTable, qg, sequelize, options, scopeForThrough,
  );

  let targetExists: string;
  if (innerSql !== undefined) {
    const innerNegate = quantifier === "every";
    const targetWhere = innerNegate
      ? `AND NOT (${innerSql})`
      : `AND ${innerSql}`;
    targetExists = `EXISTS (SELECT 1 FROM ${targetTable} WHERE ${targetTable}.${targetKey} = ${joinTable}.${otherKey} ${targetWhere})`;
  } else {
    targetExists = `EXISTS (SELECT 1 FROM ${targetTable} WHERE ${targetTable}.${targetKey} = ${joinTable}.${otherKey})`;
  }

  let joinScopeClause = "";
  if (association.throughModel && scopeForThrough) {
    const throughScope = await scopeForThrough(joinModelName);
    if (throughScope && Object.keys(throughScope).length > 0) {
      const throughSql = whereToSql(throughScope, joinModelName, qg, sequelize);
      if (throughSql) {
        joinScopeClause = ` AND ${throughSql}`;
      }
    }
  }

  const negate = quantifier === "none" || quantifier === "every";

  let subquery = `SELECT 1 FROM ${joinTable} WHERE ${joinTable}.${foreignKey} = ${parentRef}.${sourceKey}`;
  subquery += ` AND ${targetExists}`;
  subquery += joinScopeClause;

  return negate ? `NOT EXISTS (${subquery})` : `EXISTS (${subquery})`;
}

/**
 * Compile an inner `PortableWhere` to a SQL fragment for use inside a subquery.
 *
 * `targetTableRef` is the quoted table name that will be the FROM in the
 * enclosing subquery -- it becomes the parent reference for any nested
 * quantifiers.
 */
async function compileInnerWhere(
  host: RelationshipFilterHost,
  modelName: string,
  innerFilter: PortableWhere,
  targetTableRef: string,
  qg: QG,
  sequelize: Sequelize,
  options: AdapterQueryOptions,
  scopeForThrough?: (joinModel: string) => Promise<AdapterWhere | undefined>,
): Promise<string | undefined> {
  if (Object.keys(innerFilter).length === 0) {
    return undefined;
  }

  const associations = host.getAssociations(modelName);
  const hasQuantifiers = Object.keys(innerFilter).some((k) => {
    return parseQuantifier(innerFilter[k]) !== undefined && associations[k] !== undefined;
  });

  if (hasQuantifiers) {
    // Compile with the target table as the parent reference for inner levels.
    const compiled = await compileRelationshipFilters(
      host, modelName, innerFilter, options, scopeForThrough, targetTableRef,
    );
    return whereToSql(compiled, modelName, qg, sequelize);
  }

  const nativeWhere = replaceWhereOperators(innerFilter);
  return whereToSql(nativeWhere, modelName, qg, sequelize);
}

/**
 * Convert a Sequelize where clause to a SQL fragment using the query generator.
 */
function whereToSql(
  where: AdapterWhere,
  modelName: string,
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
  const tableName = model?.getTableName?.();
  const fragment = generator.whereItemsQuery(where, {
    model,
    prefix: tableName,
  });
  return fragment || undefined;
}
