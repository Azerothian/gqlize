// Reconcile RLS policies in `sync()` and produce DDL for `rls:sql`.
//
// §6.4: one transaction, advisory lock, roles only with manageRoles, enable/force
// only when pg_class says not already, per policy: hash comparison against
// pg_policy comments, stale removal, disabled-model reversal.
//
// Every query call issues one statement (PGlite rejects multi-statement
// prepared queries).

import { createHash } from "node:crypto";
import { ScopeConfigurationError } from "@azerothian/utilize/gate";
import type { RlsOptions, RlsPolicyDeclaration, RlsPolicyCommand } from "@azerothian/utilize/types/definitions";
import { isRlsSqlFragment } from "@azerothian/utilize/types/definitions";
import { compilePolicyExpression } from "./compile-policy";
import type { PolicyCompilerHost, CompiledPolicy, HopFunctionRegistry } from "./compile-policy";
import type { PortableWhere } from "@azerothian/utilize/gate";
import type { Sequelize, Transaction } from "sequelize";
import type { Association, Definition } from "@azerothian/utilize/types/index";

// Fixed advisory lock key for gqlize RLS sync. Chosen to be unlikely to
// collide with application locks (a large negative bigint).
const ADVISORY_LOCK_KEY = -7291834650;

/** The marker comment prefix. */
const MANAGED_PREFIX = "gqlize:managed:";

/** The table marker comment value. */
const TABLE_MARKER = "gqlize:rls";

const log = {
  warn: (message: string) => console.warn(message), // eslint-disable-line no-console
};

/**
 * Postgres `::regclass` resolves unquoted names case-insensitively. A table
 * named `"Tasks"` (capital T) needs `'"Tasks"'::regclass`, not
 * `'Tasks'::regclass` (which resolves to `tasks`).
 */
function regclass(tableName: string): string {
  return `'"${tableName}"'::regclass`;
}

/** A generated hop function (see `HopFunctionRegistry` in `compile-policy`). */
export interface HopFunction {
  /** Unquoted function name, `gqlize_rls_<hash of body and type>`. */
  name: string;
  /** Schema-qualified, quoted name, as policies call it. */
  qualified: string;
  body: string;
  returnType: string;
  /** Formatted `TO` entries of the policies that call it (`"role"` or `PUBLIC`). */
  roles: Set<string>;
}

/** What the sync module needs from the adapter. */
export interface SyncHost extends PolicyCompilerHost {
  sequelize: Sequelize;
  getDefinitions(): { [name: string]: Definition & { name: string } };
  getTableNameString(modelName: string): string;
  /** The schema hop functions live in, and the one their `search_path` pins. */
  schema: string;
  /** Who owns hop functions: the adapter's `rls.bypassRole`, else the connection's role. */
  functionOwner?: string;
  /** The adapter's `rls.softDeleteFlag`: policies mentioning `deletedAt` are then intended. */
  softDeleteFlag?: string;
  /** Every hop function compiled so far, by unquoted name. */
  hopFunctions: Map<string, HopFunction>;
}

/** Options from `new Ormize({ rls: { manageRoles } })`. */
export interface RlsSyncOptions {
  manageRoles?: boolean;
}

/** What `buildCompilerHost` needs beyond the Sequelize instance and definitions. */
export interface CompilerHostOptions {
  /** Default `sequelize.options.schema`, else `public`. */
  schema?: string;
  functionOwner?: string;
  softDeleteFlag?: string;
}

const HOP_PREFIX = "gqlize_rls_";
const HOP_COMMENT_PREFIX = "gqlize:hop:";

/** A model and its RLS config, ready for sync. */
interface RlsModel {
  defName: string;
  tableName: string;
  rls: RlsOptions;
  definition: Definition;
}

/**
 * Build the `PolicyCompilerHost` from a Sequelize instance and a definitions map.
 */
