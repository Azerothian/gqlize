// `gqlize rls:sql` — print idempotent RLS DDL from definitions alone, no DB
// connection. Uses the same generator as syncRowSecurity.

import type { ParsedArgs } from "../args";
import type { ResolvedConfig } from "../config";

/**
 * Print the idempotent DDL for Postgres row-level security policies.
 * No database connection is opened — the SQL is generated from definitions.
 */
export default async function rlsSql(
  resolved: ResolvedConfig,
  _args: ParsedArgs,
  out: (line: string) => void,
): Promise<number> {
  const orm = await resolved.config.orm();

  // Find the first adapter that has generateRlsSql.
  let generated = false;
  for (const adapterName of Object.keys(orm.adapters)) {
    const adapter = orm.adapters[adapterName] as {
      generateRlsSql?: (definitions: Record<string, unknown>, options?: { manageRoles?: boolean }) => string;
    };
    if (typeof adapter.generateRlsSql !== "function") {
      continue;
    }
    // Collect definitions for this adapter.
    const defs: Record<string, unknown> = {};
    for (const defName of Object.keys(orm.defs)) {
      if (orm.defsAdapters[defName] === adapterName) {
        defs[defName] = orm.defs[defName];
      }
    }
    const sql = adapter.generateRlsSql(defs);
    out(sql);
    generated = true;
  }

  if (!generated) {
    out("-- No RLS-capable adapters found. No SQL to generate.");
  }
  return 0;
}
