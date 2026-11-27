// The system context: work with no request behind it (`orm.asSystem`, RFC §6.5).
//
// Recognised by the engine (no row scope) and by an RLS adapter (its
// `bypassRole`, no settings). The mark is a module-private symbol: nothing a
// request sends (JSON, a query string, a header) can carry one, so no request
// can turn an ordinary context into this one. It is enumerable on purpose, so
// the copies the engine makes (`Object.assign({}, context, { transaction })`)
// keep it; `Object.keys` and `JSON.stringify` still never see it. Lives here
// because both ormize and the adapters must agree on it without depending on
// each other.

import type { RequestContext } from "./types/index";

const SYSTEM = Symbol("gqlize.systemContext");

/** A fresh system context. Only `orm.asSystem` should hand one out. */
export function createSystemContext(): RequestContext {
  return { [SYSTEM]: true };
}

/** Whether `context` is a system context made by {@link createSystemContext}. */
export function isSystemContext(context: unknown): boolean {
  return !!context && typeof context === "object" && (context as { [SYSTEM]?: boolean })[SYSTEM] === true;
}