export function buildCompilerHost(
  sequelize: Sequelize,
  definitions: { [name: string]: Definition },
  options: CompilerHostOptions = {},
): SyncHost {
  const qg = sequelize.getQueryInterface().queryGenerator as {
    quoteIdentifier(id: string): string;
    quoteTable(table: string | object): string;
    escape(value: unknown): string;
  };
  const schema = options.schema ?? (sequelize as unknown as { options: { schema?: string } }).options.schema ?? "public";
  const hopFunctions = new Map<string, HopFunction>();
  const hops: HopFunctionRegistry = {
    isRlsModel: (modelName) => definitions[modelName]?.options?.rls?.enabled === true,
    columnType(modelName, attribute) {
      const attr = sequelize.models[modelName]?.getAttributes()[attribute] as { type?: { toSql?(): string } } | undefined;
      const type = attr?.type?.toSql?.();
      if (!type) {
        throw new ScopeConfigurationError(
          `RLS policy: cannot tell the SQL type of '${modelName}.${attribute}' for a relationship hop function.`,
        );
      }
      return type;
    },
    define(body, returnType) {
      const name = `${HOP_PREFIX}${createHash("sha256").update(`${returnType}\n${body}`).digest("hex").slice(0, 16)}`;
      const qualified = `${qg.quoteIdentifier(schema)}.${qg.quoteIdentifier(name)}`;
      if (!hopFunctions.has(name)) {
        hopFunctions.set(name, { name, qualified, body, returnType, roles: new Set() });
      }
      return qualified;
    },
  };

  return {
    sequelize,
    schema,
    functionOwner: options.functionOwner,
    softDeleteFlag: options.softDeleteFlag,
    hopFunctions,
    hops,
    getDefinitions: () => definitions as { [name: string]: Definition & { name: string } },
    getAssociations(modelName: string): { [relName: string]: Association } {
      const model = sequelize.models[modelName];
      if (!model) {
        return {};
      }
      const associations = model.associations || {};
      const result: { [relName: string]: Association } = {};
      for (const [name, assoc] of Object.entries(associations)) {
        // Adapt Sequelize associations to the Association type
        const a = assoc as unknown as {
          associationType: string;
          source: { name: string; primaryKeyAttribute: string };
          target: { name: string; primaryKeyAttribute: string };
          foreignKey: string;
          sourceKey?: string;
          targetKey?: string;
          otherKey?: string;
          through?: { model?: { name: string } };
        };
        // The same shape the adapter's `getAssociations` reports: Sequelize
        // says `BelongsTo`, every compiler here compares against `belongsTo`,
        // and a miss fell through to the hasMany join columns.
        result[name] = {
          name,
          associationType: a.associationType.charAt(0).toLowerCase() + a.associationType.slice(1),
          source: a.source.name,
          target: a.target.name,
          foreignKey: a.foreignKey,
          sourceKey: a.sourceKey || a.source.primaryKeyAttribute,
          targetKey: a.targetKey || a.target.primaryKeyAttribute,
          otherKey: a.otherKey,
          through: a.through?.model?.name,
        } as Association;
      }
      return result;
    },
    quoteIdentifier: (id) => qg.quoteIdentifier(id),
    quoteTable: (table) => qg.quoteTable(table),
    escapeLiteral: (value) => qg.escape(value),
    getColumnName(modelName: string, fieldName: string): string {
      const model = sequelize.models[modelName];
      if (!model) {
        return fieldName;
      }
      const attr = model.getAttributes()[fieldName];
      return (attr?.field ?? fieldName);
    },
    getTableName(modelName: string): string | { schema?: string; tableName: string } {
      const model = sequelize.models[modelName];
      if (!model) {
        return modelName;
      }
      return model.getTableName();
    },
    getTableNameString(modelName: string): string {
      const tn = this.getTableName(modelName);
      if (typeof tn === "string") {
        return tn;
      }
      return tn.tableName;
    },
    getPrimaryKeyAttribute(modelName: string): string | undefined {
      const model = sequelize.models[modelName];
      return model?.primaryKeyAttributes?.[0];
    },
  };
}

/**
 * Compile all policies for a model into `CompiledPolicy` objects.
 */
export function compileModelPolicies(
  host: PolicyCompilerHost,
  modelName: string,
  tableName: string,
  rls: RlsOptions,
): CompiledPolicy[] {
  const policies = rls.policies || {};
  const results: CompiledPolicy[] = [];

  for (const [key, decl] of Object.entries(policies)) {
    results.push(compileSinglePolicy(host, modelName, tableName, key, decl));
  }
  return results;
}

function compileSinglePolicy(
  host: PolicyCompilerHost,
  modelName: string,
  tableName: string,
  key: string,
  decl: RlsPolicyDeclaration,
): CompiledPolicy {
  const policyName = `${tableName}_${key}`;
  const policyAs = (decl.as || "permissive").toUpperCase();
  const policyFor = (decl.for || "all").toUpperCase();
  const policyTo = formatRoles(decl.to);

  // Determine USING and WITH CHECK
  let usingExpr: string | undefined;
  let withCheckExpr: string | undefined;
  const policyForLower = (decl.for || "all").toLowerCase() as RlsPolicyCommand;

  if (policyForLower !== "insert" && decl.using) {
    usingExpr = compilePolicyExpression(host, modelName, decl.using);
  }

  if (policyForLower === "all" || policyForLower === "insert" || policyForLower === "update") {
    if (decl.withCheck) {
      withCheckExpr = compilePolicyExpression(host, modelName, decl.withCheck);
    } else if (decl.using) {
      // withCheck defaults to using for all/insert/update
      withCheckExpr = compilePolicyExpression(host, modelName, decl.using);
    }
  }

  // Build the full SQL
  const quotedTable = host.quoteTable(host.getTableName(modelName));
  let sql = `CREATE POLICY ${host.quoteIdentifier(policyName)} ON ${quotedTable}`;
  sql += ` AS ${policyAs}`;
  sql += ` FOR ${policyFor}`;
  sql += ` TO ${policyTo}`;
  if (usingExpr) {
    sql += ` USING (${usingExpr})`;
  }
  if (withCheckExpr) {
    sql += ` WITH CHECK (${withCheckExpr})`;
  }

  const hash = createHash("sha256").update(sql).digest("hex");

  return {
    table: quotedTable,
    name: policyName,
    as: policyAs,
    for: policyFor,
    to: policyTo,
    using: usingExpr,
    withCheck: withCheckExpr,
    hash,
    sql,
  };
}

