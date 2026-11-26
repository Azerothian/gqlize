// Row-scope helpers that bridge the Ormize class to the scope module.
//
// These functions mediate between the class's state (permission, adapters,
// definitions) and the pure scope logic in `../scope.ts`.

import { whereOperatorsFor } from "@azerothian/utilize/exposed-methods";
import type { Permission, PortableWhere, ResolvedScope, ScopeOperation } from "@azerothian/utilize/gate";
import {
  resolveViaMarkers, collectQuantifierTargets, parseQuantifier, LOGICAL_OPERATORS,
  ScopeConfigurationError, SCOPE_MODEL_NAME, SCOPE_THROUGH_CB,
} from "@azerothian/utilize/gate";
import { applyScopeWhere, scopeFor, scopeMiss, markSystemQuery } from "../scope";
import type { ScopeMissBehaviour } from "../scope";
import { ScopeDeniedError, ScopeEscapeError } from "../scope";
import { filterMerger } from "../cross-adapter";
import type { OrmAdapter, AdapterQueryOptions, AdapterWhere, RequestContext } from "@azerothian/utilize/types/index";
import type { Definition } from "../types";
import type { MutationHost } from "../types/engine";

// ---------------------------------------------------------------------------
// Host interface — what the scope helpers read from the class
// ---------------------------------------------------------------------------

