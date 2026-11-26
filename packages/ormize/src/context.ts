import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "@azerothian/utilize/types/index";
import type OrmizeTransaction from "./transaction";

/**
 * Ambient per-operation state, propagated across async boundaries by
 * AsyncLocalStorage. It carries the active cross-adapter transaction coordinator
 * (so nested create/update/delete on any adapter join the same unit of work) and
 * an arbitrary request `context` (so `definition.before`/`after` hooks and
 * userland can read request-scoped data without it being threaded by hand).
 */
export interface OrmizeStore {
  transaction?: OrmizeTransaction;
  context?: RequestContext;
  /**
   * The coordinator the engine opened for one RLS read and nothing else (RFC
   * §6.5). It exists only to carry the request's settings and role, so the
   * read cache may serve and fill reads inside it, keyed on that identity.
   */
  readWrap?: OrmizeTransaction;
  /** Set while the next coordinator `transaction()` opens is a read wrap. */
  readWrapPending?: boolean;
}

export const store = new AsyncLocalStorage<OrmizeStore>();

/** The active ambient store for the current async context, if any. */
export function getStore(): OrmizeStore | undefined {
  return store.getStore();
}