function formatRoles(to: string | string[] | undefined): string {
  if (!to) {
    return "PUBLIC";
  }
  const roles = Array.isArray(to) ? to : [to];
  return roles.map((r) => r.toLowerCase() === "public" ? "PUBLIC" : `"${r}"`).join(", ");
}

/**
 * Compile every enabled model's policies, and note which roles call each hop
 * function the compilation registered.
 */
function compileAll(host: SyncHost, models: RlsModel[]): Map<RlsModel, CompiledPolicy[]> {
  const out = new Map<RlsModel, CompiledPolicy[]>();
  for (const model of models) {
    if (!model.rls.enabled) {
      continue;
    }
    const compiled = compileModelPolicies(host, model.defName, model.tableName, model.rls);
    for (const policy of compiled) {
      for (const fn of host.hopFunctions.values()) {
        if (policy.sql.includes(fn.qualified)) {
          policy.to.split(", ").forEach((role) => fn.roles.add(role));
        }
      }
    }
    out.set(model, compiled);
  }
  return out;
}

function hopCreateSql(host: SyncHost, fn: HopFunction): string {
  // `search_path` pinned with pg_temp last: the body names tables unqualified,
  // and a caller's temporary table must never stand in for one of them inside
  // a function that runs with RLS bypassed.
  return `CREATE FUNCTION ${fn.qualified}() RETURNS SETOF ${fn.returnType} LANGUAGE sql STABLE SECURITY DEFINER ` +
    `SET search_path = pg_catalog, ${host.quoteIdentifier(host.schema)}, pg_temp AS $gqlize_rls$ ${fn.body} $gqlize_rls$`;
}

/** The owner and grants, as a hash, so a change in either is noticed. */
function hopComment(host: SyncHost, fn: HopFunction): string {
  const roles = Array.from(fn.roles).sort().join(",");
  return HOP_COMMENT_PREFIX + createHash("sha256").update(`${host.functionOwner ?? ""}|${roles}`).digest("hex").slice(0, 16);
}

/** Owner, grants and comment for a hop function. Idempotent. */
function hopAccessSql(host: SyncHost, fn: HopFunction): string[] {
  const sql: string[] = [];
  if (host.functionOwner) {
    sql.push(`ALTER FUNCTION ${fn.qualified}() OWNER TO ${host.quoteIdentifier(host.functionOwner)}`);
  }
  sql.push(`REVOKE ALL ON FUNCTION ${fn.qualified}() FROM PUBLIC`);
  sql.push(`GRANT EXECUTE ON FUNCTION ${fn.qualified}() TO ${Array.from(fn.roles).sort().join(", ")}`);
  sql.push(`COMMENT ON FUNCTION ${fn.qualified}() IS '${hopComment(host, fn)}'`);
  return sql;
}

const OWNER_BYPASSES_RLS = (owner: string | undefined, escape: (v: unknown) => string) =>
  `SELECT rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = ${owner ? escape(owner) : "current_user"}`;

const hopOwnerError = (owner: string | undefined) =>
  `RLS policies here follow relationships into tables that have RLS themselves, which gqlize runs through ` +
  `SECURITY DEFINER functions (a policy reading its own table, or a table whose policy reads back, is ` +
  `otherwise infinite recursion in Postgres). Their owner, ${owner ? `role '${owner}' (rls.bypassRole)` : "the connection's role"}, ` +
  `must be a superuser or have BYPASSRLS. Set the adapter's rls.bypassRole to such a role.`;

// --- sync execution ---

/**
 * Reconcile RLS policies against the database. Called by
 * `SequelizeAdapter.syncRowSecurity`.
 *
 * Returns the SQL statements that were actually executed, for test assertions.
 */
