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
import type { PolicyCompilerHost, CompiledPolicy } from "./compile-policy";
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

/** What the sync module needs from the adapter. */
export interface SyncHost extends PolicyCompilerHost {
  sequelize: Sequelize;
  getDefinitions(): { [name: string]: Definition & { name: string } };
  getTableNameString(modelName: string): string;
}

/** Options from `new Ormize({ rls: { manageRoles } })`. */
export interface RlsSyncOptions {
  manageRoles?: boolean;
}

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
export function buildCompilerHost(sequelize: Sequelize, definitions: { [name: string]: Definition }): SyncHost {
  const qg = sequelize.getQueryInterface().queryGenerator as {
    quoteIdentifier(id: string): string;
    quoteTable(table: string | object): string;
    escape(value: unknown): string;
  };

  return {
    sequelize,
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
          target: { name: string; getTableName(): string | object };
          foreignKey: string;
          sourceKey?: string;
          targetKey?: string;
          otherKey?: string;
          through?: { model?: { name: string; getTableName(): string | object } };
        };
        result[name] = {
          name,
          associationType: a.associationType,
          target: a.target.name,
          foreignKey: a.foreignKey,
          sourceKey: a.sourceKey || "id",
          targetKey: a.targetKey || "id",
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

      // Mark the table as gqlize-managed for RLS (§6.4 step 6).
      // We use a dedicated marker policy that acts as a no-op (USING TRUE, FOR ALL, TO PUBLIC).
      // This avoids clobbering table comments.
      const tableMarkerName = `${model.tableName}__gqlize_rls_marker`;
      const markerRows = await read(
        `SELECT polname FROM pg_policy WHERE polrelid = ${regclass(model.tableName)} AND polname = ${host.escapeLiteral(tableMarkerName)}`, t,
      );
      if (markerRows.length === 0) {
        await run(`CREATE POLICY ${host.quoteIdentifier(tableMarkerName)} ON ${host.quoteTable(model.tableName)} AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE)`, t);
        await run(`COMMENT ON POLICY ${host.quoteIdentifier(tableMarkerName)} ON ${host.quoteTable(model.tableName)} IS '${TABLE_MARKER}'`, t);
      }
    }

    // 4. Policies — create/alter/drop+create
    for (const model of models) {
      if (!model.rls.enabled) {
        continue;
      }
      const compiled = compileModelPolicies(host, model.defName, model.tableName, model.rls);

      // Warn if a paranoid model has a policy mentioning its deletedAt column
      warnDeletedAtPolicy(model, compiled, host);

      for (const policy of compiled) {
        await reconcilePolicy(host, policy, model.tableName, t, run);
      }

      // 5. Stale policies — drop managed policies that are no longer declared
      const declaredNames = new Set(compiled.map((p) => p.name));
      const markerName = `${model.tableName}__gqlize_rls_marker`;
      declaredNames.add(markerName);

      const existingPolicies = await read(
        `SELECT p.polname, d.description FROM pg_policy p LEFT JOIN pg_description d ON d.objoid = p.oid WHERE p.polrelid = ${regclass(model.tableName)}`, t,
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
        `SELECT p.polname, d.description FROM pg_policy p LEFT JOIN pg_description d ON d.objoid = p.oid WHERE p.polrelid = ${regclass(tn)}`, t,
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
    `SELECT p.polname, p.polcmd, p.polpermissive, d.description FROM pg_policy p LEFT JOIN pg_description d ON d.objoid = p.oid WHERE p.polrelid = ${regclass(tableName)} AND p.polname = ${escapedName}`,
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
    lines.push(`  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ${regclass(model.tableName)} AND polname = ${host.escapeLiteral(markerName)}) THEN`);
    lines.push(`    CREATE POLICY ${host.quoteIdentifier(markerName)} ON ${qt} AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);`);
    lines.push(`    COMMENT ON POLICY ${host.quoteIdentifier(markerName)} ON ${qt} IS '${TABLE_MARKER}';`);
    lines.push(`  END IF;`);
    lines.push(`END $$;`);
    lines.push("");

    // Policies
    const compiled = compileModelPolicies(host, model.defName, model.tableName, model.rls);
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
    lines.push(`    LEFT JOIN pg_description d ON d.objoid = p.oid`);
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
  lines.push(`    LEFT JOIN pg_description d ON d.objoid = p.oid`);
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
