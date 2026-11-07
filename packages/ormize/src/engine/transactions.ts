// Transaction coordination and ambient context management.
//
// `transaction()` opens a coordinator, `withTransaction()` enrolls a mutation
// in it, and `runWithContext`/`getContext` expose AsyncLocalStorage-backed
// ambient state. Extracted from the class so transaction logic is readable
// on its own.

import { inheritScopeMemo } from "../scope";
import OrmizeTransaction from "../transaction";
import { store, getStore } from "../context";
import type { OrmAdapter, RequestContext } from "@azerothian/utilize/types/index";
import type Ormize from "../manager";

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

/** The narrow slice of the class the transaction helpers need. */
export interface TransactionHost {
  defsAdapters: { [name: string]: string };
  adapters: { [name: string]: OrmAdapter };
  /** The `findAdapter` path: `undefined` when the name is unknown. */
  findAdapter(datasource: string | undefined): OrmAdapter | undefined;
}

// ---------------------------------------------------------------------------
// transaction()
// ---------------------------------------------------------------------------

/**
 * Run a coordinated unit of work. Any create/update/delete inside `fn` — on any
 * adapter — joins the same coordinator: they commit together on success and all
 * roll back if `fn` throws. Nested `transaction` calls join the active
 * coordinator rather than opening a new one. See {@link OrmizeTransaction} for
 * the best-effort (non-two-phase-commit) guarantee.
 */
export async function transaction<T = unknown>(orm: Ormize, fn: (tx: OrmizeTransaction) => Promise<T>): Promise<T> {
  const current = getStore();
  if (current?.transaction) {
    return fn(current.transaction);
  }
  const coordinator = new OrmizeTransaction(orm);
  return store.run({ ...(current || {}), transaction: coordinator }, async () => {
    try {
      const result = await fn(coordinator);
      await coordinator.commit();
      return result;
    } catch (e) {
      await coordinator.rollback();
      throw e;
    }
  });
}

/** Run `fn` with an ambient request `context`, readable via `getContext()`. */
export function runWithContext<T = unknown>(context: RequestContext, fn: () => T): T {
  const current = getStore();
  return store.run({ ...(current || {}), context }, fn);
}

/** The ambient request context for the current async scope, if any. */
export function getContext(): RequestContext {
  return getStore()?.context;
}

/**
 * Run a mutation body enrolled in the correct per-adapter transaction so a
 * multi-step mutation either fully applies or fully rolls back.
 *
 * - With an active coordinator (ambient, from `transaction()`) it resolves and
 *   stamps THIS model's adapter transaction handle onto the context — so a
 *   nested mutation on a *different* adapter joins that adapter's transaction,
 *   not the parent's.
 * - With no coordinator it auto-wraps the single mutation in one (preserving
 *   single-adapter atomicity), then re-enters via the coordinator path.
 * - An explicit `context.transaction` (with no coordinator) is honoured as-is,
 *   and an adapter without transaction support just runs the callback directly.
 */
export async function withTransaction<T>(self: TransactionHost, orm: Ormize, defName: string, context: RequestContext, fn: (ctx: RequestContext) => Promise<T>): Promise<T> {
  const adapterName = self.defsAdapters[defName];
  const active = getStore()?.transaction;
  if (active) {
    const handle = await active.handleFor(adapterName);
    return fn(inheritScopeMemo(context, Object.assign({}, context, { transaction: handle })));
  }
  if (context && context.transaction) {
    return fn(context);
  }
  // Lenient by design: an adapter with no transaction support runs unenrolled.
  const adapter = self.findAdapter(adapterName);
  if (!adapter || (typeof adapter.beginTransaction !== "function" && typeof adapter.transaction !== "function")) {
    return fn(context);
  }
  return transaction(orm, async() => withTransaction(self, orm, defName, context, fn));
}