export async function syncRowSecurity(
  host: SyncHost,
  models: RlsModel[],
  options: RlsSyncOptions = {},
): Promise<string[]> {
  const sequelize = host.sequelize;
  const executed: string[] = [];

  const run = async (sql: string, transaction: Transaction) => {
    executed.push(sql);
    await sequelize.query(sql, { transaction });
  };
  /** Read rows from a catalog query. Returns the rows array. */
  const read = async (sql: string, transaction: Transaction): Promise<Record<string, unknown>[]> => {
    const [rows] = await sequelize.query(sql, { transaction }) as [Record<string, unknown>[], unknown];
    return rows;
  };


  await sequelize.transaction(async (t) => {
    // 1. Advisory lock
    await run(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`, t);

    // 2. Roles (only with manageRoles)
    if (options.manageRoles) {
      const allRoles = collectRoles(models);
      for (const role of allRoles) {
        const rows = await read(
          `SELECT 1 FROM pg_roles WHERE rolname = ${host.escapeLiteral(role)}`, t,
        );
        if (rows.length === 0) {
          await run(`CREATE ROLE "${role}" NOLOGIN`, t);
        }
      }
    }

    // 3. Enable/Force RLS on tables
    for (const model of models) {
      if (!model.rls.enabled) {
        continue;
      }
      const pgClass = await read(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ${regclass(model.tableName)}`, t,
      );

      const row = pgClass[0];
      if (row && !row.relrowsecurity) {
        await run(`ALTER TABLE ${host.quoteTable(model.tableName)} ENABLE ROW LEVEL SECURITY`, t);
      }
      const force = model.rls.force !== false;
      if (force && row && !row.relforcerowsecurity) {
        await run(`ALTER TABLE ${host.quoteTable(model.tableName)} FORCE ROW LEVEL SECURITY`, t);
      }

      // Mark the table as gqlize-managed for RLS (§6.4 step 6) with a policy
      // that filters nothing, so the table's own comment is left alone.
      //
      // It MUST be RESTRICTIVE. Postgres ORs permissive policies together, so a
      // permissive `USING (TRUE)` would let every role see and write every row
      // and switch RLS off for the whole table. Restrictive policies are ANDed,
      // so `TRUE` is a no-op, and a table with no permissive policy still denies
      // everything. A marker left permissive by an earlier build is replaced.
      const tableMarkerName = `${model.tableName}__gqlize_rls_marker`;
      const markerRows = await read(
        `SELECT polpermissive FROM pg_policy WHERE polrelid = ${regclass(model.tableName)} AND polname = ${host.escapeLiteral(tableMarkerName)}`, t,
      ) as Array<{ polpermissive: boolean }>;
      if (markerRows.length > 0 && markerRows[0].polpermissive) {
        await run(`DROP POLICY ${host.quoteIdentifier(tableMarkerName)} ON ${host.quoteTable(model.tableName)}`, t);
      }
      if (markerRows.length === 0 || markerRows[0].polpermissive) {
        await run(`CREATE POLICY ${host.quoteIdentifier(tableMarkerName)} ON ${host.quoteTable(model.tableName)} AS RESTRICTIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE)`, t);
        await run(`COMMENT ON POLICY ${host.quoteIdentifier(tableMarkerName)} ON ${host.quoteTable(model.tableName)} IS '${TABLE_MARKER}'`, t);
      }
    }

    // 4a. Hop functions the policies call (see `HopFunctionRegistry`).
    const compiledByModel = compileAll(host, models);
    if (host.hopFunctions.size > 0) {
      const [owner] = await read(OWNER_BYPASSES_RLS(host.functionOwner, (v) => host.escapeLiteral(v)), t);
      if (!owner?.ok) {
        throw new ScopeConfigurationError(hopOwnerError(host.functionOwner));
      }
    }
    for (const fn of host.hopFunctions.values()) {
      const existing = await read(
        `SELECT p.oid, d.description FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ` +
        `LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_proc'::regclass ` +
        `WHERE n.nspname = ${host.escapeLiteral(host.schema)} AND p.proname = ${host.escapeLiteral(fn.name)}`, t,
      );
      if (existing.length === 0) {
        await run(hopCreateSql(host, fn), t);
      } else if (existing[0].description === hopComment(host, fn)) {
        continue;
      } else {
        // Grants changed: take back every grant before giving the new ones.
        const grantees = await read(
          `SELECT DISTINCT a.grantee::regrole::text AS grantee FROM pg_proc p, aclexplode(p.proacl) a ` +
          `WHERE p.oid = ${String(existing[0].oid)} AND a.grantee <> 0 AND a.grantee <> p.proowner`, t,
        );
        for (const g of grantees) {
          await run(`REVOKE ALL ON FUNCTION ${fn.qualified}() FROM ${String(g.grantee)}`, t);
        }
      }
      for (const sql of hopAccessSql(host, fn)) {
        await run(sql, t);
      }
    }

    // 4b. Policies — create/alter/drop+create
    for (const model of models) {
      if (!model.rls.enabled) {
        continue;
      }
      const compiled = compiledByModel.get(model) as CompiledPolicy[];

      // Warn if a paranoid model has a policy mentioning its deletedAt column
      if (!host.softDeleteFlag) {
        warnDeletedAtPolicy(model, compiled, host);
      }

      for (const policy of compiled) {
        await reconcilePolicy(host, policy, model.tableName, t, run);
      }

      // 5. Stale policies — drop managed policies that are no longer declared
      const declaredNames = new Set(compiled.map((p) => p.name));
      const markerName = `${model.tableName}__gqlize_rls_marker`;
      declaredNames.add(markerName);

      const existingPolicies = await read(
        `SELECT p.polname, d.description FROM pg_policy p LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_policy'::regclass WHERE p.polrelid = ${regclass(model.tableName)}`, t,
      );

      for (const existing of existingPolicies) {
        const name = existing.polname as string;
        if (declaredNames.has(name)) {
          continue;
        }
        const comment = existing.description as string | null;
        if (comment && comment.startsWith(MANAGED_PREFIX)) {
          await run(`DROP POLICY ${host.quoteIdentifier(name)} ON ${host.quoteTable(model.tableName)}`, t);
        }
      }
    }

    // 6. Disabled models — reverse what gqlize enabled
    const definitions = host.getDefinitions();
    for (const [defName, def] of Object.entries(definitions)) {
      const rlsOpts = def.options?.rls;
      if (rlsOpts?.enabled) {
        continue; // still enabled
      }
      const mdl = host.sequelize.models[defName];
      if (!mdl) {
        continue;
      }
      const tn = typeof mdl.getTableName() === "string"
        ? mdl.getTableName() as string
        : (mdl.getTableName() as { tableName: string }).tableName;

      // Check if gqlize managed this table (has the marker policy)
      const markerName = `${tn}__gqlize_rls_marker`;
      const disableMarkerRows = await read(
        `SELECT 1 FROM pg_policy WHERE polrelid = ${regclass(tn)} AND polname = ${host.escapeLiteral(markerName)}`, t,
      );

      if (disableMarkerRows.length === 0) {
        continue; // not managed by gqlize
      }

      // Drop all managed policies
      const existingPolicies = await read(
        `SELECT p.polname, d.description FROM pg_policy p LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_policy'::regclass WHERE p.polrelid = ${regclass(tn)}`, t,
      );

      for (const existing of existingPolicies) {
        const comment = existing.description as string | null;
        const name = existing.polname as string;
        if ((comment && comment.startsWith(MANAGED_PREFIX)) || comment === TABLE_MARKER) {
          await run(`DROP POLICY ${host.quoteIdentifier(name)} ON ${host.quoteTable(tn)}`, t);
        }
      }

      // Disable RLS
      await run(`ALTER TABLE ${host.quoteTable(tn)} NO FORCE ROW LEVEL SECURITY`, t);
      await run(`ALTER TABLE ${host.quoteTable(tn)} DISABLE ROW LEVEL SECURITY`, t);
    }

    // 7. Hop functions no policy calls any more. Last, once no policy depends on them.
    const existingHops = await read(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ` +
      `WHERE n.nspname = ${host.escapeLiteral(host.schema)} AND p.proname LIKE 'gqlize\\_rls\\_%'`, t,
    );
    for (const row of existingHops) {
      const name = row.proname as string;
      if (!host.hopFunctions.has(name)) {
        await run(`DROP FUNCTION ${host.quoteIdentifier(host.schema)}.${host.quoteIdentifier(name)}()`, t);
      }
    }
  });

  return executed;
}

async function reconcilePolicy(
  host: SyncHost,
  policy: CompiledPolicy,
  tableName: string,
  transaction: Transaction,
  run: (sql: string, transaction: Transaction) => Promise<void>,
) {
  const sequelize = host.sequelize;
  const escapedName = host.escapeLiteral(policy.name);

  // Look up existing policy
  const [existing] = await sequelize.query(
    `SELECT p.polname, p.polcmd, p.polpermissive, d.description FROM pg_policy p LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_policy'::regclass WHERE p.polrelid = ${regclass(tableName)} AND p.polname = ${escapedName}`,
    { transaction },
  ) as [Record<string, unknown>[], unknown];

  if (existing.length === 0) {
    // Not found -> CREATE
    await run(policy.sql, transaction);
    await run(
      `COMMENT ON POLICY ${host.quoteIdentifier(policy.name)} ON ${host.quoteTable(tableName)} IS '${MANAGED_PREFIX}${policy.hash}'`,
      transaction,
    );
    return;
  }

  const row = existing[0];
  const comment = row.description as string | null;

  // Existing without gqlize marker -> refuse
  if (!comment || !comment.startsWith(MANAGED_PREFIX)) {
    throw new ScopeConfigurationError(
      `RLS policy '${policy.name}' on table '${tableName}' already exists but was not created by gqlize. ` +
      `gqlize will not take over a hand-written policy. Rename either the hand-written policy or the gqlize policy key.`,
    );
  }

  // Same hash -> nothing to do
  const existingHash = comment.slice(MANAGED_PREFIX.length);
  if (existingHash === policy.hash) {
    return;
  }

  // Check if `for` or `as` changed (requires drop+create since ALTER POLICY cannot change these)
  const existingCmd = pgCmdToString(row.polcmd as string);
  const existingPermissive = row.polpermissive as boolean;
  const existingAs = existingPermissive ? "PERMISSIVE" : "RESTRICTIVE";

  if (existingCmd !== policy.for || existingAs !== policy.as) {
    // Drop + Create
    await run(`DROP POLICY ${host.quoteIdentifier(policy.name)} ON ${host.quoteTable(tableName)}`, transaction);
    await run(policy.sql, transaction);
    await run(
      `COMMENT ON POLICY ${host.quoteIdentifier(policy.name)} ON ${host.quoteTable(tableName)} IS '${MANAGED_PREFIX}${policy.hash}'`,
      transaction,
    );
    return;
  }

  // Same `for` and `as` -> ALTER POLICY (can change TO, USING, WITH CHECK)
  let alterSql = `ALTER POLICY ${host.quoteIdentifier(policy.name)} ON ${host.quoteTable(tableName)} TO ${policy.to}`;
  if (policy.using) {
    alterSql += ` USING (${policy.using})`;
  }
  if (policy.withCheck) {
    alterSql += ` WITH CHECK (${policy.withCheck})`;
  }
  await run(alterSql, transaction);
  await run(
    `COMMENT ON POLICY ${host.quoteIdentifier(policy.name)} ON ${host.quoteTable(tableName)} IS '${MANAGED_PREFIX}${policy.hash}'`,
    transaction,
  );
}

/** Convert pg_policy.polcmd single-char to the keyword form. */
function pgCmdToString(cmd: string): string {
  switch (cmd) {
    case "*":
      return "ALL";
    case "r":
      return "SELECT";
    case "a":
      return "INSERT";
    case "w":
      return "UPDATE";
    case "d":
      return "DELETE";
    default:
      return cmd.toUpperCase();
  }
}

function collectRoles(models: RlsModel[]): Set<string> {
  const roles = new Set<string>();
  for (const model of models) {
    if (!model.rls.enabled) {
      continue;
    }
    for (const decl of Object.values(model.rls.policies || {})) {
      const to = decl.to;
      if (!to) {
        continue;
      }
      const list = Array.isArray(to) ? to : [to];
      for (const r of list) {
        if (r.toLowerCase() !== "public") {
          roles.add(r);
        }
      }
    }
  }
  return roles;
}

function warnDeletedAtPolicy(
  model: RlsModel,
  compiled: CompiledPolicy[],
  host: PolicyCompilerHost,
): void {
  // Only check paranoid models with filter-vocabulary policies
  const def = model.definition;
  const isParanoid = !!(def.options as Record<string, unknown>)?.paranoid;
  if (!isParanoid) {
    return;
  }

  const policies = model.rls.policies || {};
  for (const [key, decl] of Object.entries(policies)) {
    // Can only inspect filter-vocabulary policies, not raw SQL
    for (const expr of [decl.using, decl.withCheck]) {
      if (!expr || isRlsSqlFragment(expr)) {
        continue;
      }
      const where = expr;
      if (mentionsField(where, "deletedAt")) {
        log.warn(
          `RLS policy '${model.tableName}_${key}' on paranoid model '${model.defName}' ` +
          `mentions the deletedAt column. This will cause soft-delete operations to fail ` +
          `under RLS. See RFC §6.8 for details.`,
        );
      }
    }
  }
}

function mentionsField(where: PortableWhere, field: string): boolean {
  for (const key of Object.keys(where)) {
    if (key === field) {
      return true;
    }
    const value = where[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (mentionsField(value as PortableWhere, field)) {
        return true;
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && mentionsField(item as PortableWhere, field)) {
          return true;
        }
      }
    }
  }
  return false;
}

