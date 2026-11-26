// Compile a PortableWhere into the SQL text of an RLS policy expression.
//
// Setting references (`rls.setting(…)`) become `(SELECT nullif(current_setting(…), '')::<type>)`.
// Phase 1 quantifiers become correlated EXISTS subqueries with unique aliases.
// Values are escaped through the dialect's literal escape, never raw-interpolated.
// Unsupported operators or cross-adapter quantifiers throw ScopeConfigurationError.

import type { PortableWhere } from "@azerothian/utilize/gate";
import { ScopeConfigurationError, LOGICAL_OPERATORS, parseQuantifier, MANY_QUANTIFIERS, SINGLE_QUANTIFIERS, resolveViaMarkers } from "@azerothian/utilize/gate";
import { isRlsSetting, isRlsSqlFragment } from "@azerothian/utilize/types/definitions";
import type { RlsSetting, RlsSqlFragment } from "@azerothian/utilize/types/definitions";
import type { Association } from "@azerothian/utilize/types/index";

/** What the policy compiler needs from the adapter. */
export interface PolicyCompilerHost {
  getAssociations(modelName: string): { [relName: string]: Association };
  /** Quote an identifier for the dialect. */
  quoteIdentifier(id: string): string;
  /** Quote a table name for the dialect (handles schema-qualified names). */
  quoteTable(table: string | { schema?: string; tableName: string }): string;
  /** Escape a literal value for safe embedding in DDL text. */
  escapeLiteral(value: unknown): string;
  /** Get the actual column name for a field on a model. */
  getColumnName(modelName: string, fieldName: string): string;
  /** Get the table name for a model. */
  getTableName(modelName: string): string | { schema?: string; tableName: string };
  /** Get primary key attribute name. */
  getPrimaryKeyAttribute(modelName: string): string | undefined;
  /**
   * Relationship hops into RLS tables. Without it, every hop is a plain
   * correlated `EXISTS`, which only works while no table it reaches has RLS.
   */
  hops?: HopFunctionRegistry;
}

/**
 * Where the compiler puts a relationship hop that reaches a table with RLS.
 *
 * A policy's subquery is itself subject to the policies of every table it
 * reads. A rule that walks back into its own table (`Membership` visible to
 * the members of its group) or into a table whose policy walks back (`Group`
 * via `memberships`, `Membership` via `group`) is then infinite recursion,
 * which Postgres refuses outright (42P17); and a hop that does terminate
 * quietly answers less than the engine's scope does, because the engine never
 * applies the related model's scope inside a quantifier. So such a hop runs in
 * a generated `SECURITY DEFINER` function, owned by a role that bypasses RLS,
 * returning the key values the hop matches. The policy keeps everything
 * caller-specific: the function reads the request's settings like the policy
 * would.
 */
export interface HopFunctionRegistry {
  /** Whether `modelName`'s table has RLS enabled. */
  isRlsModel(modelName: string): boolean;
  /** The SQL type of a column, for the function's `RETURNS SETOF`. */
  columnType(modelName: string, attribute: string): string;
  /** Register a hop body; returns the schema-qualified, quoted function name. */
  define(body: string, returnType: string): string;
}

/** Alias counter, scoped per top-level compilation. */
class AliasCounter {
  private n = 0;
  /** Inside a hop function's body: already running as its owner. */
  inFunction = false;
  next(): string { return `_rls${this.n++}`; }
}

/**
 * Whether a hop, or any hop nested in its inner filter, reads a table with
 * RLS enabled.
 */
function reachesRls(host: PolicyCompilerHost, association: Association, inner: PortableWhere): boolean {
  const hops = host.hops;
  if (!hops) {
    return false;
  }
  if (hops.isRlsModel(association.target) || (association.through && hops.isRlsModel(association.through))) {
    return true;
  }
  const walk = (model: string, where: PortableWhere): boolean => Object.keys(where).some((key) => {
    const value = where[key];
    if (LOGICAL_OPERATORS.has(key.toLowerCase())) {
      const branches = Array.isArray(value) ? value : [value];
      return branches.some((b) => b && typeof b === "object" && walk(model, b as PortableWhere));
    }
    const q = parseQuantifier(value);
    const assoc = q ? host.getAssociations(model)[key] : undefined;
    return !!(q && assoc && reachesRls(host, assoc, q.inner || {}));
  });
  return walk(association.target, inner);
}

/**
 * The policy side of a hop function: does the parent's key appear in the set
 * the function returns? `COALESCE(…, FALSE)` gives `IN` the answer `EXISTS`
 * would for a NULL parent key, and the body drops NULL keys, so a negated hop
 * (`none`/`isNot`/`every`) is never NULL either. Uncorrelated, so Postgres
 * runs it once per statement as a hashed subplan.
 */
