// Deferring one nested create's scope re-check until its link exists.
//
// `processCreate` re-checks a new row against its create scope as soon as the
// row and its own nested writes are done. A nested create under a parent
// (`Doc(create: {notes: {create: …}})`) is linked to that parent only *after*
// `processCreate` returns, by the relationship's `add` / `set` accessor in
// `relationship-mutations.ts`. A scope that follows the link (a Note visible
// through `doc: {is: …}`) can't be satisfied before it, so checking at the
// usual point refuses every such create (RFC §4.5).
//
// `deferCreateCheck` runs one `processCreate` with its re-check captured
// instead of run, and hands the captured checks back for the caller to run
// once the link is in place, inside the same transaction. The check is moved,
// never dropped: a caller that forgets to run what it got back would let the
// row through, which is why the only caller is `applyCreate` and the deferral
// isn't reachable from the public `Ormize.processCreate`.
//
// The store is single-use. The first `processCreate` to run inside the
// callback takes it; any create further down (a grandchild, a create reached
// through another verb) sees it taken and checks itself as usual.

import { AsyncLocalStorage } from "node:async_hooks";

type Deferral = { taken: boolean; checks: (() => Promise<void>)[] };

const store = new AsyncLocalStorage<Deferral>();

/**
 * Run `fn` with the first `processCreate` inside it deferring its re-check.
 * Returns `fn`'s result and the checks to run once the row is linked.
 */
export async function deferCreateCheck<T>(fn: () => Promise<T>): Promise<{ result: T; checks: (() => Promise<void>)[] }> {
  const deferral: Deferral = { taken: false, checks: [] };
  const result = await store.run(deferral, fn);
  return { result, checks: deferral.checks };
}

/**
 * Take the deferral, if this is the first create inside a `deferCreateCheck`.
 * `processCreate` calls it on entry, before any nested write runs, so a create
 * reached from inside its own nested writes can never take the parent's slot.
 * The caller pushes its re-check onto `checks` instead of running it.
 */
export function claimCreateDeferral(): Deferral | undefined {
  const deferral = store.getStore();
  if (!deferral || deferral.taken) {
    return undefined;
  }
  deferral.taken = true;
  return deferral;
}