// --- DDL generation for rls:sql ---

/**
 * Generate idempotent DDL (DO blocks) for all RLS models. No DB connection needed.
 * Uses the same generator as sync, but wraps each operation in catalog checks.
 */
export function generateRlsSql(
  host: SyncHost,
  models: RlsModel[],
  options: RlsSyncOptions = {},
): string {
  const lines: string[] = [];
  lines.push("-- Generated by gqlize rls:sql");
  lines.push("-- Idempotent: safe to run multiple times.");
  lines.push("");
  lines.push("BEGIN;");
  lines.push(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY});`);
  lines.push("");

  // Roles
  if (options.manageRoles) {
    const allRoles = collectRoles(models);
    for (const role of allRoles) {
      lines.push(`DO $$ BEGIN`);
      lines.push(`  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${host.escapeLiteral(role)}) THEN`);
      lines.push(`    CREATE ROLE "${role}" NOLOGIN;`);
      lines.push(`  END IF;`);
      lines.push(`END $$;`);
      lines.push("");
    }
  }

  // Hop functions, before any policy that calls them.
  const compiledByModel = compileAll(host, models);
  if (host.hopFunctions.size > 0) {
    lines.push(`DO $$ BEGIN`);
    lines.push(`  IF NOT COALESCE((${OWNER_BYPASSES_RLS(host.functionOwner, (v) => host.escapeLiteral(v))}), FALSE) THEN`);
    lines.push(`    RAISE EXCEPTION ${host.escapeLiteral(hopOwnerError(host.functionOwner))};`);
    lines.push(`  END IF;`);
    lines.push(`END $$;`);
    lines.push("");
  }
  for (const fn of host.hopFunctions.values()) {
    lines.push(`DO $gqlize_do$ DECLARE`);
    lines.push(`  _g RECORD;`);
    lines.push(`BEGIN`);
    lines.push(`  IF to_regprocedure(${host.escapeLiteral(`${fn.qualified}()`)}) IS NULL THEN`);
    lines.push(`    ${hopCreateSql(host, fn)};`);
    lines.push(`  END IF;`);
    lines.push(`  FOR _g IN SELECT DISTINCT a.grantee::regrole::text AS grantee FROM pg_proc p, aclexplode(p.proacl) a`);
    lines.push(`    WHERE p.oid = to_regprocedure(${host.escapeLiteral(`${fn.qualified}()`)}) AND a.grantee <> 0 AND a.grantee <> p.proowner LOOP`);
    lines.push(`    EXECUTE format('REVOKE ALL ON FUNCTION ${fn.qualified.replace(/'/g, "''")}() FROM %s', _g.grantee);`);
    lines.push(`  END LOOP;`);
    for (const sql of hopAccessSql(host, fn)) {
      lines.push(`  ${sql};`);
    }
    lines.push(`END $gqlize_do$;`);
    lines.push("");
  }

  // Per table
  for (const model of models) {
    if (!model.rls.enabled) {
      continue;
    }
    const qt = host.quoteTable(model.tableName);

    // Enable RLS
    lines.push(`DO $$ BEGIN`);
    lines.push(`  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ${regclass(model.tableName)}) THEN`);
    lines.push(`    ALTER TABLE ${qt} ENABLE ROW LEVEL SECURITY;`);
    lines.push(`  END IF;`);
    lines.push(`END $$;`);
    lines.push("");

    // Force RLS
    if (model.rls.force !== false) {
      lines.push(`DO $$ BEGIN`);
      lines.push(`  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = ${regclass(model.tableName)}) THEN`);
      lines.push(`    ALTER TABLE ${qt} FORCE ROW LEVEL SECURITY;`);
      lines.push(`  END IF;`);
      lines.push(`END $$;`);
      lines.push("");
    }

    // Table marker policy
    const markerName = `${model.tableName}__gqlize_rls_marker`;
    lines.push(`DO $$ BEGIN`);
    // RESTRICTIVE, never PERMISSIVE: see the marker in `syncRowSecurity`.
    lines.push(`  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ${regclass(model.tableName)} AND polname = ${host.escapeLiteral(markerName)} AND polpermissive) THEN`);
    lines.push(`    DROP POLICY ${host.quoteIdentifier(markerName)} ON ${qt};`);
    lines.push(`  END IF;`);
    lines.push(`  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ${regclass(model.tableName)} AND polname = ${host.escapeLiteral(markerName)}) THEN`);
    lines.push(`    CREATE POLICY ${host.quoteIdentifier(markerName)} ON ${qt} AS RESTRICTIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);`);
    lines.push(`    COMMENT ON POLICY ${host.quoteIdentifier(markerName)} ON ${qt} IS '${TABLE_MARKER}';`);
    lines.push(`  END IF;`);
    lines.push(`END $$;`);
    lines.push("");

    // Policies
    const compiled = compiledByModel.get(model) as CompiledPolicy[];
    for (const policy of compiled) {
      lines.push(generatePolicyDdl(host, policy, model.tableName));
      lines.push("");
    }

    // Stale policy removal
    const declaredNames = new Set(compiled.map((p) => p.name));
    declaredNames.add(markerName);
    lines.push(`-- Remove stale managed policies on ${model.tableName}`);
    lines.push(`DO $$ DECLARE`);
    lines.push(`  _pol RECORD;`);
    lines.push(`BEGIN`);
    lines.push(`  FOR _pol IN`);
    lines.push(`    SELECT p.polname, d.description FROM pg_policy p`);
    lines.push(`    LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_policy'::regclass`);
    lines.push(`    WHERE p.polrelid = ${regclass(model.tableName)}`);
    lines.push(`  LOOP`);
    lines.push(`    IF _pol.description LIKE '${MANAGED_PREFIX}%'`);
    const nameList = Array.from(declaredNames).map((n) => host.escapeLiteral(n)).join(", ");
    lines.push(`       AND _pol.polname NOT IN (${nameList}) THEN`);
    lines.push(`      EXECUTE format('DROP POLICY %I ON ${qt}', _pol.polname);`);
    lines.push(`    END IF;`);
    lines.push(`  END LOOP;`);
    lines.push(`END $$;`);
    lines.push("");
  }

  // Hop functions no policy calls any more.
  const keep = Array.from(host.hopFunctions.keys()).map((n) => host.escapeLiteral(n));
  lines.push(`DO $$ DECLARE`);
  lines.push(`  _f RECORD;`);
  lines.push(`BEGIN`);
  lines.push(`  FOR _f IN SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace`);
  lines.push(`    WHERE n.nspname = ${host.escapeLiteral(host.schema)} AND p.proname LIKE 'gqlize\\_rls\\_%'${keep.length ? ` AND p.proname NOT IN (${keep.join(", ")})` : ""} LOOP`);
  lines.push(`    EXECUTE format('DROP FUNCTION %I.%I()', ${host.escapeLiteral(host.schema)}, _f.proname);`);
  lines.push(`  END LOOP;`);
  lines.push(`END $$;`);
  lines.push("");

  lines.push("COMMIT;");
  return lines.join("\n");
}

