import type { Ormize } from "@azerothian/ormize";

/**
 * Capture the SQL a test's queries actually emit.
 *
 * Query reduction is a claim about the *number of statements* — a nested
 * selection that folds into one JOIN versus one query per parent — so a test
 * that only inspects the returned data cannot tell the two apart. It has to
 * count, and sometimes it has to look at the shape.
 *
 * `sequelize`'s public types never declare `.options` on `Sequelize`, even
 * though the constructor sets it and the library reads it throughout — it is
 * absent from the `.d.ts`, not fenced off. The cast below names the exact shape
 * this depends on rather than opening the door to anything else.
 *
 * Reassigning `options.logging` after construction (rather than passing
 * `logging` to the adapter) is what lets a test start capturing partway through,
 * after the schema build and fixture inserts have already run and would
 * otherwise drown the counts.
 */
type SequelizeWithLogging = { sequelize: { options: { logging: (sql: string) => void } } };

export interface SqlCapture {
  /** Every statement logged since capture began, newest last. */
  queries: string[];
  /** Just the SELECTs — the ones a query-count assertion is about. */
  selects(): string[];
  /** SELECTs that join, for asserting a relation folded into its parent. */
  joins(): string[];
  /** Drop everything captured so far, to count one query in isolation. */
  reset(): void;
}

/**
 * @param defName any model on the adapter to watch. The fixtures share one
 *   Sequelize instance, so this only has to name a model on the right adapter —
 *   not the model under test.
 */
export function captureQueries(instance: Ormize, defName = "Task"): SqlCapture {
  const queries: string[] = [];
  const adapter = instance.getModelAdapter(defName) as unknown as SequelizeWithLogging;
  if (!adapter?.sequelize?.options) {
    throw new Error(`captureQueries: '${defName}' is not on a Sequelize adapter`);
  }
  adapter.sequelize.options.logging = (sql: string) => queries.push(sql);
  // Anchored on sequelize's own `Executing (default): ` prefix so a statement
  // that merely mentions the word SELECT — a subquery inside an INSERT, a
  // literal in a where-operator — is not counted as a read.
  const selects = () => queries.filter((q) => /^Executing \(.*\): SELECT/i.test(q));
  return {
    queries,
    selects,
    joins: () => selects().filter((q) => /\bJOIN\b/i.test(q)),
    reset: () => { queries.length = 0; },
  };
}