function hopFunctionCall(host: PolicyCompilerHost, body: string, returnType: string, parentColRef: string, negate: boolean): string {
  const fn = (host.hops as HopFunctionRegistry).define(body, returnType);
  const member = `COALESCE(${parentColRef} IN (SELECT * FROM ${fn}()), FALSE)`;
  return negate ? `NOT ${member}` : member;
}

/**
 * Compile an RLS policy expression to SQL text.
 *
 * The `using` / `withCheck` value is either a `PortableWhere` or a `SqlFragment`.
 * A `SqlFragment` is emitted verbatim. A `PortableWhere` is compiled recursively.
 */
export function compilePolicyExpression(
  host: PolicyCompilerHost,
  modelName: string,
  expr: PortableWhere | RlsSqlFragment,
): string {
  if (isRlsSqlFragment(expr)) {
    return expr.text;
  }
  const ctx = new AliasCounter();
  // `via` sugar arrives as a `__via` marker (from `compileRlsPolicies`); each
  // hop's quantifier depends on the association type, known only here.
  const resolved = resolveViaMarkers(expr, modelName, (model, rel) => {
    const assoc = host.getAssociations(model)[rel];
    return assoc ? { associationType: assoc.associationType, target: assoc.target } : undefined;
  }) || {};
  // Top-level columns are qualified with the table's own name. Unqualified,
  // a column inside a correlated subquery binds to the *nearest* table that
  // has it: `"_q0"."userId" = "id"` compared the membership row with itself
  // instead of with the policy's row.
  const table = host.getTableName(modelName);
  const tableRef = host.quoteIdentifier(typeof table === "string" ? table : table.tableName);
  return compileWhere(host, modelName, resolved, tableRef, ctx);
}

/**
 * Compile a setting reference to SQL: `(SELECT nullif(current_setting('name', true), '')::<type>)`
 * For array types: `(SELECT string_to_array(nullif(current_setting('name', true), ''), ',')::<type>)`
 */
export function settingToSql(ref: RlsSetting): string {
  const isArray = ref.type.endsWith("[]");
  if (isArray) {
    return `(SELECT string_to_array(nullif(current_setting('${ref.name}', true), ''), ',')::${ref.type})`;
  }
  return `(SELECT nullif(current_setting('${ref.name}', true), '')::${ref.type})`;
}