function generatePolicyDdl(host: SyncHost, policy: CompiledPolicy, tableName: string): string {
  const qt = host.quoteTable(tableName);
  const qn = host.quoteIdentifier(policy.name);
  const escapedName = host.escapeLiteral(policy.name);
  const escapedTable = host.escapeLiteral(tableName);
  const commentText = `${MANAGED_PREFIX}${policy.hash}`;

  const lines: string[] = [];
  lines.push(`DO $$ DECLARE`);
  lines.push(`  _existing RECORD;`);
  lines.push(`BEGIN`);
  lines.push(`  SELECT p.polcmd, p.polpermissive, d.description`);
  lines.push(`    INTO _existing`);
  lines.push(`    FROM pg_policy p`);
  lines.push(`    LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_policy'::regclass`);
  lines.push(`    WHERE p.polrelid = ${regclass(tableName)} AND p.polname = ${escapedName};`);
  lines.push(`  IF NOT FOUND THEN`);
  lines.push(`    ${policy.sql};`);
  lines.push(`    COMMENT ON POLICY ${qn} ON ${qt} IS '${commentText}';`);
  lines.push(`  ELSIF _existing.description = '${commentText}' THEN`);
  lines.push(`    NULL; -- unchanged`);
  lines.push(`  ELSIF _existing.description IS NULL OR NOT _existing.description LIKE '${MANAGED_PREFIX}%' THEN`);
  lines.push(`    RAISE EXCEPTION 'RLS policy % on table % exists but was not created by gqlize', ${escapedName}, ${escapedTable};`);

  // Check if for/as changed (requires drop+create)
  const cmdChar = policyForToCmd(policy.for);
  const permBool = policy.as === "PERMISSIVE" ? "true" : "false";
  lines.push(`  ELSIF _existing.polcmd <> ${host.escapeLiteral(cmdChar)} OR _existing.polpermissive <> ${permBool} THEN`);
  lines.push(`    DROP POLICY ${qn} ON ${qt};`);
  lines.push(`    ${policy.sql};`);
  lines.push(`    COMMENT ON POLICY ${qn} ON ${qt} IS '${commentText}';`);
  lines.push(`  ELSE`);

  // ALTER POLICY
  let alterSql = `ALTER POLICY ${qn} ON ${qt} TO ${policy.to}`;
  if (policy.using) {
    alterSql += ` USING (${policy.using})`;
  }
  if (policy.withCheck) {
    alterSql += ` WITH CHECK (${policy.withCheck})`;
  }
  lines.push(`    ${alterSql};`);
  lines.push(`    COMMENT ON POLICY ${qn} ON ${qt} IS '${commentText}';`);
  lines.push(`  END IF;`);
  lines.push(`END $$;`);

  return lines.join("\n");
}

function policyForToCmd(forStr: string): string {
  switch (forStr) {
    case "ALL":
      return "*";
    case "SELECT":
      return "r";
    case "INSERT":
      return "a";
    case "UPDATE":
      return "w";
    case "DELETE":
      return "d";
    default:
      return "*";
  }
}

/** Extract the RLS models from definitions. */
export function extractRlsModels(
  host: SyncHost,
): RlsModel[] {
  const defs = host.getDefinitions();
  const models: RlsModel[] = [];
  for (const [defName, def] of Object.entries(defs)) {
    const rlsOpts = def.options?.rls;
    if (!rlsOpts) {
      continue;
    }
    const model = host.sequelize.models[defName];
    if (!model) {
      continue;
    }
    const tn = typeof model.getTableName() === "string"
      ? model.getTableName() as string
      : (model.getTableName() as { tableName: string }).tableName;
    models.push({
      defName,
      tableName: tn,
      rls: rlsOpts,
      definition: def,
    });
  }
  return models;
}
