import { AdapterTransaction, AdapterTransactionHandle } from "@azerothian/utilize/types/index";
import type Ormize from "./manager";

/**
 * Coordinates a unit of work that may span multiple adapters.
 *
 * It lazily begins an unmanaged transaction on each adapter the first time that
 * adapter is used, tracks them, and finalises them together: `commit()` commits
 * all, `rollback()` rolls all back. If any operation inside the unit of work
 * throws, the caller (`orm.transaction`) rolls everything back — so a failure on
 * one adapter undoes the work already done on the others.
 *
 * BEST-EFFORT, NOT TWO-PHASE COMMIT: mid-work failures roll back cleanly, but a
 * failure during the final commit phase (after some adapters have already
 * committed) cannot be undone — the underlying stores (SQLite, Postgres) provide
 * no distributed/XA transaction. `commit()` surfaces such an error and rolls back
 * whatever had not yet committed.
 */
export default class OrmizeTransaction {
  private txs = new Map<string, AdapterTransaction>();

  // `Ormize`'s own generics (TModels/TBase) aren't relevant to what this class
  // needs off it (just `adapters`), so the bare (defaulted) type is enough.
  constructor(private manager: Ormize) {}

  /**
   * The adapter-native transaction handle for `adapterName`, beginning one on
   * first use. Returns `undefined` for adapters that don't support transactions
   * (their operations then run unenrolled, as before).
   */
  async handleFor(adapterName: string): Promise<AdapterTransactionHandle> {
    const existing = this.txs.get(adapterName);
    if (existing) {
      return existing.handle;
    }
    const adapter = this.manager.adapters[adapterName];
    if (!adapter || typeof adapter.beginTransaction !== "function") {
      return undefined;
    }
    const tx = await adapter.beginTransaction();
    this.txs.set(adapterName, tx);
    return tx.handle;
  }

  /** True once at least one adapter transaction has been opened. */
  get isEmpty(): boolean {
    return this.txs.size === 0;
  }

  async commit(): Promise<void> {
    const all = [...this.txs.values()];
    this.txs.clear();
    const committed: AdapterTransaction[] = [];
    try {
      for (const tx of all) {
        await tx.commit();
        committed.push(tx);
      }
    } catch (e) {
      // Roll back whatever had not yet committed (already-committed adapters
      // cannot be undone — see the class doc on the best-effort guarantee).
      const remaining = all.filter((t) => !committed.includes(t));
      await Promise.allSettled(remaining.map((t) => t.rollback()));
      throw e;
    }
  }

  async rollback(): Promise<void> {
    const all = [...this.txs.values()];
    this.txs.clear();
    await Promise.allSettled(all.map((t) => t.rollback()));
  }
}