/** The narrow slice of the `Ormize` class the scope-bridge helpers need. */
export interface ScopeHost {
  permission: Permission | undefined;
  onScopeMiss: ScopeMissBehaviour;
  defs: { [name: string]: Definition };
  defsAdapters: { [name: string]: string };
  adapters: { [name: string]: OrmAdapter };
  host: MutationHost;
  getModelAdapter(modelName: string): OrmAdapter;
  getDefinition(defName: string): Definition;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `permission.scope` for one model and operation.
 *
 * `undefined` imposes nothing, `false` denies every row, anything else is the
 * filter (and, for writes, the values) to apply. Memoised per request inside
 * {@link scopeFor} — a nested selection would otherwise re-run the predicate
 * once per parent row.
 *
 * After basic scope resolution, this resolves any `__via` markers the scope
 * sugar emitted into proper quantifier nesting using the association graph,
 * and checks that no quantifier crosses adapter boundaries.
 */
export async function resolveRowScope(self: ScopeHost, defName: string, operation: ScopeOperation, context: RequestContext): Promise<ResolvedScope> {
  const resolved = await scopeFor(self.permission, defName, operation, context);
  if (resolved === undefined || resolved === false) {
    return resolved;
  }
  if (!resolved.where) {
    return resolved;
  }
  // Resolve __via markers into proper quantifier nesting.
  const associationInfo = (model: string, relName: string): { associationType: string; target: string } | undefined => {
    if (!self.defs[model]) {
      return undefined;
    }
    const assocs = self.host.getAssociations(model);
    const assoc = assocs[relName];
    if (!assoc) {
      return undefined;
    }
    return { associationType: assoc.associationType, target: assoc.target };
  };
  const resolvedWhere = resolveViaMarkers(resolved.where, defName, associationInfo);
  // Validate that no quantifier crosses adapter boundaries.
  const associations = (model: string) => {
    if (!self.defs[model]) {
      return {};
    }
    return self.host.getAssociations(model);
  };
  const targets = collectQuantifierTargets(resolvedWhere, defName, associations);
  const sourceAdapter = self.defsAdapters[defName];
  for (const target of targets) {
    const targetAdapter = self.defsAdapters[target];
    if (targetAdapter !== undefined && targetAdapter !== sourceAdapter) {
      throw new ScopeConfigurationError(
        `A relationship quantifier in the scope for '${defName}' reaches '${target}', ` +
        `which lives on a different adapter ('${targetAdapter}' vs '${sourceAdapter}'). ` +
        "One query cannot reach another database.",
      );
    }
  }
  return { ...resolved, where: resolvedWhere };
}

/**
 * Re-impose a scope on options that have already been translated into the
 * backend's vocabulary.
 *
 * Only needed where userland code has had a chance to rewrite `where` after
 * the portable merge. An adapter with no way to AND two native filters cannot
 * be scoped behind such a hook; running the query anyway would run it
 * unscoped, so this refuses instead.
 */
export async function reassertRowScope(
  self: ScopeHost,
  adapter: OrmAdapter, defName: string, where: PortableWhere,
  whereOperators: ReturnType<typeof whereOperatorsFor>, options: AdapterQueryOptions,
  targets: (AdapterQueryOptions | undefined)[],
) {
  if (!adapter.andFilterStatements) {
    throw new Error(
      `Adapter '${adapter.adapterName}' cannot re-assert a row-level scope on '${defName}': ` +
      "it does not implement andFilterStatements, and '" + defName + "' has a `before` hook " +
      "that could have rewritten the filter. Implement andFilterStatements, or drop the hook.",
    );
  }
  const native = await adapter.processFilterArgument(where, whereOperators, options);
  for (const target of targets) {
    if (target) {
      // In place on purpose. These are the adapter's own options bags, built
      // by `processListArgsToOptions` and about to be executed; re-imposing
      // the scope *after* a `before` hook may have rewritten the filter is
      // the whole job. A copy would have to be rebound by every caller, and
      // a caller that forgot would run the query unscoped.
      target.where = adapter.andFilterStatements(target.where, native);
    }
  }
}

/**
 * A model's scope for one operation, in its adapter's vocabulary, ANDed onto
 * `where`. Used by cross-adapter accessors that need the native shape rather
 * than the portable one.
 */
export async function scopeNativeWhere(
  self: ScopeHost,
  defName: string, operation: ScopeOperation, context: RequestContext,
  where: AdapterWhere | undefined, options: AdapterQueryOptions | undefined,
): Promise<AdapterWhere | undefined | false> {
  const resolved = await resolveRowScope(self, defName, operation, context);
  if (resolved === false) {
    return false;
  }
  if (!resolved?.where) {
    return where;
  }
  const adapter = self.getModelAdapter(defName);
  const native = await compileScopeWhere(self, adapter, defName, resolved.where, context, options || {});
  if (!where) {
    return native;
  }
  if (!adapter.andFilterStatements) {
    throw new Error(
      `Adapter '${adapter.adapterName}' cannot scope a cross-adapter relationship on '${defName}': ` +
      "it does not implement andFilterStatements, and a row-level scope has to be ANDed onto the join filter.",
    );
  }
  return adapter.andFilterStatements(where, native);
}

/**
 * Compile a scope's portable where to adapter-native form, handling
 * relationship quantifiers when the adapter supports them.
 *
 * When quantifiers are present and the adapter has `compileRelationshipFilter`,
 * they are compiled to the adapter's native representation (e.g. correlated
 * EXISTS subqueries for Sequelize). When quantifiers are present and the adapter
 * does not support them, `ScopeConfigurationError` is thrown.
 */
async function compileScopeWhere(
  self: ScopeHost,
  adapter: OrmAdapter, defName: string,
  scopeWhere: PortableWhere, context: RequestContext,
  options: AdapterQueryOptions,
): Promise<AdapterWhere> {
  const hasQuantifiers = scopeWhereHasQuantifiers(scopeWhere, defName, self);
  if (!hasQuantifiers) {
    return adapter.processFilterArgument(
      scopeWhere, whereOperatorsFor(self.getDefinition(defName)), options,
    );
  }
  if (!adapter.compileRelationshipFilter) {
    throw new ScopeConfigurationError(
      `Adapter '${adapter.adapterName}' does not support relationship quantifiers, ` +
      `but the scope for '${defName}' contains one. Use an adapter that supports them ` +
      "(e.g. the Sequelize adapter), or remove the quantifier from the scope.",
    );
  }
  // Build the scopeForThrough callback: returns the read scope for a
  // registered join model, in the adapter's native form, so the subquery
  // filters by it.
  const scopeForThrough = async (joinModel: string): Promise<AdapterWhere | undefined> => {
    const resolved = await resolveRowScope(self, joinModel, "read", context);
    if (resolved === false || !resolved?.where) {
      return undefined;
    }
    return adapter.processFilterArgument(
      resolved.where, whereOperatorsFor(self.getDefinition(joinModel)), options,
    );
  };
  return adapter.compileRelationshipFilter(defName, scopeWhere, options, scopeForThrough);
}

/**
 * Whether a portable where contains any relationship quantifier keys.
 */
function scopeWhereHasQuantifiers(where: PortableWhere | undefined, defName: string, self: ScopeHost): boolean {
  if (!where || typeof where !== "object") {
    return false;
  }
  const associations = self.defs[defName] ? self.host.getAssociations(defName) : {};
  for (const key of Object.keys(where)) {
    const lower = key.toLowerCase();
    if (LOGICAL_OPERATORS.has(lower)) {
      const branch = where[key];
      if (Array.isArray(branch)) {
        if (branch.some((entry) => scopeWhereHasQuantifiers(entry as PortableWhere, defName, self))) {
          return true;
        }
      } else if (scopeWhereHasQuantifiers(branch as PortableWhere, defName, self)) {
        return true;
      }
      continue;
    }
    if (parseQuantifier(where[key]) && associations[key]) {
      return true;
    }
  }
  return false;
}

/**
 * The portable filter a root write runs under: the caller's, ANDed with the
 * model's **read** scope as well as the operation's own. `false` when either
 * half denies outright.
 *
 * Reaching a row is a read whatever happens to it next. The nested verbs
 * (`applyRelationshipMutations`) and the cross-adapter instance checks
 * (`writable`) have both required the read half since they were written;
 * without this the root verbs would be the one path left where naming a row
 * you are not allowed to *see* is enough to write it.
 *
 * When the scope contains relationship quantifiers, they are compiled to the
 * adapter's native form here so downstream write functions do not need to
 * know about them.
 */
export async function scopedWriteWhere(
  self: ScopeHost,
  defName: string, operation: ScopeOperation, context: RequestContext,
  userWhere: PortableWhere | undefined,
): Promise<PortableWhere | undefined | false> {
  let own = await resolveRowScope(self, defName, operation, context);
  if (own === false) {
    return false;
  }
  let read = await resolveRowScope(self, defName, "read", context);
  if (read === false) {
    return false;
  }
  // Stamp quantifier info on each scope half so it propagates to the merge.
  own = compileScopeWhereIfNeeded(self, defName, context, own);
  read = compileScopeWhereIfNeeded(self, defName, context, read);
  const merged = applyScopeWhere(applyScopeWhere(userWhere, read), own);
  // Propagate stamps from scope wheres to the merged result.
  if (merged) {
    if (own?.where && (own.where as { [SCOPE_MODEL_NAME]?: string })[SCOPE_MODEL_NAME]) {
      stampQuantifierInfo(merged, own);
    } else if (read?.where && (read.where as { [SCOPE_MODEL_NAME]?: string })[SCOPE_MODEL_NAME]) {
      stampQuantifierInfo(merged, read);
    }
  }
  return merged;
}

/**
 * F6. Assert every row a write just produced still satisfies the scope.
 *
 * A scope's `set` forces the fields it *names*; nothing forces the fields it
 * *filters on*. An update naming a writable column — or an `add`/`set` verb
 * re-pointing a foreign key, which writes no column the caller named at all —
 * can carry a row from inside the principal's slice to outside it. By then
 * there is no filter left to merge into, so the rows are read back and the
 * scope asked again.
 *
 * Always throws, whatever `onScopeMiss` says. The quiet path exists so that a
 * refused write is indistinguishable from one that matched no rows, and that
 * equivalence is gone here: the row *was* written. Inside `orm.transaction()`
 * the throw rolls it back; outside one, the caller is at least told plainly
 * that it did not.
 */
export async function assertRowsInScope(
  self: ScopeHost,
  defName: string, operation: ScopeOperation, context: RequestContext,
  rows: import("@azerothian/utilize/types/index").AdapterRow[], options: AdapterQueryOptions | undefined,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  // The pair the write ran under, asked again. An update reached an existing
  // row, and reaching one is a read, so it answers to both halves. A create
  // reached nothing — and a principal allowed to add rows to a model it may
  // not read back is a legitimate arrangement that asking the read scope here
  // would quietly ban.
  let where = operation === "create"
    ? undefined
    : await scopeNativeWhere(self, defName, "read", context, undefined, options);
  if (where !== false) {
    where = await scopeNativeWhere(self, defName, operation, context, where, options);
  }
  if (where === false) {
    // Not reachable from today's call sites — every one of them refuses an
    // outright deny before writing anything — but it is the other half of
    // what `scopeNativeWhere` returns, and once a row has been written
    // "no row can satisfy this" has exactly one honest answer.
    throw new ScopeEscapeError(defName, operation);
  }
  if (where === undefined) {
    // Neither half imposes a filter, so every row satisfies it by
    // construction — and reading them back would cost an extra query per
    // mutation on every unscoped deployment in exchange for no answer.
    return;
  }
  const adapter = self.getModelAdapter(defName);
  const [pk] = adapter.getPrimaryKeyNameForModel(defName);
  const ids = rows.map((r) => adapter.getValueFromInstance(r, pk));
  const found = await adapter.findAll(defName, markSystemQuery({
    ...(options?.transaction !== undefined ? {transaction: options.transaction} : {}),
    where: filterMerger(self.host, defName)(pk, ids, true, where),
    limit: ids.length,
  }));
  if (found.length < ids.length) {
    throw new ScopeEscapeError(defName, operation);
  }
}

/**
 * Hand a request context the resolved scope, for the surfaces §12 names.
 *
 * A `scopeAware` method has claimed it will apply the filter itself, and this
 * is where it gets one. Backed by the same per-request memo every other call
 * site uses, so a method that asks costs nothing extra.
 *
 * Non-enumerable, and only ever added: the context belongs to the host, and a
 * key that showed up in `Object.keys` would reach anything that serialises or
 * spreads it. Defined rather than assigned for the same reason `markSystemQuery`
 * is — a property `args` cannot carry is a property a request cannot forge.
 */
export function withScopeFor<T>(self: ScopeHost, context: T): T {
  if (!context || typeof context !== "object" || typeof self.permission?.scope !== "function") {
    return context;
  }
  const target = context as { scopeFor?: unknown };
  if (target.scopeFor !== undefined) {
    return context;
  }
  Object.defineProperty(target, "scopeFor", {
    value: (defName: string, operation: ScopeOperation = "read") =>
      resolveRowScope(self, defName, operation, context as RequestContext),
    enumerable: false, writable: false, configurable: true,
  });
  return context;
}

/**
 * If a resolved scope's `where` contains relationship quantifiers, compile them
 * to the adapter's native form and return the updated scope. If no quantifiers
 * are present, returns the scope unchanged.
 *
 * Call this after `resolveRowScope` and before merging the scope into the
 * query's portable where, so the adapter's `processFilterArgument` never sees
 * quantifier keys.
 */
export function compileScopeWhereIfNeeded(
  self: ScopeHost, defName: string, context: RequestContext,
  resolved: Exclude<ResolvedScope, false>,
): Exclude<ResolvedScope, false>;
export function compileScopeWhereIfNeeded(
  self: ScopeHost, defName: string, context: RequestContext,
  resolved: ResolvedScope,
): ResolvedScope;
export function compileScopeWhereIfNeeded(
  self: ScopeHost, defName: string, context: RequestContext,
  resolved: ResolvedScope,
): ResolvedScope {
  if (resolved === undefined || resolved === false) {
    return resolved;
  }
  if (!resolved.where) {
    return resolved;
  }
  if (!scopeWhereHasQuantifiers(resolved.where, defName, self)) {
    return resolved;
  }
  // Stamp the model name and through-scope callback onto the where, so the
  // adapter can find them in processFilterArgument.
  const where = resolved.where;
  Object.defineProperty(where, SCOPE_MODEL_NAME, {
    value: defName, enumerable: false, writable: false, configurable: true,
  });
  const scopeForThrough = async (joinModel: string): Promise<AdapterWhere | undefined> => {
    const inner = await resolveRowScope(self, joinModel, "read", context);
    if (inner === false || !inner?.where) {
      return undefined;
    }
    const adapter = self.getModelAdapter(joinModel);
    return adapter.processFilterArgument(
      inner.where, whereOperatorsFor(self.getDefinition(joinModel)), {},
    );
  };
  Object.defineProperty(where, SCOPE_THROUGH_CB, {
    value: scopeForThrough, enumerable: false, writable: false, configurable: true,
  });
  return resolved;
}

/**
 * Copy the quantifier stamps from a scope where onto a target (the merged
 * where that will reach `processFilterArgument`).
 *
 * `mergeScopeWhere` wraps in `{and: [user, scope]}` which is a fresh object
 * that doesn't carry the symbols. This propagates them.
 */
export function stampQuantifierInfo(
  target: PortableWhere, source: ResolvedScope,
): void {
  if (source === undefined || source === false || !source.where) {
    return;
  }
  const modelName = (source.where as { [SCOPE_MODEL_NAME]?: string })[SCOPE_MODEL_NAME];
  if (!modelName) {
    return;
  }
  Object.defineProperty(target, SCOPE_MODEL_NAME, {
    value: modelName, enumerable: false, writable: false, configurable: true,
  });
  const throughCb = (source.where as { [SCOPE_THROUGH_CB]?: unknown })[SCOPE_THROUGH_CB];
  if (throughCb) {
    Object.defineProperty(target, SCOPE_THROUGH_CB, {
      value: throughCb, enumerable: false, writable: false, configurable: true,
    });
  }
}

// Re-export the symbols the class needs without reaching into scope.ts itself.
export { ScopeDeniedError, ScopeEscapeError, scopeMiss };