/** The portable filter operators we can compile to SQL. */
const OPERATOR_SQL: { [op: string]: string } = {
  eq: "=",
  ne: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

function compileWhere(
  host: PolicyCompilerHost,
  modelName: string,
  where: PortableWhere,
  tableRef: string,
  ctx: AliasCounter,
): string {
  // A SQL fragment standing for a whole branch (`TRUE` for an `allow` rule).
  if (isRlsSqlFragment(where)) {
    return where.text;
  }
  const parts: string[] = [];
  const associations = host.getAssociations(modelName);

  for (const key of Object.keys(where)) {
    const lower = key.toLowerCase();

    // Logical operators
    if (LOGICAL_OPERATORS.has(lower)) {
      const branch = where[key];
      if (lower === "not") {
        const inner = compileWhere(host, modelName, branch as PortableWhere, tableRef, ctx);
        parts.push(`NOT (${inner})`);
      } else if (lower === "and") {
        const branches = Array.isArray(branch) ? branch : [branch];
        const compiled = branches.map((b) => compileWhere(host, modelName, b as PortableWhere, tableRef, ctx));
        parts.push(`(${compiled.join(" AND ")})`);
      } else if (lower === "or") {
        const branches = Array.isArray(branch) ? branch : [branch];
        const compiled = branches.map((b) => compileWhere(host, modelName, b as PortableWhere, tableRef, ctx));
        parts.push(`(${compiled.join(" OR ")})`);
      }
      continue;
    }

    // Quantifiers on relationships
    const quantifier = parseQuantifier(where[key]);
    if (quantifier && associations[key]) {
      const association = associations[key];
      parts.push(compileQuantifier(host, association, quantifier.quantifier, quantifier.inner, tableRef, ctx));
      continue;
    }

    // Field-level comparison
    const colName = host.quoteIdentifier(host.getColumnName(modelName, key));
    const column = tableRef ? `${tableRef}.${colName}` : colName;
    const value = where[key];
    if (value !== null && typeof value === "object" && !isRlsSetting(value)) {
      // Operator object: { eq: ..., ne: ..., in: ..., etc. }
      const ops = value as { [op: string]: unknown };
      for (const op of Object.keys(ops)) {
        const operand = ops[op];
        if (op === "in" || op === "notIn") {
          const inValues = compileValue(host, operand);
          const negation = op === "notIn" ? "NOT " : "";
          if (isRlsSetting(operand)) {
            // eq against an array setting -> = ANY(...)
            parts.push(`${column} ${negation}= ANY(${inValues})`);
          } else if (Array.isArray(operand)) {
            parts.push(`${column} ${negation}IN (${operand.map((v) => compileValue(host, v)).join(", ")})`);
          } else {
            parts.push(`${column} ${negation}= ANY(${inValues})`);
          }
        } else if (op === "eq" && isRlsSetting(operand) && (operand).type.endsWith("[]")) {
          // eq against an array setting -> = ANY(...)
          parts.push(`${column} = ANY(${settingToSql(operand)})`);
        } else if (OPERATOR_SQL[op]) {
          parts.push(`${column} ${OPERATOR_SQL[op]} ${compileValue(host, operand)}`);
        } else if (op === "is") {
          // is null
          parts.push(`${column} IS ${operand === null ? "NULL" : compileValue(host, operand)}`);
        } else if (op === "isNot") {
          parts.push(`${column} IS NOT ${operand === null ? "NULL" : compileValue(host, operand)}`);
        } else if (op === "like") {
          parts.push(`${column} LIKE ${compileValue(host, operand)}`);
        } else if (op === "iLike") {
          parts.push(`${column} ILIKE ${compileValue(host, operand)}`);
        } else if (op === "between") {
          const [lo, hi] = operand as [unknown, unknown];
          parts.push(`${column} BETWEEN ${compileValue(host, lo)} AND ${compileValue(host, hi)}`);
        } else {
          throw new ScopeConfigurationError(
            `RLS policy on '${modelName}': unsupported operator '${op}' cannot be compiled to a Postgres policy. ` +
            `Supported operators: ${Object.keys(OPERATOR_SQL).join(", ")}, in, notIn, is, isNot, like, iLike, between.`,
          );
        }
      }
    } else {
      // Bare value or setting: implicit eq
      parts.push(`${column} = ${compileValue(host, value)}`);
    }
  }

  if (parts.length === 0) {
    return "TRUE";
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return parts.join(" AND ");
}

function compileValue(host: PolicyCompilerHost, value: unknown): string {
  if (isRlsSetting(value)) {
    return settingToSql(value);
  }
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return host.escapeLiteral(value);
}

function compileQuantifier(
  host: PolicyCompilerHost,
  association: Association,
  quantifier: string,
  innerFilter: PortableWhere,
  parentRef: string,
  ctx: AliasCounter,
): string {
  const isBtm = association.associationType === "belongsToMany";
  const isBelongsTo = association.associationType === "belongsTo";
  const isHasOne = association.associationType === "hasOne";
  const isHasMany = association.associationType === "hasMany";

  if ((isHasMany || isBtm) && !MANY_QUANTIFIERS.has(quantifier)) {
    throw new ScopeConfigurationError(
      `RLS policy: quantifier '${quantifier}' is not valid for ${association.associationType} relationship '${association.name}'.`,
    );
  }
  if ((isBelongsTo || isHasOne) && !SINGLE_QUANTIFIERS.has(quantifier)) {
    throw new ScopeConfigurationError(
      `RLS policy: quantifier '${quantifier}' is not valid for ${association.associationType} relationship '${association.name}'.`,
    );
  }

  if (isBtm) {
    return compileBtmQuantifier(host, association, quantifier, innerFilter, parentRef, ctx);
  }

  const targetTable = host.quoteTable(host.getTableName(association.target));
  const alias = host.quoteIdentifier(ctx.next());

  // Association keys are attribute names; the SQL needs column names.
  const col = (model: string, attr: string) => host.quoteIdentifier(host.getColumnName(model, attr));
  let parentCol: string;
  let targetCol: string;
  if (isBelongsTo) {
    parentCol = col(association.source, association.foreignKey);
    targetCol = col(association.target, association.targetKey);
  } else {
    parentCol = col(association.source, association.sourceKey);
    targetCol = col(association.target, association.foreignKey);
  }

  const isEmpty = Object.keys(innerFilter).length === 0;
  const isEvery = quantifier === "every";

  if (isEvery && isEmpty) {
    return "TRUE";
  }

  const asFunction = !ctx.inFunction && reachesRls(host, association, innerFilter);
  const wasInFunction = ctx.inFunction;
  ctx.inFunction = wasInFunction || asFunction;
  const innerSql = isEmpty
    ? undefined
    : compileWhere(host, association.target, innerFilter, alias, ctx);
  ctx.inFunction = wasInFunction;

  const negate = quantifier === "none" || quantifier === "isNot" || isEvery;

  const parentColRef = parentRef ? `${parentRef}.${parentCol}` : parentCol;
  if (asFunction) {
    let body = `SELECT ${alias}.${targetCol} FROM ${targetTable} AS ${alias} WHERE ${alias}.${targetCol} IS NOT NULL`;
    if (innerSql) {
      body += isEvery ? ` AND NOT COALESCE((${innerSql}), FALSE)` : ` AND ${innerSql}`;
    }
    const keyAttr = isBelongsTo ? association.targetKey : association.foreignKey;
    return hopFunctionCall(host, body, host.hops!.columnType(association.target, keyAttr), parentColRef, negate);
  }
  let subquery = `SELECT 1 FROM ${targetTable} AS ${alias} WHERE ${alias}.${targetCol} = ${parentColRef}`;
  if (innerSql) {
    if (isEvery) {
      subquery += ` AND NOT COALESCE((${innerSql}), FALSE)`;
    } else {
      subquery += ` AND ${innerSql}`;
    }
  }

  return negate ? `NOT EXISTS (${subquery})` : `EXISTS (${subquery})`;
}

function compileBtmQuantifier(
  host: PolicyCompilerHost,
  association: Association,
  quantifier: string,
  innerFilter: PortableWhere,
  parentRef: string,
  ctx: AliasCounter,
): string {
  const joinModelName = association.through as string;
  const joinTable = host.quoteTable(host.getTableName(joinModelName));
  const joinAlias = host.quoteIdentifier(ctx.next());

  const targetTable = host.quoteTable(host.getTableName(association.target));
  const targetAlias = host.quoteIdentifier(ctx.next());

  const col = (model: string, attr: string) => host.quoteIdentifier(host.getColumnName(model, attr));
  const sourceKey = col(association.source, association.sourceKey);
  const foreignKey = col(joinModelName, association.foreignKey);
  const otherKey = col(joinModelName, association.otherKey as string);
  const targetKey = col(association.target, association.targetKey);

  const isEmpty = Object.keys(innerFilter).length === 0;
  const isEvery = quantifier === "every";

  if (isEvery && isEmpty) {
    return "TRUE";
  }

  const asFunction = !ctx.inFunction && reachesRls(host, association, innerFilter);
  const wasInFunction = ctx.inFunction;
  ctx.inFunction = wasInFunction || asFunction;
  const innerSql = isEmpty
    ? undefined
    : compileWhere(host, association.target, innerFilter, targetAlias, ctx);
  ctx.inFunction = wasInFunction;

  let targetExists: string;
  if (innerSql) {
    if (isEvery) {
      targetExists = `EXISTS (SELECT 1 FROM ${targetTable} AS ${targetAlias} WHERE ${targetAlias}.${targetKey} = ${joinAlias}.${otherKey} AND NOT COALESCE((${innerSql}), FALSE))`;
    } else {
      targetExists = `EXISTS (SELECT 1 FROM ${targetTable} AS ${targetAlias} WHERE ${targetAlias}.${targetKey} = ${joinAlias}.${otherKey} AND ${innerSql})`;
    }
  } else {
    targetExists = `EXISTS (SELECT 1 FROM ${targetTable} AS ${targetAlias} WHERE ${targetAlias}.${targetKey} = ${joinAlias}.${otherKey})`;
  }

  const negate = quantifier === "none" || isEvery;

  const parentColRef = parentRef ? `${parentRef}.${sourceKey}` : sourceKey;
  if (asFunction) {
    const body = `SELECT ${joinAlias}.${foreignKey} FROM ${joinTable} AS ${joinAlias} WHERE ${joinAlias}.${foreignKey} IS NOT NULL AND ${targetExists}`;
    return hopFunctionCall(host, body, host.hops!.columnType(joinModelName, association.foreignKey), parentColRef, negate);
  }
  let subquery = `SELECT 1 FROM ${joinTable} AS ${joinAlias} WHERE ${joinAlias}.${foreignKey} = ${parentColRef}`;
  subquery += ` AND ${targetExists}`;

  return negate ? `NOT EXISTS (${subquery})` : `EXISTS (${subquery})`;
}

/**
 * Generate the full SQL text for a CREATE POLICY statement.
 *
 * @returns The complete SQL text (without the `CREATE POLICY` prefix — just the
 *   `USING (…)` and/or `WITH CHECK (…)` clause contents).
 */
export interface CompiledPolicy {
  /** The table name (quoted). */
  table: string;
  /** The policy name (unquoted, used in `CREATE POLICY "name"`). */
  name: string;
  /** `PERMISSIVE` or `RESTRICTIVE`. */
  as: string;
  /** `ALL`, `SELECT`, `INSERT`, `UPDATE` or `DELETE`. */
  for: string;
  /** `TO role1, role2` clause. */
  to: string;
  /** The USING expression text, or undefined for INSERT policies. */
  using?: string;
  /** The WITH CHECK expression text, or undefined for SELECT/DELETE policies. */
  withCheck?: string;
  /** SHA-256 hex hash of the full CREATE POLICY SQL. */
  hash: string;
  /** The full CREATE POLICY SQL text. */
  sql: string;
}
