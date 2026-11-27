// `rls.softDeleteFlag` (RFC §6.8): let a SELECT policy hide soft-deleted rows
// without breaking soft delete, restore, hard delete and `deleted:` reads.
//
// Postgres applies SELECT policies to the rows an UPDATE/DELETE reads and to an
// UPDATE's new row, so a policy that says `"deletedAt" IS NULL` rejects every
// soft delete and silently hides the rows restore and `deleted: INCLUDE/ONLY`
// need. The policy can only coexist with them through a flag the engine
// controls: `("deletedAt" IS NULL OR current_setting('<flag>', true) = 'on')`.
//
// The flag is set to 'on' for the rest of the transaction, once, before the
// first statement that needs it:
//   - a find/count with `paranoid: false` (root or any include node), which is
//     how `deleted: INCLUDE/ONLY`, restore's lookup and the paranoid eager
//     re-query read deleted rows;
//   - any destroy or restore of a paranoid model (soft delete, hard delete,
//     restore, and their bulk forms).
// Only on a transaction this adapter opened with a request's identity: a bare
// connection has no settings for a policy to read anyway.

import type { Sequelize, Transaction } from "sequelize";

type FindOptions = { paranoid?: boolean; transaction?: Transaction | null; include?: unknown };
type ModelLike = { options?: { paranoid?: boolean } };

const FIND_HOOKS = ["beforeFind", "beforeCount"] as const;
const WRITE_HOOKS = ["beforeDestroy", "beforeBulkDestroy", "beforeRestore", "beforeBulkRestore"] as const;

/** Whether any include node, at any depth, reads with `paranoid: false`. */
function includesDeleted(include: unknown): boolean {
  const nodes = Array.isArray(include) ? include : include ? [include] : [];
  return nodes.some((node) => {
    if (!node || typeof node !== "object") {
      return false;
    }
    const n = node as { paranoid?: boolean; include?: unknown };
    return n.paranoid === false || includesDeleted(n.include);
  });
}

/**
 * Install the hooks. `isRlsTransaction` says whether a transaction carries a
 * request's identity (the adapter's own bookkeeping).
 */
export function installSoftDeleteFlag(
  sequelize: Sequelize,
  flag: string,
  isRlsTransaction: (transaction: unknown) => boolean,
): void {
  const flagged = new WeakSet<object>();

  const raise = async(transaction: Transaction | null | undefined) => {
    if (!transaction || flagged.has(transaction) || !isRlsTransaction(transaction)) {
      return;
    }
    flagged.add(transaction);
    await sequelize.query("SELECT set_config($1, 'on', true)", { bind: [flag], transaction });
  };

  for (const hook of FIND_HOOKS) {
    sequelize.addHook(hook, async(options: FindOptions) => {
      if (options?.paranoid === false || includesDeleted(options?.include)) {
        await raise(options?.transaction);
      }
    });
  }
  // The instance hooks are called with (instance, options), the bulk ones with
  // (options), whose `model` names the model.
  for (const hook of WRITE_HOOKS) {
    sequelize.addHook(hook, async(first: unknown, second?: unknown) => {
      const isBulk = hook === "beforeBulkDestroy" || hook === "beforeBulkRestore";
      const options = (isBulk ? first : second) as (FindOptions & { model?: ModelLike }) | undefined;
      const model = isBulk
        ? options?.model
        : (first as { constructor?: ModelLike } | undefined)?.constructor;
      if (model?.options?.paranoid) {
        await raise(options?.transaction);
      }
    });
  }
}
