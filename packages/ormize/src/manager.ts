import Cache from "./utils/cache";
import pluralize from "pluralize";
import {globalKeyTargets, globalKeysFromFields} from "@azerothian/utilize/utils/global-keys";
import {relationshipAccessors} from "@azerothian/utilize/utils/relationship-accessors";
import {lowercase} from "@azerothian/utilize/utils/word";
import waterfall from "@azerothian/utilize/utils/waterfall";
import {copyDefinition} from "@azerothian/utilize/utils/copy-on-write";
import {capitalize} from "@azerothian/utilize/utils/word";
import { isStructurallyWritable } from "@azerothian/utilize/gate";
import type { Permission, PortableWhere, ResolvedScope, ScopeOperation } from "@azerothian/utilize/gate";
import { ScopeDeniedError, ScopeEscapeError, applyScopeWhere, inheritScopeMemo, markSystemQuery, scopeFor, scopeIncludePlan, scopeMiss } from "./scope";
import type { ScopeMissBehaviour } from "./scope";
import { buildScopeHooks, buildScopeInstanceHooks } from "./scope-hooks";
import { auditDefinitionScopeSurfaces, auditExtendFields, reportScopeSurfaces } from "./scope-audit";
import type { ScopeHook } from "./scope-hooks";
import { expandOrderBy, mutationInstanceMethods, whereOperatorsFor } from "@azerothian/utilize/exposed-methods";
import { Definitions, GqlizeOptions, Definition, HookMap, Relationship, Association, AnyTypedDef, ModelNameOf, IORModel, IORBase, BaseOf } from './types';
import { OrmAdapter, AdapterRow, AdapterQueryOptions, AdapterWhere, DataTypeDescriptor, NativeDataType,
  RelationshipType, RequestContext, Selection, IncludeMap, FindAllArgs, OrderEntry, GlobalKeyTargets } from '@azerothian/utilize/types/index';
import { DataTypes } from "@azerothian/utilize/types/data-type";
import type { InstanceRow, MutationApply, MutationFilter, MutationHost, MutationInput,
  MutationInputTree, ResolveOptions } from "./types/engine";
import { addProxyAccessor, btmGetter, createProxyFunction, filterMerger, joinScope, requestFrom, writeAccessors } from "./cross-adapter";
import { applyRelationshipMutations } from "./relationship-mutations";
import Events from "./events";
import OrmizeTransaction from "./transaction";
import { store, getStore } from "./context";

/** The relationship types ormize knows how to wire; `Relationship.type` is a widened string. */
const relationshipTypes: string[] = Object.values(RelationshipType);

/**
 * The relationship types whose read accessor names one row rather than many —
 * `getAuthor`, not `getAuthors`. Everything else pluralises.
 */
const SINGULAR_ACCESSOR = new Set<string>([RelationshipType.BelongsTo, RelationshipType.HasOne]);

const hookList = [
  "beforeValidate",
  "afterValidate",
  "validationFailed",
  "beforeCreate",
  "afterCreate",
  "beforeDestroy",
  "afterDestroy",
  "beforeRestore",
  "afterRestore",
  "beforeUpdate",
  "afterUpdate",
  "beforeSave",
  "afterSave",
  "beforeUpsert",
  "afterUpsert",
  "beforeBulkCreate",
  "afterBulkCreate",
  "beforeBulkDestroy",
  "afterBulkDestroy",
  "beforeBulkRestore",
  "afterBulkRestore",
  "beforeBulkUpdate",
  "afterBulkUpdate",
  "beforeFind",
  "beforeFindAfterExpandIncludeAll",
  "beforeFindAfterOptions",
  "afterFind",
  "beforeCount",
  "beforeAssociate",
  "afterAssociate",
  "beforeSync",
  "afterSync",
];

/**
 * Sequelize-*instance* hooks. `runHooks` concatenates a model's hooks with the
 * Sequelize instance's, so hooks propagate Model → Sequelize and never the
 * reverse (sequelize/lib/hooks.js). Six of these are flagged `noModel`, and the
 * other four are fired off the instance — either way `sequelize.define` accepts
 * them without complaint and files them where nothing will ever call them.
 *
 * They are therefore global-only: there is no model to scope them to, so a
 * per-definition `def.hooks.beforeQuery` is refused with a warning rather than
 * silently registered. Unlike the model hooks above they are handed Sequelize's
 * own arguments unchanged instead of the `(defName, value, ...args)` shape, and
 * what they return is discarded — Sequelize discards it too, so these hooks
 * work by mutating the options object they are given.
 */
export const sequelizeHookList = [
  "beforeDefine",
  "afterDefine",
  "beforeInit",
  "afterInit",
  "beforeConnect",
  "afterConnect",
  "beforeBulkSync",
  "afterBulkSync",
  "beforeQuery",
  "afterQuery",
];

const sequelizeHookSet = new Set(sequelizeHookList);

// gqlize-level hooks that Sequelize has no notion of — they are composed into the
// per-definition hook map (so `runHook` can fire them) but are NOT registered on
// the Sequelize model (passing an unknown hook name to `sequelize.define` throws).
const gqlizeHookList = [
  "afterCount",
];

/**
 * A lifecycle hook: it receives the value flowing through the operation plus
 * whatever the emitting site passes along, and returns the value to carry on
 * with. `any` on the tail is the variadic pass-through case — the extra
 * arguments differ per hook and ormize only relays them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- exported (part of the v6 public surface): a hook takes/returns whatever shape flows through the operation it's attached to, and the extra args are relayed verbatim, never inspected
export type HookFunction = (value: any, ...args: any[]) => any;

/**
 * A relationship after ormize has wired it, as stored in {@link Ormize.relationships}.
 *
 * `internal` says whether the source and target share an adapter — a `true`
 * relationship was handed to the adapter to create natively, and the keys below
 * it are the adapter's business. `false` means ormize resolves it itself, and
 * everything from `funcName` down is what it needs to do that.
 */
export type WiredRelationship = {
  sourceAdapter: OrmAdapter;
  targetAdapter: OrmAdapter;
  type: Relationship["type"];
  model: string;
  name: string;
  options: Relationship["options"];
  internal?: boolean;
  /** Cross-adapter only: the accessor installed on the source model (`getFiles`). */
  funcName?: string;
  foreignKey?: string;
  sourceKey?: string;
  targetKey?: string;
  /** `belongsToMany` only — see {@link Association.through}. */
  through?: string;
  otherKey?: string;
};

// The engine's own types (rows, mutation inputs, host slices) live in
// `./types/engine` so the cross-adapter and relationship-mutation modules can be
// built over them; they stay exported from here, which is where they have always
// been imported from.
export type * from "./types/engine";

export default class Ormize<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the main public class's own type parameter bound/default (v6 surface); gqlize itself instantiates `Ormize<any, IORBase>`, so this has to stay as permissive as the callers that already depend on it
  TModels extends Record<string, any> = { [name: string]: any },
  TBase extends IORBase = IORBase,
> {

  defs: Definitions;
  defsAdapters: {[name: string]: string};
  adapters: {[name: string]: OrmAdapter};
  models: TModels;
  /** Definitions queued by the typed fluent `define()`; created in `initialise()`. */
  private _pendingDefs: { def: Definition; adapterName?: string }[] = [];
  /** Join models a cross-adapter `belongsToMany` needs and nobody registered; created in `initialise()`. */
  private _joinModels: {[name: string]: {source: string, target: string, foreignKey: string, otherKey: string, sourceKey: string, targetKey: string}} = {};
  relationships: {[defName: string]: {[relName: string]: WiredRelationship}};
  /** Adapters whose instance-level hooks are already installed; see `installInstanceHooks`. */
  private _instanceHookedAdapters = new Set<string>();
  /** Whether `initialise()` has run, so a later `setPermission` knows to re-audit. */
  private _initialised = false;
  /**
   * The permission bag, for the one key the engine reads at *resolution* time.
   *
   * Every other key is consumed by gqlize while building the schema and never
   * reaches here. `scope` is the exception, which is why the engine needs the
   * bag at all — see `RESOLUTION_TIME_PERMISSION_KEYS` in `@azerothian/utilize`.
   */
  private permission: Permission | undefined;
  private onScopeMiss: ScopeMissBehaviour;
  /**
   * The row-level scope, re-imposed on the adapter's own model hooks (§13).
   *
   * Held apart from `globalHooks` on purpose. Hook ordering is load-bearing —
   * `createHook` runs definition hooks, then global ones, then these — and a map
   * nothing can register into is what makes "last" a property of the code rather
   * than of the order a deployment happened to call `addHook` in.
   */
  private scopeHooks: {[hookName: string]: ScopeHook};
  /**
   * The same arrangement one layer up, on the hooks that fire off the Sequelize
   * *instance* rather than a model — §12's runtime twin. Held apart from
   * `globalHooks` for the same reason `scopeHooks` is.
   */
  private scopeInstanceHooks: {[hookName: string]: (...args: unknown[]) => unknown};
  hooks: {[defName: string]: HookMap};
  globalHooks: {[hookName: string]: HookFunction[] | HookFunction};
  cache:  Cache;
  defaultAdapter: string | undefined;
  constructor(options: GqlizeOptions = {}) {
    this.defs = {};
    this.defsAdapters = {};
    this.adapters = {};
    this.models = {} as TModels;
    this.relationships = {};
    this.hooks = {};
    this.globalHooks = [...hookList, ...sequelizeHookList].reduce((o, hookName) => {
      // Copied, not aliased, and normalised to an array. Two defects in one
      // line: `addHook`/`unshiftHook` push onto these, so an aliased array made
      // `orm.addHook(...)` write into the caller's `options.globalHooks` — two
      // orms built from one options bag then shared a hook list. And `HookMap`
      // permits a bare function, which `.push` cannot take at all.
      const authored = (options.globalHooks || {})[hookName];
      o[hookName] = Array.isArray(authored) ? [...authored] : authored ? [authored] : [];
      return o;
    }, {} as {[hookName: string]: HookFunction[] | HookFunction});
    this.cache = new Cache();
    this.defaultAdapter = undefined;
    this.permission = options.permission;
    this.onScopeMiss = options.onScopeMiss || "empty";
    // Built unconditionally: whether a scope is configured is asked at call
    // time, so a `setPermission` after `initialise()` reaches the models that
    // already exist. Field initialisers have all run by here, so `this.host`
    // is the same object the cross-adapter and mutation modules were handed.
    this.scopeHooks = buildScopeHooks(this.host);
    this.scopeInstanceHooks = buildScopeInstanceHooks((name) => Boolean(this.defs[name]));
  }
  /**
   * Supply (or replace) the permission bag after construction.
   *
   * Hosts that compile permissions from something they only have later — a
   * config file, a Nest module — build the bag after the orm exists. The
   * sequelize adapter's `setBuildPermission` is the same pattern for the
   * build-time half.
   */
  setPermission = (permission: Permission | undefined) => {
    this.permission = permission;
    if (this._initialised) {
      // A bag that arrives after the models exist gets the same §12 audit the
      // build would have run, at the moment the scope actually starts applying.
      // Skipping it here would make the check depend on the order a host happened
      // to assemble its options in, which is precisely what it exists to stop.
      this.auditScopeSurfaces();
    }
  }
  /**
   * §12: refuse to build a scoped model whose methods the engine cannot reach.
   *
   * Runs from `initialise()` and from a later `setPermission`. A no-op unless a
   * row-level scope is configured, which is also why it is safe to call twice —
   * it reads definitions and reports, and changes nothing.
   */
  auditScopeSurfaces = () => {
    if (typeof this.permission?.scope !== "function") {
      return;
    }
    const findings = Object.keys(this.defs).reduce(
      (all: ReturnType<typeof auditDefinitionScopeSurfaces>, defName) =>
        all.concat(auditDefinitionScopeSurfaces(defName, this.defs[defName])),
      [],
    );
    reportScopeSurfaces(
      findings,
      (finding) => this.adapters[this.defsAdapters[finding.defName]]?.enforcesRowScope === true,
    );
  }
  /**
   * §12 for `options.extend.query` / `.mutation`, called by the schema builder.
   *
   * It lives here rather than in gqlize because of decision 2: `scope` is a
   * resolution-time key, and nothing under gqlize's schema builder may read
   * one. So gqlize hands over the field map and is told whether the build may
   * proceed, without ever learning why.
   *
   * Every registered adapter has to enforce for this to be a warning, not just
   * the ones with scoped models. An extend field holds the orm and can read any
   * model on it, so "is there a runtime backstop under this surface" only has a
   * reassuring answer when it has one everywhere — and a deployment that
   * mixes sequelize with valkey has a surface reaching a model with none.
   */
  auditExtendSurfaces = (target: "query" | "mutation", extendFields: {[name: string]: unknown} | undefined) => {
    if (typeof this.permission?.scope !== "function") {
      return;
    }
    const names = Object.keys(this.adapters);
    const everyAdapterEnforces = names.length > 0
      && names.every((name) => this.adapters[name]?.enforcesRowScope === true);
    reportScopeSurfaces(auditExtendFields(target, extendFields), () => everyAdapterEnforces);
  }
  /**
   * Resolve `permission.scope` for one model and operation.
   *
   * `undefined` imposes nothing, `false` denies every row, anything else is the
   * filter (and, for writes, the values) to apply. Memoised per request inside
   * {@link scopeFor} — a nested selection would otherwise re-run the predicate
   * once per parent row.
   */
  private resolveRowScope = (defName: string, operation: ScopeOperation, context: RequestContext): Promise<ResolvedScope> => {
    return scopeFor(this.permission, defName, operation, context);
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
  private reassertRowScope = async(
    adapter: OrmAdapter, defName: string, where: PortableWhere,
    whereOperators: ReturnType<typeof whereOperatorsFor>, options: AdapterQueryOptions,
    targets: (AdapterQueryOptions | undefined)[],
  ) => {
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
   * `where`. Backs {@link AdapterRoutingHost.scopedWhere}; see it for why the
   * cross-adapter accessors need the native shape rather than the portable one.
   */
  private scopeNativeWhere = async(
    defName: string, operation: ScopeOperation, context: RequestContext,
    where: AdapterWhere | undefined, options: AdapterQueryOptions | undefined,
  ): Promise<AdapterWhere | undefined | false> => {
    const resolved = await this.resolveRowScope(defName, operation, context);
    if (resolved === false) {
      return false;
    }
    if (!resolved?.where) {
      return where;
    }
    const adapter = this.getModelAdapter(defName);
    const native = await adapter.processFilterArgument(
      resolved.where, whereOperatorsFor(this.getDefinition(defName)), options || {},
    );
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
   * The portable filter a root write runs under: the caller's, ANDed with the
   * model's **read** scope as well as the operation's own. `false` when either
   * half denies outright.
   *
   * Reaching a row is a read whatever happens to it next. The nested verbs
   * (`applyRelationshipMutations`) and the cross-adapter instance checks
   * (`writable`) have both required the read half since they were written;
   * without this the root verbs would be the one path left where naming a row
   * you are not allowed to *see* is enough to write it.
   */
  private scopedWriteWhere = async(
    defName: string, operation: ScopeOperation, context: RequestContext,
    userWhere: PortableWhere | undefined,
  ): Promise<PortableWhere | undefined | false> => {
    const own = await this.resolveRowScope(defName, operation, context);
    if (own === false) {
      return false;
    }
    const read = await this.resolveRowScope(defName, "read", context);
    if (read === false) {
      return false;
    }
    return applyScopeWhere(applyScopeWhere(userWhere, read), own);
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
  private assertRowsInScope = async(
    defName: string, operation: ScopeOperation, context: RequestContext,
    rows: AdapterRow[], options: AdapterQueryOptions | undefined,
  ): Promise<void> => {
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
      : await this.scopeNativeWhere(defName, "read", context, undefined, options);
    if (where !== false) {
      where = await this.scopeNativeWhere(defName, operation, context, where, options);
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
    const adapter = this.getModelAdapter(defName);
    const [pk] = adapter.getPrimaryKeyNameForModel(defName);
    const ids = rows.map((r) => adapter.getValueFromInstance(r, pk));
    const found = await adapter.findAll(defName, markSystemQuery({
      ...(options?.transaction !== undefined ? {transaction: options.transaction} : {}),
      where: filterMerger(this.host, defName)(pk, ids, true, where),
      limit: ids.length,
    }));
    if (found.length < ids.length) {
      throw new ScopeEscapeError(defName, operation);
    }
  }
  addHook = (hookName: string, hook: HookFunction) => {
    (this.globalHooks[hookName] as HookFunction[]).push(hook);
  }
  addHookObject = (hooks: { [hookName: string]: HookFunction }) => {
    return Object.keys(hooks).forEach((h) => {
      const hook = hooks[h];
      return this.addHook(h, hook);
    });
  }
  unshiftHook = (hookName: string, hook: HookFunction) => {
    (this.globalHooks[hookName] as HookFunction[]).unshift(hook);
  }
  unshiftHookObject = (hooks: { [hookName: string]: HookFunction }) => {
    return Object.keys(hooks).forEach((h) => {
      const hook = hooks[h];
      return this.unshiftHook(h, hook);
    });
  }
  registerAdapter = <A extends OrmAdapter>(adapter: A, overrideName?: string): Ormize<TModels, BaseOf<A>> => {
    if (overrideName) {
      adapter.adapterName = overrideName;
    }
    // Without this the adapter lands under the string key "undefined" and
    // `defaultAdapter` stays unset, so the *next* `addDefinition` fails blaming
    // the definition for a name the adapter never supplied.
    if (!adapter.adapterName) {
      throw new Error("Ormize.registerAdapter: adapter has no adapterName and no override name was given");
    }
    if (!this.defaultAdapter) {
      this.defaultAdapter = adapter.adapterName;
    }
    this.adapters[adapter.adapterName] =  adapter;
    // The runtime is unchanged; the return type narrows the typesystem base URI
    // (e.g. "sequelize") from the adapter's `__base` brand so `define()` produces
    // adapter-typed models.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- ts7 needs it
    return this as unknown as Ormize<TModels, BaseOf<A>>;
  }
  /**
   * Typed, fluent, synchronous registration used to build a strongly-typed
   * `models` map. Pair with `defineModel<TInstance, TStatics>()` from the adapter:
   *
   * ```ts
   * const db = new Database()
   *   .registerAdapter(sequelizeAdapter)
   *   .define(TaskDef)
   *   .define(ItemDef);
   * await db.initialise(); await db.sync();
   * db.models.Task.create({ name: "x" });   // fully typed
   * ```
   *
   * The model is created during `initialise()` (deferred so the call chains); the
   * untyped async `addDefinition` remains available and unchanged.
   */
  define = <D extends AnyTypedDef>(def: D, adapterName?: string): Ormize<
    TModels & { [K in ModelNameOf<D>]: IORModel<TBase, [D], []> },
    TBase
  > => {
    this._pendingDefs.push({ def, adapterName });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- ts7 needs it
    return this as unknown as Ormize<
      TModels & { [K in ModelNameOf<D>]: IORModel<TBase, [D], []> },
      TBase
    >;
  }
  // eslint-disable-next-line @typescript-eslint/require-await -- must stay async: callers (and __tests__/resolution-errors.test.ts) rely on requireDefinition's throw arriving as a rejected promise, not a sync throw
  getDefinitionHooks = async(defName: string): Promise<HookMap> => {
    const def = this.requireDefinition(defName, "Ormize.getDefinitionHooks");
    return (def.hooks || def.options?.hooks) || {};
  }
  /**
   * The adapter registered under `datasource`, or a message that says which name
   * failed, where the caller got it from, and what is actually registered.
   *
   * Every adapter lookup used to be a bare `this.adapters[name]`, so a name that
   * did not resolve surfaced as `Cannot read properties of undefined` several
   * frames below the mistake — and the deferred `define()`/`initialise()` path
   * has no stack frame pointing back at the call that made it, so the message is
   * the only thing that can carry the model name. See #14.
   *
   * @param subject what the caller was doing, e.g. `Cannot add definition 'Task'`.
   * @param origin  where `datasource` came from, e.g. `from def.datasource`.
   */
  private requireAdapter(datasource: string, subject: string, origin: string): OrmAdapter {
    const adapter = this.adapters[datasource];
    if (adapter) {
      return adapter;
    }
    const known = Object.keys(this.adapters);
    throw new Error(`${subject}: no adapter named '${datasource}' is registered (${origin}). ${known.length
      ? `Registered adapters: ${known.map((n) => `'${n}'`).join(", ")}.`
      : "No adapters are registered - call registerAdapter() before addDefinition()/initialise()."}`);
  }
  /** The lenient form of {@link requireAdapter}, for the call sites that treat a missing adapter as "not applicable". */
  private findAdapter(datasource: string | undefined): OrmAdapter | undefined {
    return datasource === undefined ? undefined : this.adapters[datasource];
  }
  /** True once `defName` has been added (via `addDefinition`, or `define()` after `initialise()` drains it). */
  hasDefinition = (defName: string): boolean => {
    return Boolean(this.defs[defName]);
  }
  /** The definition of `defName`, or a message naming the models that *are* defined. */
  private requireDefinition(defName: string, subject: string): Definition {
    const def = this.defs[defName];
    if (def) {
      return def;
    }
    const known = Object.keys(this.defs);
    throw new Error(`${subject}: no model named '${defName}' has been defined. ${known.length
      ? `Defined models: ${known.map((n) => `'${n}'`).join(", ")}.`
      : "No models have been defined."}`);
  }
  /**
   * The adapter a model was defined against, checking both hops.
   *
   * "No model named X" and "model X's adapter is not registered" are different
   * mistakes with different fixes; the single unchecked index they replaced
   * produced the same `TypeError` for both.
   */
  private requireModelAdapter(defName: string, subject: string): OrmAdapter {
    this.requireDefinition(defName, subject);
    return this.requireAdapter(this.defsAdapters[defName], subject, `model '${defName}' was defined against it`);
  }
  addDefinition = async(def: Definition, adapterName?: string | undefined) => {
    const datasource = adapterName || def.datasource || this.defaultAdapter
    if(!def.name) {
      throw new Error(`Attempting to add a definition without a name`);
    }
    
    if (this.defs[def.name]) {
      throw new Error(`Model with the name ${def.name} has already been added`);
    }
    if(!datasource) {
      // With adapters registered, a falsy `datasource` really is the definition's
      // fault; with none, the definition is fine and the setup call is missing.
      if (Object.keys(this.adapters).length === 0) {
        throw new Error(`Cannot add definition '${def.name}': no adapters are registered - call registerAdapter() before addDefinition().`);
      }
      throw new Error(`Model definition does not have a adapter name defined`);
    }
    // Resolved before anything is written: a throw between the `defs` write and
    // `createModel` used to leave the manager holding a half-added model, so a
    // retry after registering the adapter hit "has already been added".
    const adapter = this.requireAdapter(datasource, `Cannot add definition '${def.name}'`,
      adapterName ? "from the adapterName argument"
        : def.datasource ? "from def.datasource"
          : "the default adapter");
    // The definition belongs to the caller; from here on the manager works on
    // its own copy. A definition module is routinely imported once and built
    // twice (two adapters, two permission profiles, an orm per test), and every
    // consumer downstream of here — `getDefinition`, the hook closures, the
    // adapter — would otherwise be handed the caller's object to write on.
    // The adapters copy again at their own boundary, because `createModel` is
    // public and gets called with no manager in front of it.
    const owned = copyDefinition(def);
    const defName = owned.name as string;
    this.defs[defName] = owned;
    this.defsAdapters[defName] = datasource
    

    this.warnDefinitionInstanceHooks(owned);

    // Native Sequelize hooks are registered on the model; gqlize-only hooks
    // (e.g. afterCount) are composed for `runHook` but withheld from the adapter.
    const nativeHooks = hookList.reduce((o, hookName) => {
      o[hookName] = this.createHook(hookName, owned);
      return o;
    }, {} as HookMap);
    this.hooks[defName] = gqlizeHookList.reduce((o, hookName) => {
      o[hookName] = this.createHook(hookName, owned);
      return o;
    }, { ...nativeHooks });

    (this.models as Record<string, unknown>)[defName] = await adapter.createModel(owned, nativeHooks);
  }

  /**
   * A definition cannot own a Sequelize-instance hook: it fires off the Sequelize
   * instance, which has no idea which model the caller had in mind. Before #45 the
   * name was accepted and filed on the model, where nothing would ever call it —
   * an audit hook that looked live and had never run. Say so instead.
   */
  private warnDefinitionInstanceHooks(def: Definition) {
    const authored = (def.hooks || def.options?.hooks) || {};
    const names = Object.keys(authored).filter((name) => sequelizeHookSet.has(name));
    if (names.length > 0) {
      console.warn( // eslint-disable-line no-console
        `Definition '${def.name}' declares Sequelize-instance hook(s): ${names.join(", ")}. ` +
        `These fire off the Sequelize instance, not a model, so they cannot be scoped to one ` +
        `definition and are ignored here. Register them globally instead — ` +
        `GqlizeOptions.globalHooks, or ormize.addHook(name, fn).`,
      );
    }
  }

  /**
   * The global-only counterpart to {@link createHook}, for the hooks that fire off
   * the Sequelize instance. Two deliberate differences: the registered hooks are
   * handed Sequelize's own arguments unchanged (there is no definition name to put
   * in front of them), and nothing is waterfalled — `runHooks` discards what a hook
   * returns, so threading return values would only let a hook that returns nothing
   * blank out the options object the next one is meant to mutate.
   *
   * Like `createHook`, this reads `globalHooks` at call time, so an `addHook` after
   * `initialise()` still takes effect.
   */
  private createInstanceHook(hookName: string): HookFunction {
    return async(...args: unknown[]) => {
      const registered = this.globalHooks[hookName];
      const hooks = Array.isArray(registered) ? registered : registered ? [registered] : [];
      for (const hook of hooks) {
        // Sequelize's own arguments, forwarded as-is; `HookFunction` names the
        // first one only because every model hook has a value to waterfall.
        await (hook as (...hookArgs: unknown[]) => unknown)(...args);
      }
      // Structurally last, and outside `globalHooks`, exactly as in `createHook`:
      // a backstop a deployment could register something after would not be one.
      const enforce = this.scopeInstanceHooks[hookName];
      if (enforce && typeof this.permission?.scope === "function") {
        await enforce(...args);
      }
    };
  }

  createHook(hookName: string, def: Definition): HookFunction {
    // `first`/`args` take their types from `HookFunction` by context (the
    // declared return type above), rather than repeating its `any`s here.
    return async(first, ...args) => {
      const hooks = await this.getDefinitionHooks(def.name as string);
      let v = first;
      if (hooks[hookName]) {
        const hook = hooks[hookName];
        if (Array.isArray(hook)) {
          if (hooks[hookName].length > 0) {
            // Forwards to `hook`, whose own return may or may not be a promise —
            // `waterfall`'s `.then()` chain adopts it either way, so this callback
            // does not need to be `async` itself.
            v = await waterfall(hook, (hook: HookFunction, f) => {
              return hook(f, ...args);
            }, v);
          }
        } else  if (hook instanceof Function) {
          v = await hook(v, ...args);
        }
      }
      if (this.globalHooks[hookName]) {
        if (this.globalHooks[hookName] instanceof Function) {
          v = await (this.globalHooks[hookName])(def.name, v, ...args);
        } else if (Array.isArray(this.globalHooks[hookName])) {
          if (this.globalHooks[hookName].length > 0) {
            v = await waterfall(this.globalHooks[hookName], (hook: HookFunction, f) => {
              return hook(def.name, f, ...args);
            }, v);
          }
        }
      }
      // §13, and structurally last: not registered through `globalHooks`, so no
      // hook a deployment adds — before or after `initialise()`, at either
      // level — can run after this one or replace it. A definition hook that
      // rewrites `where` is answered here rather than trusted.
      const enforce = this.scopeHooks[hookName];
      if (enforce && typeof this.permission?.scope === "function") {
        v = await enforce(def.name as string, v, ...args);
      }
      return v;
    };
  }

  /**
   * Run a composed lifecycle hook (definition + global) by name and return the
   * transformed value. Used to manually fire find/count hooks that Sequelize does
   * not fire itself — e.g. a child model's beforeFind/afterFind for JOIN-loaded
   * relations, or afterCount. A no-op (returns `value`) when no such hook exists.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- must stay async: declared `Promise<T>` and every caller awaits it; the plain `return value` branch would otherwise return `T` where `Promise<T>` is declared
  runHook = async <T = unknown>(defName: string, hookName: string, value: T, ...args: unknown[]): Promise<T> => {
    const hooks = this.hooks[defName];
    if (hooks && hooks[hookName]) {
      // A waterfall hook is trusted to hand back what it was given: the caller
      // named the shape, and there is nothing here that could check the claim.
      return (hooks[hookName] as HookFunction)(value, ...args);
    }
    return value;
  }

  /**
   * Fire the child model's afterFind for JOIN-loaded relations in an include plan.
   * Sequelize does not run a JOIN-included model's find hooks, so this emulates
   * them on the eager-loaded values. `separate` entries are skipped (they fired
   * natively via their own query). Recurses into nested JOIN includes.
   */
  applyEagerAfterFind = async(planMap: IncludeMap | undefined, instances: AdapterRow[], options: AdapterQueryOptions): Promise<void> => {
    if (!planMap || !Array.isArray(instances) || instances.length === 0) {
      return;
    }
    for (const relName of Object.keys(planMap)) {
      const desc = planMap[relName];
      if (!desc || desc.separate || !desc.target) {
        continue;
      }
      const nested = desc.include && desc.include[0];
      for (const row of instances) {
        // Eager-loaded values are read off the row by relationship name, and an
        // adapter row is opaque by contract — see {@link InstanceRow}.
        const inst = row as InstanceRow;
        if (!inst) {
          continue;
        }
        let val = inst[relName];
        if (val === undefined && typeof inst.get === "function") {
          val = inst.get(relName);
        }
        if (val === undefined || val === null) {
          continue;
        }
        const transformed = await this.runHook(desc.target, "afterFind", val, options);
        const finalVal = transformed === undefined ? val : transformed;
        if (finalVal !== val) {
          try {
            inst[relName] = finalVal;
            if (inst.dataValues) {
              inst.dataValues[relName] = finalVal;
            }
          } catch (e) { /* getter-only association; in-place mutations still apply */ }
        }
        if (nested) {
          await this.applyEagerAfterFind(nested, Array.isArray(finalVal) ? finalVal : [finalVal], options);
        }
      }
    }
  }
  getModel = (modelName: string) => {
    return this.getModelAdapter(modelName).getModel(modelName);
  }
  getDefinitions = () => {
    return this.defs;
  }
  getDefinition = (defName: string) => {
    return this.defs[defName];
  }
  getGlobalKeys = (defName: string) => globalKeysFromFields(this.getFields(defName));
  /**
   * The type each global key points at, so an id codec can reject a global id
   * minted for some other type. Paired with {@link getGlobalKeys}: same fields,
   * same order of derivation, one keyed by name instead of listed.
   */
  getGlobalKeyTargets = (defName: string) => globalKeyTargets(this.getFields(defName), defName);
  getFields = (defName: string) => {
    const adapter = this.getModelAdapter(defName);
    //TODO: add cross adapter fields
    return adapter.getFields(defName);
  }
  /**
   * Associations for a model, merging the adapter's native ones with the
   * cross-adapter relationships ormize wires itself. An adapter only knows about
   * relationships it created (`createRelationship`), so a relationship whose
   * target lives on another adapter would otherwise be invisible to callers such
   * as gqlize's schema builder. Cross-adapter entries are flagged with
   * `crossAdapter: true` so consumers can tell they cannot be eager-loaded.
   */
  getAssociations = (defName: string): {[relName: string]: Association} => {
    const adapter = this.getModelAdapter(defName);
    const associations = {...adapter.getAssociations(defName)};
    const rels = this.relationships[defName] || {};
    for (const relName of Object.keys(rels)) {
      const rel = rels[relName];
      if (rel.internal !== false) {
        continue;
      }
      // An adapter that derives associations from the raw definition (rather than
      // from what it actually created) will already list a cross-adapter
      // relationship, but without the join keys or the flag that tells callers it
      // must not be resolved locally — so overlay ours on top either way.
      associations[relName] = {
        ...associations[relName],
        ...this.buildCrossAdapterAssociation(defName, rel),
      };
    }
    return associations;
  }
  /** Build an {@link Association} descriptor for an ormize-wired cross-adapter relationship. */
  private buildCrossAdapterAssociation(defName: string, rel: WiredRelationship): Association {
    return {
      name: rel.name,
      target: rel.model,
      source: defName,
      // Only a cross-adapter relationship is described this way, and wiring one
      // resolves every join key and the accessor name before it gets here.
      foreignKey: rel.foreignKey as string,
      sourceKey: rel.sourceKey as string,
      targetKey: rel.targetKey as string,
      associationType: rel.type,
      crossAdapter: true,
      through: rel.through,
      otherKey: rel.otherKey,
      accessors: relationshipAccessors(rel.name, rel.funcName),
    };
  }
  /**
   * The adapter a model was defined against.
   *
   * Throws rather than returning `undefined` for an unknown model: the declared
   * return type has always been non-optional and every caller dereferences it
   * unguarded, so a miss became a `TypeError` on `undefined` inside whichever
   * adapter method was reached first. See #14.
   */
  getModelAdapter = (modelName: string) => {
    return this.requireModelAdapter(modelName, "Ormize.getModelAdapter");
  }
  /**
   * Re-point an options (or context) object's transaction handle from one model's
   * adapter at another's.
   *
   * A transaction handle is opened by, and only meaningful to, the adapter that
   * created it — handing a Sequelize transaction to Valkey, or the reverse, at
   * best does nothing and at worst throws deep inside the driver. Every hop
   * across an adapter boundary (only a cross-adapter relationship makes one)
   * therefore swaps in the coordinator's handle for the adapter about to be
   * called, or drops it when there is no coordinator to ask.
   */
  private optionsForAdapter = async <T extends AdapterQueryOptions | undefined>(fromDefName: string, toDefName: string, options: T): Promise<T> => {
    if (this.defsAdapters[fromDefName] === this.defsAdapters[toDefName] || !options || options.transaction === undefined) {
      return options;
    }
    const handle = await getStore()?.transaction?.handleFor(this.defsAdapters[toDefName]);
    const o = inheritScopeMemo(options, Object.assign({}, options));
    if (handle === undefined) {
      delete o.transaction;
    } else {
      o.transaction = handle;
    }
    // Same keys as what came in, one of them re-pointed — so the caller keeps the
    // certainty it had about whether it handed over an options bag at all.
    return o;
  }
  /**
   * Convert an adapter-native type (e.g. `Sequelize.DataTypes.STRING`) into the
   * abstract ormize `DataType` descriptor via the chosen adapter (defaults to the
   * sole/first registered adapter). e.g. `mapDataType(Sequelize.DataTypes.STRING)`
   * → `{ type: DataType.String }`.
   */
  mapDataType = (nativeType: NativeDataType, adapterName?: string): DataTypeDescriptor => {
    const name = adapterName || this.defaultAdapter || Object.keys(this.adapters)[0];
    const adapter = name ? this.adapters[name] : undefined;
    if (!adapter) {
      throw new Error("Ormize.mapDataType: no adapter registered");
    }
    return adapter.mapDataType(nativeType);
  }
  /**
   * Everything about `rel` that can be judged before any of it is wired: that it
   * has a name and a known type, that its target exists, and - for a
   * cross-adapter relationship, whose keys nobody can synthesize - that the
   * columns it names are really there.
   *
   * Up front and covering both branches on purpose. The type guard used to sit
   * below the same-adapter early return (so it only ever ran for cross-adapter
   * relationships, leaving the same-adapter case to whichever adapter happened to
   * validate), a missing `rel.name` was silently stored under the key
   * `"undefined"`, and a missing target crashed inside `getPrimaryKeyNameForModel`
   * after the relationship had already been recorded. See #14.
   */
  private validateRelationship(defName: string, rel: Relationship) {
    const subject = `Relationship '${defName}.${rel.name}'`;
    if (!rel.name) {
      throw new Error(`Relationship on '${defName}' targeting '${rel.model}' has no name.`);
    }
    if (!relationshipTypes.includes(rel.type)) {
      throw new Error(`${subject}: unknown relationship type '${rel.type}'. Expected one of ${relationshipTypes.map((t) => `'${t}'`).join(", ")}.`);
    }
    if (!rel.model) {
      throw new Error(`${subject} (${rel.type}) does not name a target model.`);
    }
    this.requireDefinition(rel.model, `${subject} (${rel.type}) targets model '${rel.model}', which has not been defined`);
  }
  /**
   * The keys of every cross-adapter relationship, checked against the models they
   * sit on. No JOIN spans two datastores, so ormize resolves the pair itself by
   * reading these columns - and unlike a native association it cannot create the
   * foreign key, which has to be declared on the target definition by hand. An
   * unchecked name wired cleanly and then failed at the first query as a raw
   * driver error (`no such column: Bar.nopeId`) naming neither the relationship
   * nor the option that produced it. See #14.
   *
   * A pass at the end of `initialise()` rather than a check inside
   * `processRelationship`, because a column is not necessarily there yet when the
   * relationship naming it is wired: relationships are processed concurrently,
   * and a same-adapter association on the target creates its foreign key as a
   * side effect. Only once every relationship is wired - and every generated join
   * model defined - does `getFields` answer for the finished schema.
   */
  private validateCrossAdapterKeys() {
    for (const defName of Object.keys(this.relationships)) {
      for (const relName of Object.keys(this.relationships[defName])) {
        const rel = this.relationships[defName][relName];
        if (rel.internal !== false) {
          continue;
        }
        const subject = `Cross-adapter relationship '${defName}.${relName}' (${rel.type})`;
        // `belongsTo` keeps the foreign key on the source and points at the
        // target's `targetKey`; `hasMany`/`hasOne` keep it on each target and
        // point back at the source's `sourceKey`. `belongsToMany` keeps it on
        // neither - both join columns live on the through model.
        const checks: [string, string | undefined, string][] = rel.type === "belongsToMany"
          ? [
            [defName, rel.sourceKey, "sourceKey"],
            [rel.model, rel.targetKey, "targetKey"],
            [rel.through as string, rel.foreignKey, "foreignKey (on the join model)"],
            [rel.through as string, rel.otherKey, "otherKey (on the join model)"],
          ]
          : rel.type === "belongsTo"
            ? [[defName, rel.foreignKey, "foreignKey"], [rel.model, rel.targetKey, "targetKey"]]
            : [[defName, rel.sourceKey, "sourceKey"], [rel.model, rel.foreignKey, "foreignKey"]];
        for (const [modelName, keyName, option] of checks) {
          if (!keyName) {
            continue;
          }
          const fields = this.getModelAdapter(modelName).getFields(modelName);
          if (fields[keyName]) {
            continue;
          }
          throw new Error(`${subject} declares ${option} '${keyName}', but model '${modelName}' has no such field. `
            + "A cross-adapter key must be declared on the definition - ormize cannot create it. "
            + `Fields on '${modelName}': ${Object.keys(fields).map((f) => `'${f}'`).join(", ")}.`);
        }
      }
    }
  }
  processRelationship = async(def: Definition, sourceAdapter: OrmAdapter , rel: Relationship) => {
    if(!def.name) {
      throw new Error(`Attempting to use a definition without a name: ${JSON.stringify(def)}`);
    }
    this.validateRelationship(def.name, rel);
    // Normalised once: the cross-adapter branch used to destructure `rel.options`
    // blind, and an omitted `options` is a legitimate shape for a same-adapter
    // relationship that leaves every key to the adapter.
    rel = rel.options ? rel : {...rel, options: {}};
    const targetAdapter = this.getModelAdapter(rel.model);
    if (!this.relationships[def.name]) {
      this.relationships[def.name] = {};
    }
    if (this.relationships[def.name][rel.name]) {
      throw new Error(`Unable to continue duplicate relationships: ${def.name} - ${rel.name}`);
    }
    this.relationships[def.name][rel.name] = {
      targetAdapter,
      sourceAdapter,
      type: rel.type,
      model: rel.model,
      name: rel.name,
      options: rel.options,
    };
    const {foreignKey} = rel.options;
    if (targetAdapter === sourceAdapter) {
      this.relationships[def.name][rel.name].internal = true;
      //TODO: populate foreignKey/sourceKeys if not provided
      await sourceAdapter.createRelationship(def.name, rel.model, rel.name, rel.type, rel.options);
      return undefined;

    }
    this.relationships[def.name][rel.name].internal = false;
    const modelClass = sourceAdapter.getModel(def.name);
    const sourcePrimaryKeyName = sourceAdapter.getPrimaryKeyNameForModel(def.name)[0]; //TODO: check for edge case with multi primary key table
    // Singular for the -one variants, plural for the -many. `validateRelationship`
    // above has already rejected any other type, so there is no fallback arm to
    // write — the `default:` that used to be here was unreachable.
    const base = `get${capitalize(rel.model)}`;
    const funcName = SINGULAR_ACCESSOR.has(rel.type)
      ? pluralize.singular(base)
      : pluralize.plural(base);
    this.relationships[def.name][rel.name].funcName = funcName;
    if (!foreignKey) {
      throw new Error(`For cross adapter relationships you must define a foreign key ${def.name} (${rel.type}) ${rel.model}: ${rel.name}`);
    }
    const sourceKey = rel.options?.sourceKey || sourcePrimaryKeyName;
    // `targetKey` is the column on the target that a belongsTo points at; it
    // defaults to the target's primary key.
    const targetKey = rel.options?.targetKey || targetAdapter.getPrimaryKeyNameForModel(rel.model)[0];
    Object.assign(this.relationships[def.name][rel.name], {foreignKey, sourceKey, targetKey});
    if (rel.type === "belongsToMany") {
      Object.assign(this.relationships[def.name][rel.name], this.resolveCrossAdapterJoin(def.name, rel, {foreignKey, sourceKey, targetKey}));
    }
    const association = this.buildCrossAdapterAssociation(def.name, this.relationships[def.name][rel.name]);
    if (rel.type === "belongsToMany") {
      // The pair is resolved from the join model rather than from a key on either
      // record, so there is no single find to proxy — see {@link btmGetter}.
      addProxyAccessor(sourceAdapter, def.name, modelClass, funcName, btmGetter(this.host, association));
    } else {
      // `createFunctionForFind` is synchronous — it returns the find function
      // itself, not a promise of one.
      const findFunc = targetAdapter.createFunctionForFind(rel.model);
      // Captured out of the closure: the `!def.name` guard at the top of this
      // method narrows the property, but that narrowing does not survive into a
      // callback.
      const defName = def.name;
      const adaptOptions = (options: AdapterQueryOptions | undefined) => this.optionsForAdapter(defName, rel.model, options);
      // F5. The proxy runs the target's find directly, so the target's read scope
      // has to travel with it — the accessor is an ordinary instance method and
      // anything holding a source row can call it.
      const scopedWhere = (options: AdapterQueryOptions | undefined) =>
        this.scopeNativeWhere(rel.model, "read", requestFrom(options), options?.where, options);
      // The proxy reads its join value off `this`, which is a *source* instance —
      // so the read goes through the source adapter, not the target's. `belongsTo`
      // keeps the key on the source and points at the target's `targetKey`; the
      // other two keep it on each target and point back at the source's `sourceKey`,
      // differing only in whether one row or many come back.
      const proxy = rel.type === "belongsTo"
        ? createProxyFunction(sourceAdapter, foreignKey, targetKey, true, findFunc, adaptOptions, scopedWhere)
        : createProxyFunction(sourceAdapter, sourceKey, foreignKey, rel.type === "hasOne", findFunc, adaptOptions, scopedWhere);
      addProxyAccessor(sourceAdapter, def.name, modelClass, funcName, proxy);
    }
    for (const [accessor, func] of Object.entries(writeAccessors(this.host, association, sourceAdapter, targetAdapter))) {
      addProxyAccessor(sourceAdapter, def.name, modelClass, accessor, func);
    }
    return undefined;
  }
  /**
   * Resolve the join model of a cross-adapter `belongsToMany` and the column on it
   * that points at the target (`foreignKey` points at the source).
   *
   * The join has to physically live in exactly one datastore. An unnamed one is
   * named after the pair — sorted, so both sides of a reciprocal pair agree on it
   * regardless of which is wired first — and one that is not a registered model
   * gets generated (see {@link generateJoinModels}). A generated join model is
   * queued rather than created here: relationships are wired concurrently, so
   * both sides would otherwise race to define it.
   */
  private resolveCrossAdapterJoin(defName: string, rel: Relationship, keys: {foreignKey: string, sourceKey: string, targetKey: string}) {
    const {through} = rel.options || {};
    const throughName = (typeof through === "string" ? through : through?.model)
      || [defName, rel.model].sort().join("");
    const otherKey = rel.options?.otherKey
      || (typeof through === "object" ? through?.otherKey : undefined)
      || this.deriveOtherKey(rel.model, throughName)
      || `${lowercase(rel.model)}Id`;
    if (!this.defs[throughName] && !this._joinModels[throughName]) {
      this._joinModels[throughName] = {source: defName, target: rel.model, otherKey, ...keys};
    }
    return {through: throughName, otherKey};
  }
  /**
   * Define the join models a cross-adapter `belongsToMany` needed and the caller
   * did not register, on the first registered adapter.
   *
   * Run in one pass after every relationship is wired: the column types are read
   * off the keys they point at, and an adapter only knows a model's full field
   * list (foreign keys included) once its relationships have been created.
   */
  private async generateJoinModels() {
    const adapterName = this.defaultAdapter || Object.keys(this.adapters)[0];
    for (const name of Object.keys(this._joinModels)) {
      const join = this._joinModels[name];
      delete this._joinModels[name];
      if (this.defs[name]) {
        continue;
      }
      await this.addDefinition({
        name,
        // No primary key is declared: each adapter synthesizes its own (an
        // auto-increment `id` on both of the shipped ones). Both join columns are
        // indexed — a key-value adapter can only answer a `where` from an index.
        define: {
          [join.foreignKey]: {type: this.keyType(join.source, join.sourceKey), allowNull: true, index: true, writable: true},
          [join.otherKey]: {type: this.keyType(join.target, join.targetKey), allowNull: true, index: true, writable: true},
        },
        // `paranoid: false` explicitly, not by omission: an adapter-level
        // default (Sequelize's `defaultModel`) would otherwise reach this
        // generated table, and `{paranoid: true, timestamps: false}` is a
        // combination Sequelize accepts and then silently ignores — leaving a
        // model that claims to soft delete and does not.
        options: {timestamps: false, paranoid: false},
        relationships: [],
      }, adapterName);
    }
  }
  /** The abstract type of a model's key column, for a generated join model to mirror. */
  private keyType(defName: string, keyName: string): DataTypeDescriptor {
    const adapter = this.getModelAdapter(defName);
    const field = adapter.getFields(defName)[keyName];
    return field?.type ? adapter.mapDataType(field.type) : DataTypes.String;
  }
  /** The reciprocal `belongsToMany`'s foreign key — the join column pointing at the target. */
  private deriveOtherKey(targetName: string, throughName: string): string | undefined {
    const reciprocal = (this.defs[targetName]?.relationships || []).find((r: Relationship) => {
      const t = typeof r.options?.through === "string" ? r.options.through : r.options?.through?.model;
      return r.type === "belongsToMany" && t === throughName;
    });
    return reciprocal?.options?.foreignKey;
  }
  /**
   * The slice of this manager the cross-adapter and mutation modules are written
   * against. An object literal rather than `this` because `optionsForAdapter` is
   * private, and a private member cannot satisfy a structurally-required public
   * one — see {@link MutationHost}.
   */
  private host: MutationHost = {
    getModelAdapter: (modelName) => this.getModelAdapter(modelName),
    optionsForAdapter: (fromDefName, toDefName, options) => this.optionsForAdapter(fromDefName, toDefName, options),
    getAssociations: (defName) => this.getAssociations(defName),
    getDefinition: (defName) => this.getDefinition(defName),
    getGlobalKeys: (defName) => this.getGlobalKeys(defName),
    getGlobalKeyTargets: (defName) => this.getGlobalKeyTargets(defName),
    processInputs: (defName, input, args, context, info, model, operation) => this.processInputs(defName, input, args, context, info, model, operation),
    processCreate: (defName, source, args, context, selection) => this.processCreate(defName, source, args, context, selection),
    processDelete: (defName, source, args, context, selection) => this.processDelete(defName, source, args, context, selection),
    processRelationshipMutation: (defName, source, input, context, selection) => this.processRelationshipMutation(defName, source, input, context, selection),
    resolveScope: (defName, operation, context) => this.resolveRowScope(defName, operation, context),
    scopeMiss: (defName, operation) => scopeMiss(defName, operation, this.onScopeMiss),
    scopedWhere: (defName, operation, context, where, options) => this.scopeNativeWhere(defName, operation, context, where, options),
    assertRowsInScope: (defName, operation, context, rows, options) => this.assertRowsInScope(defName, operation, context, rows, options),
  };
  getValueFromInstance = (defName: string, data: AdapterRow, keyName: string): unknown => {
    if (!data) {
      return undefined;
    }
    const adapter = this.getModelAdapter(defName);
    return adapter.getValueFromInstance(data, keyName);
  }
  initialise = async() => {
    // Create any models queued by the fluent `define()` before wiring relationships.
    if (this._pendingDefs.length > 0) {
      const pending = this._pendingDefs;
      this._pendingDefs = [];
      for (const { def, adapterName } of pending) {
        await this.addDefinition(def, adapterName);
      }
    }
    await Promise.all(Object.keys(this.defs).map((defName) => {
      const def = this.defs[defName];
      const sourceAdapter = this.getModelAdapter(defName);
      return waterfall(def.relationships, async(rel: Relationship) =>
        this.processRelationship(def, sourceAdapter, rel));
    }));
    await this.generateJoinModels();
    this.validateCrossAdapterKeys();
    await Promise.all(Object.keys(this.adapters).map((adapterName) => {
      const adapter = this.adapters[adapterName];
      this.installInstanceHooks(adapterName, adapter);
      return adapter.initialise();
    }));
    this._initialised = true;
    // Last, deliberately: a build that is broken for an ordinary reason should
    // say so before it starts talking about permissions.
    this.auditScopeSurfaces();
  }

  /**
   * Register the composed Sequelize-instance hooks on an adapter's underlying
   * connection. Once per adapter: `initialise()` is callable more than once and
   * `sequelize.addHook` appends, so without the guard every extra call would fire
   * an audit hook another time per query.
   */
  private installInstanceHooks(adapterName: string, adapter: OrmAdapter) {
    if (!adapter.installInstanceHooks || this._instanceHookedAdapters.has(adapterName)) {
      return;
    }
    this._instanceHookedAdapters.add(adapterName);
    adapter.installInstanceHooks(sequelizeHookList.reduce((o, hookName) => {
      o[hookName] = this.createInstanceHook(hookName);
      return o;
    }, {} as HookMap));
  }
  reset = async(options?: AdapterQueryOptions) => {
    await Promise.all(Object.keys(this.adapters).map((adapterName) => {
      const adapter = this.adapters[adapterName];
      return adapter.reset(options);
    }));
  }
  sync = async(options?: AdapterQueryOptions) => {
    await Promise.all(Object.keys(this.adapters).map((adapterName) => {
      const adapter = this.adapters[adapterName];
      return adapter.sync(options);
    }));
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
  private withScopeFor = <T>(context: T): T => {
    if (!context || typeof context !== "object" || typeof this.permission?.scope !== "function") {
      return context;
    }
    const target = context as { scopeFor?: unknown };
    if (target.scopeFor !== undefined) {
      return context;
    }
    Object.defineProperty(target, "scopeFor", {
      value: (defName: string, operation: ScopeOperation = "read") =>
        this.resolveRowScope(defName, operation, context as RequestContext),
      enumerable: false, writable: false, configurable: true,
    });
    return context;
  }
  resolveClassMethod = async(defName: string, methodName: string, args: unknown, context: RequestContext,
    before?: (args: unknown, context: RequestContext) => unknown,
    after?: (result: unknown, context: RequestContext) => unknown) => {
    const Model = this.getModel(defName);
    context = this.withScopeFor(context);
    if(before) {
      args = await before(args, context);
    }
    let result = await Model[methodName](args, context);
    if(after) {
      result = await after(result, context);
    }
    return result;
  }
  isTypeOf = (defName: string, _definition: Definition, value: unknown): boolean => {
    // `getModel` returns the adapter's model handle, which for a class-based
    // adapter is the constructor `instanceof` needs.
    // Never constructed — only used for `instanceof` below — so the constructor's
    // own argument types don't matter here.
    const Model = this.getModel(defName) as unknown as abstract new (...args: unknown[]) => unknown;
    const isType = value instanceof Model;
    return isType;
  }

  // ---------------------------------------------------------------------------
  // Resolution engine (graphql-free). The GraphQL `info` coupling and relay
  // global-id translation are injected via the `Selection` argument, so gqlize
  // (and a future REST binding) can share this engine. gqlize builds the
  // `Selection` from execution `info`; here the engine only reads its fields.
  // ---------------------------------------------------------------------------

  /**
   * A cross-adapter relationship is just a root query on the target model scoped
   * to the join key — the target's adapter cannot see the source's rows, so there
   * is nothing to JOIN and no accessor to call. Routing it through
   * {@link resolveFindAll} keeps `where`, ordering, pagination, count-only and
   * the target model's own hooks behaving exactly as they do at the root.
   */
  private resolveCrossAdapterRelationship = async(defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection) => {
    const scope = await joinScope(this.host, association, source, context);
    const empty = scope.value === undefined || scope.value === null
      || (Array.isArray(scope.value) && scope.value.length === 0);
    if (scope.field === undefined || empty) {
      return {total: 0, models: []};
    }
    // The query runs on the target's adapter, so any transaction handle carried by
    // the (source-side) context has to be swapped for that adapter's own.
    const targetContext = await this.optionsForAdapter(association.source, defName, context);
    return this.resolveFindAll(defName, source, args, targetContext, selection, scope);
  }
  resolveManyRelationship = async(defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection) => {
    if (association.crossAdapter) {
      // Routed through `resolveFindAll`, which scopes the target itself.
      return this.resolveCrossAdapterRelationship(defName, association, source, args, context, selection);
    }
    // F4. `defName` is the *target* model here, and this is the branch that runs
    // when the relationship was not eager-loaded: the accessor query and the
    // `total` count both derive from `args.where`, so merging here covers both.
    // The eager branch is covered upstream, in the include plan.
    const rowScope = await this.resolveRowScope(defName, "read", context);
    if (rowScope === false) {
      return { total: 0, models: [] };
    }
    const options = createResolveContext(context, selection, source);
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    // Copy-on-write from here: `args` is the caller's bag, and the scope merge
    // and the order expansion both used to write onto it in place. Nothing
    // downstream needs the caller to see the rewrite — everything that consumes
    // it is handed `a` explicitly.
    let a = args;
    if (rowScope?.where) {
      a = {...a, where: applyScopeWhere(a.where as PortableWhere | undefined, rowScope)};
    }
    a = this.expandComputedOrder(defName, a, {context, info: selection?.raw});
    const offset = cursorOffset(args);
    // Count-only: the nested connection selects `total` but not `edges`/rows — the
    // adapter runs a count instead of a findAll (fires beforeCount natively); fire
    // afterCount here.
    const countOnly = Boolean(selection?.countOnly);
    const result = await adapter.resolveManyRelationship(defName, association, source, {
      args: a, offset, selection, whereOperators: whereOperatorsFor(definition), options, countOnly,
      selectedFields: selection?.fields, runHook: this.runHook,
    });
    if (countOnly && result) {
      result.total = await this.runHook(defName, "afterCount", result.total, options);
    }
    // afterFind for JOIN-eager loads is fired centrally by resolveFindAll's
    // post-pass (which knows JOIN vs separate authoritatively). A fresh accessor
    // query and the separate path both fire it natively.
    return result;
  }
  resolveSingleRelationship = async(defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection) => {
    if (association.crossAdapter) {
      // `countOnly` is inferred from a connection's selection set; a singular
      // relation has no `edges`, so the inference misreads it. It always wants
      // the row.
      const single = selection ? {...selection, countOnly: false} : selection;
      const {models} = await this.resolveCrossAdapterRelationship(defName, association, source, {...args, first: 1}, context, single);
      return models[0] || null;
    }
    const rowScope = await this.resolveRowScope(defName, "read", context);
    if (rowScope === false) {
      return null;
    }
    const adapter = this.getModelAdapter(defName);
    const options = createResolveContext(context, selection, source);
    if (rowScope?.where) {
      // A singular relationship never reads `args.where` — the accessor is called
      // with the options bag alone — so the scope goes there, already translated
      // into the backend's vocabulary. The eager branch ignores the bag entirely
      // and is covered upstream by the include plan.
      //
      // Written in place, and not a caller's object: `createResolveContext`
      // builds a fresh bag on every call.
      options.where = await adapter.processFilterArgument(
        applyScopeWhere(options.where as PortableWhere | undefined, rowScope),
        whereOperatorsFor(this.getDefinition(defName)),
        options,
      );
    }
    // afterFind for JOIN-eager single relations is fired by resolveFindAll's post-pass.
    return adapter.resolveSingleRelationship(defName, association, source, {args, selection, context, options});
  }
  /**
   * @param scope optional `{field, value}` equality filter merged into the built
   * query on top of the caller's `where`. Used to scope a cross-adapter
   * relationship to its join key.
   */
  /**
   * Rewrite any computed `orderBy` entry into the real column ordering it stands
   * for, at the root and at every level of the include plan.
   *
   * A generated `<method>ASC` enum member carries the method's own name rather
   * than a column, so this lookup is what makes it mean anything — deliberately
   * at runtime, so a materialized schema snapshot picks up a changed declaration
   * for free. Push-down only: the expansion produces query fragments, never an
   * in-memory post-sort (which would break `first`/`last`, cursor offsets and
   * `total`).
   */
  private expandComputedOrder = (defName: string, a: FindAllArgs, ctx: {context?: unknown, info?: unknown}): FindAllArgs => {
    const definition = this.getDefinition(defName);
    const orderBy = expandOrderBy(definition, a.orderBy as OrderEntry[] | undefined, ctx);
    const include = this.expandComputedIncludeOrder(a.include as IncludeMap[] | IncludeMap | undefined, ctx);
    if (orderBy === a.orderBy && include === a.include) {
      return a;
    }
    return {...a, orderBy, include};
  }
  /**
   * The same expansion, one level down and at every level below it.
   *
   * Returns a new plan rather than writing on the one it is given — the rule
   * {@link scopeIncludePlan} already states, and for a sharper reason here. An
   * include descriptor declared on a definition (`expose.instanceMethods.query.
   * <m>.include`) reaches this method as the definition's *own* object: the
   * merge path hands it through by identity when only one side declares a
   * relation. Writing the expansion onto it rewrote the declaration itself, so
   * the first request's ordering was frozen into the definition for the life of
   * the process and a context-dependent `orderBy` never ran a second time.
   *
   * Copy-on-write, not copy: `expandOrderBy` returns its input unchanged when
   * there is nothing to expand, so the steady state — every request that orders
   * by a real column — allocates nothing on what is a per-parent-row path.
   */
  private expandComputedIncludeOrder = (
    include: IncludeMap[] | IncludeMap | undefined,
    ctx: {context?: unknown, info?: unknown},
  ): IncludeMap[] | IncludeMap | undefined => {
    if (!include) {
      return include;
    }
    const expandMap = (map: IncludeMap): IncludeMap => {
      let out: IncludeMap | undefined;
      for (const relName of Object.keys(map)) {
        const descriptor = map[relName];
        // Undefined for a target this engine does not own, which has nothing to
        // expand against. `getDefinition` indexes and does not throw — the
        // try/catch this replaces could never fire.
        const targetDef = this.getDefinition(descriptor.target);
        const orderBy = expandOrderBy(targetDef, descriptor.orderBy, ctx);
        const nested = this.expandComputedIncludeOrder(descriptor.include, ctx);
        if (orderBy === descriptor.orderBy && nested === descriptor.include) {
          continue;
        }
        out = out || {...map};
        out[relName] = {...descriptor, orderBy, include: nested as IncludeMap[] | undefined};
      }
      return out || map;
    };
    if (!Array.isArray(include)) {
      return expandMap(include);
    }
    let changed = false;
    const mapped = include.map((map) => {
      const expanded = expandMap(map);
      changed = changed || expanded !== map;
      return expanded;
    });
    return changed ? mapped : include;
  }
  resolveFindAll = async(defName: string, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection, scope?: {field: string, value: unknown}) => {
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const options = createResolveContext(context, selection, source);
    // Copy-on-write from here: `args` is the caller's bag. Everything that
    // consumes the rewritten form is handed `a` explicitly, so nothing needs the
    // caller's object to change underneath it.
    let a = args;
    const selectedFields = selection?.fields;
    // The eager-include plan is built by the caller (gqlize, from the GraphQL
    // selection set) and passed via `selection.include`; apply it when the args
    // don't already carry one.
    if (selection?.include && !a.include) {
      a = {...a, include: selection.include};
    }
    // F4. An eagerly-loaded relationship is fetched by *this* query, so its own
    // resolver never gets a filter in edgeways — the include plan is the only
    // place its model's scope can be applied.
    const scopedInclude = await scopeIncludePlan(a.include as IncludeMap[] | undefined, (targetName) => this.resolveRowScope(targetName, "read", context));
    if (scopedInclude !== a.include) {
      a = {...a, include: scopedInclude};
    }
    a = this.expandComputedOrder(defName, a, {context, info: selection?.raw});
    // Row-level scope, merged while the filter is still in the caller's
    // vocabulary. That is also what gives the count the same filter, since
    // `processListArgsToOptions` derives `countOptions` from these args — a
    // scope applied only to the fetch leaves `total` counting rows the caller
    // is not allowed to see.
    const rowScope = await this.resolveRowScope(defName, "read", context);
    if (rowScope === false) {
      // Denied outright. There is no portable filter for "match nothing" (§9.4
      // of the design rejects `{in: []}` as one), and no reason to ask the
      // backend: an empty page is exactly what a caller whose rows do not exist
      // already sees, which is what makes the two indistinguishable.
      return { total: 0, models: [] };
    }
    if (rowScope?.where) {
      a = {...a, where: applyScopeWhere(a.where as PortableWhere | undefined, rowScope)};
    }
    const offset = cursorOffset(args);
    const {getOptions, countOptions} = await adapter.processListArgsToOptions(defName, {
      args: a, offset, selection, whereOperators: whereOperatorsFor(definition), options, selectedFields,
      runHook: this.runHook,
    });
    if (scope) {
      if (!adapter.mergeFilterStatement) {
        throw new Error(`Adapter '${adapter.adapterName}' cannot scope a query and so cannot be the target of a cross-adapter relationship: it does not implement mergeFilterStatement`);
      }
      getOptions.where = adapter.mergeFilterStatement(scope.field, scope.value, true, getOptions.where);
      if (countOptions) {
        countOptions.where = adapter.mergeFilterStatement(scope.field, scope.value, true, countOptions.where);
      }
    }
    if (definition.before) {
      await definition.before({
        params: getOptions, args, context, info: selection?.raw,
        modelDefinition: definition,
        type: Events.QUERY,
      });
      if (rowScope?.where) {
        // F3. The hook is handed the built options and mutates them in place, so
        // `params.where = {...}` drops the scope entirely. This is not a remote
        // possibility: `before` + `Events.QUERY` is where row filtering lived
        // before this key existed, so the deployments most likely to have such a
        // hook are exactly the ones whose hook rewrites `where`.
        await this.reassertRowScope(
          adapter, defName, rowScope.where, whereOperatorsFor(definition), options,
          [getOptions, countOptions],
        );
      }
    }
    // An exposed method's `input` runs last, after the model-wide `before`, so it
    // sees the final options rather than having its work overwritten by them.
    // One run per selection occurrence, in selection order.
    const optionHooks = selection?.optionHooks || [];
    for (const hook of optionHooks) {
      await hook(getOptions, context);
    }
    if (optionHooks.length > 0 && countOptions) {
      // A backend without an inline count answers `total` from a second query.
      // A hook that narrowed the row set has to narrow that one too, or `total`
      // reports a page size the connection never returns. Only the two keys that
      // decide *which* rows match are carried over — `limit`/`order` mean nothing
      // to a count, and copying them would corrupt it.
      countOptions.where = getOptions.where;
      countOptions.include = getOptions.include;
    }
    // Count-only: the connection selects `total` but not `edges`/rows — skip the
    // findAll and run a count (fires beforeCount natively + afterCount manually).
    if (selection?.countOnly) {
      // Derive the count bag by *removing* the keys that mean nothing to a count,
      // rather than whitelisting the few that do. A whitelist silently drops any
      // adapter-specific key that decides which rows match — Sequelize's
      // `paranoid` is one — and then `total` answers from a different row set
      // than `edges` would have returned.
      const {limit: _l, offset: _o, order: _ord, attributes: _a, ...countable} = getOptions;
      const countOnlyOptions = countOptions || Object.assign({}, countable, {
        include: (getOptions.include || []).filter((i: {required?: boolean, separate?: boolean}) => i.required && !i.separate),
      });
      let total = await adapter.count(defName, countOnlyOptions);
      total = await this.runHook(defName, "afterCount", total, countOnlyOptions);
      return { total, models: [] };
    }
    const models = (await adapter.findAll(defName, getOptions)).filter((m) => (m !== undefined && m !== null));

    // Sequelize does not fire a child model's afterFind for JOIN-loaded includes.
    // Walk the built include plan and fire afterFind for each JOIN (non-separate)
    // relation on the loaded instances before the nested field resolvers read them;
    // separate/cross-adapter relations fire it natively via their own query.
    const plan = (a.include as IncludeMap[] | undefined)?.[0];
    if (plan) {
      await this.applyEagerAfterFind(plan, models, options);
    }

    let total;
    if (adapter.hasInlineCountFeature()) {
      total = await adapter.getInlineCount(models);
    } else {
      // `countOptions` is only optional for adapters that count inline; the two
      // are the same decision, so an adapter reaching here without one has a
      // contract bug that would otherwise surface as an unfiltered count.
      if (!countOptions) {
        throw new Error(`Adapter '${adapter.adapterName}' has no inline count feature but returned no countOptions for '${defName}'`);
      }
      total = await adapter.count(defName, countOptions);
    }
    return {
      total, models,
    };
  }
  processInputs = async(defName: string, input: MutationInputTree, args: unknown, context: RequestContext, info: unknown, model?: AdapterRow, operationHint?: ScopeOperation): Promise<MutationInput> => {
    const definition = this.getDefinition(defName);
    const fields = this.getFields(defName);
    // Allow-list scalar input to writable columns. `isStructurallyWritable`
    // drops primary keys, foreign keys, and auto-populated columns by default
    // (unless a field opts in with `writable: true`) — a defense-in-depth guard
    // against mass-assignment / IDOR that applies to both create and update
    // (processUpdate funnels its payload back through here).
    let i = Object.keys(fields).reduce((o, key) => {
      if (input[key] !== undefined && isStructurallyWritable(fields[key])) {
        o[key] = input[key];
      }
      return o;
    }, {} as MutationInput);

    if (definition.override) {
      i = await waterfall(Object.keys(definition.override), async(key: string, o: MutationInput) => {
        if (definition.override) {
          const input = definition.override[key].input;
          if (input) {
            const val = await input(o[key], args, context, info, model);
            if (val !== undefined) {
              o[key] = val;
            }
          }
        }
        return o;
      }, i);
    }

    // The `set` half of a row-level scope: field values the scope *forces*.
    //
    // Applied after `definition.override` rather than merely after the
    // mass-assignment allow-list, because an `override.ownerId.input` returning
    // a value would otherwise stomp what the scope forces. The allow-list is the
    // complementary half — `ownerId` is a foreign key, so
    // `isStructurallyWritable` has already dropped whatever the client sent, and
    // `set` supplies a value the client had no way to send.
    // `model` is the row being written, so its presence names the operation —
    // except where the caller already knows and has no row to hand over. The
    // nested `update` verb is exactly that: it processes one input for the whole
    // set of rows a filter matched, so it passes the hint rather than an
    // arbitrary member of that set (which `definition.override` would then see).
    const operation: ScopeOperation = operationHint || (model === undefined ? "create" : "update");
    const rowScope = await this.resolveRowScope(defName, operation, context);
    const forced = rowScope ? rowScope.set : undefined;
    if (forced) {
      for (const key of Object.keys(forced)) {
        if (i[key] !== undefined && i[key] !== forced[key]) {
          // A value survived the allow-list (the field opted in with
          // `writable: true`) and disagrees with the scope. Writing the safe
          // value anyway is the tempting implementation and it hides a forged
          // request behind a successful mutation; refuse instead.
          throw new ScopeDeniedError(defName, operation);
        }
        i[key] = forced[key];
      }
    }
    return i;
  }
  /**
   * Apply the relationship sub-mutations nested under each association name of
   * `input` to a row that was just created, updated or selected. The verbs
   * themselves are a table in `./relationship-mutations`.
   */
  processRelationshipMutation = async(defName: string, source: AdapterRow, input: MutationInputTree | undefined, context: RequestContext, selection?: Selection): Promise<AdapterRow> => {
    return applyRelationshipMutations(this.host, defName, source, input, context,
      createResolveContext(context, selection, source), selection);
  }
  /**
   * Run a coordinated unit of work. Any create/update/delete inside `fn` — on any
   * adapter — joins the same coordinator: they commit together on success and all
   * roll back if `fn` throws. Nested `transaction` calls join the active
   * coordinator rather than opening a new one. See {@link OrmizeTransaction} for
   * the best-effort (non-two-phase-commit) guarantee.
   */
  transaction = async <T = unknown>(fn: (tx: OrmizeTransaction) => Promise<T>): Promise<T> => {
    const current = getStore();
    if (current?.transaction) {
      return fn(current.transaction);
    }
    const coordinator = new OrmizeTransaction(this);
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
  runWithContext = <T = unknown>(context: RequestContext, fn: () => T): T => {
    const current = getStore();
    return store.run({ ...(current || {}), context }, fn);
  }

  /** The ambient request context for the current async scope, if any. */
  getContext = (): RequestContext => {
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
  withTransaction = async <T>(defName: string, context: RequestContext, fn: (ctx: RequestContext) => Promise<T>): Promise<T> => {
    const adapterName = this.defsAdapters[defName];
    const active = getStore()?.transaction;
    if (active) {
      const handle = await active.handleFor(adapterName);
      return fn(inheritScopeMemo(context, Object.assign({}, context, { transaction: handle })));
    }
    if (context && context.transaction) {
      return fn(context);
    }
    // Lenient by design: an adapter with no transaction support runs unenrolled.
    const adapter = this.findAdapter(adapterName);
    if (!adapter || (typeof adapter.beginTransaction !== "function" && typeof adapter.transaction !== "function")) {
      return fn(context);
    }
    return this.transaction(async() => this.withTransaction(defName, context, fn));
  }

  /**
   * Open (or join) the unit of work a top-level mutation runs in, then hand the
   * body the four lookups all four of them opened with.
   *
   * It is a wrapper rather than four copies of the preamble because of the
   * `context` shadowing: {@link withTransaction} hands back a context carrying
   * the adapter's transaction handle, and a body that used the one it was called
   * with would run outside the transaction. Making the shadow a parameter is what
   * stops that being a rename away.
   */
  private mutationEntry = <T>(
    defName: string,
    context: RequestContext,
    selection: Selection | undefined,
    fn: (entry: {
      context: RequestContext;
      adapter: OrmAdapter;
      definition: Definition;
      globalKeys: string[];
      idTargets: GlobalKeyTargets;
      translateFilter: NonNullable<Selection["translateFilter"]>;
    }) => Promise<T>,
  ): Promise<T> => {
    return this.withTransaction(defName, context, (context: RequestContext) => fn({
      context,
      adapter: this.getModelAdapter(defName),
      definition: this.getDefinition(defName),
      globalKeys: this.getGlobalKeys(defName),
      idTargets: this.getGlobalKeyTargets(defName),
      translateFilter: selection?.translateFilter || (<W,>(w: W) => w),
    }));
  }

  /**
   * Run the pre-commit instance-method transforms an `apply` argument asked for,
   * and fold what they wrote into the values about to be persisted.
   *
   * `this` inside a transform is the thing being written: on update the live row
   * (so it can read columns it did not receive), on create the pending values
   * (no row exists yet). A transform may either return an object to merge or
   * assign to `this` directly — on update the direct writes have to be captured,
   * because the adapter persists the values map rather than whatever the row
   * happens to have changed, hence the recording proxy.
   *
   * Called from inside {@link mutationEntry}, so a throw here rolls the whole
   * mutation back — relationship writes included.
   */
  private applyInstanceTransforms = async(
    defName: string,
    definition: Definition,
    apply: { [methodName: string]: unknown } | undefined,
    row: AdapterRow | undefined,
    values: MutationInput,
    args: unknown,
    context: RequestContext,
    info: unknown,
  ): Promise<MutationInput> => {
    const requested = apply ? Object.keys(apply) : [];
    if (requested.length === 0) {
      return values;
    }
    const methods = mutationInstanceMethods(definition);
    const written: MutationInput = {};
    // Same shape as `InstanceRow` — the row is reached through members named
    // only at runtime (a Sequelize accessor bound to the real receiver, or
    // whatever field a transform reads/writes).
    const target: InstanceRow | MutationInput = row === undefined ? values : new Proxy(row as InstanceRow, {
      get(t, p) {
        const v = Reflect.get(t, p, t);
        // Methods have to keep seeing the real row as their receiver, or a
        // Sequelize accessor would run against the proxy and re-enter the trap.
        return typeof v === "function" ? v.bind(t) : v;
      },
      set(t, p, v) {
        if (typeof p === "string") {
          written[p] = v;
        }
        return Reflect.set(t, p, v, t);
      },
    });
    // `requested.length === 0` already returned above, so `apply` is defined
    // from here on; the assertion just recovers that for the type checker.
    const applyMap = apply as { [methodName: string]: unknown };
    for (const methodName of requested) {
      const value = applyMap[methodName];
      // A no-arg transform is a `Boolean` flag; naming it without asking for it
      // is not a request to run it.
      if (value === false || value === null || value === undefined) {
        continue;
      }
      const entry = methods[methodName];
      if (!entry) {
        throw new Error(`ormize: "${defName}.${methodName}" is not exposed as an instance-method transform.`);
      }
      // Same resolution order the adapter uses when it installs these onto the
      // model prototype: `options.instanceMethods` is the nested spelling,
      // `instanceMethods` the flat one.
      const implementation = definition.options?.instanceMethods?.[methodName] || definition.instanceMethods?.[methodName];
      if (typeof implementation !== "function") {
        throw new Error(`ormize: instance-method transform "${defName}.${methodName}" is exposed but the model declares no such instance method.`);
      }
      let methodArgs: unknown = value === true ? {} : value;
      if (entry.before) {
        methodArgs = await entry.before({
          params: methodArgs, args, context, info,
          modelDefinition: definition,
          type: row === undefined ? Events.MUTATION_CREATE : Events.MUTATION_UPDATE,
        });
      }
      let result = await implementation.call(target, methodArgs, context);
      if (entry.after) {
        result = await entry.after(result, context);
      }
      // Assigning through `target` keeps a later transform in the same mutation
      // reading what an earlier one wrote, whichever way it wrote it.
      if (result && typeof result === "object" && !Array.isArray(result)) {
        Object.assign(target, result);
      }
    }
    // Both writes stay in place. `target` is either the recording proxy over the
    // live row or the values bag itself, and the sequencing above depends on a
    // later transform seeing what an earlier one wrote. `values` is never the
    // caller's: `processInputs` reduces into a fresh object on both the create
    // and the update path.
    return row === undefined ? values : Object.assign(values, written);
  }

  processCreate = async(defName: string, source: AdapterRow, args: { input: MutationInputTree; apply?: MutationApply }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return this.mutationEntry(defName, context, selection, async({context, adapter, definition, globalKeys, idTargets, translateFilter}) => {
      const processCreate = adapter.getCreateFunction(defName);
      if (await this.resolveRowScope(defName, "create", context) === false) {
        // No row may be created at all. `processInputs` still forces whatever
        // `set` a *live* scope carries; this is the outright deny, which has no
        // values to force.
        scopeMiss(defName, "create", this.onScopeMiss);
        return [];
      }
      const i = await this.processInputs(defName, args.input, args, context, selection?.raw);
      let input = translateFilter(i, globalKeys, idTargets);
      if (definition.before) {
        input = await definition.before({
          params: input, args, context, info: selection?.raw,
          modelDefinition: definition,
          type: Events.MUTATION_CREATE,
        });
      }
      input = await this.applyInstanceTransforms(defName, definition, args.apply, undefined, input, args, context, selection?.raw);
      if (Object.keys(input).length > 0) {
        let result = await processCreate(input, createResolveContext(context, selection, source));
        if (result !== undefined && result !== null) {
          result = await this.processRelationshipMutation(defName, result, args.input, context, selection);
          // F6. `processInputs` forced whatever the create scope's `set` names,
          // but `definition.before`, `override.input` and the nested `add`/`set`
          // verbs all run after it — the last of those re-points a foreign key
          // nobody named. Cheaper to look than to reason about the ordering.
          await this.assertRowsInScope(defName, "create", context, [result], createResolveContext(context, selection, source));
          return [result];
        }
      }
      return [];
    });
  }

  processUpdate = async(defName: string, source: AdapterRow, args: { input: MutationInputTree; where: MutationFilter; limit?: number; apply?: MutationApply }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return this.mutationEntry(defName, context, selection, async({context, adapter, definition, globalKeys, idTargets, translateFilter}) => {
      const translateId = selection?.translateId || ((v: unknown) => v);
      const processUpdate = adapter.getUpdateFunction(defName, whereOperatorsFor(definition));
      let i: MutationInput = Object.keys(args.input).reduce((o, k) => {
        if (globalKeys.indexOf(k) > -1) {
          let v = args.input[k];
          // A global-id argument may arrive as a thunk over the operation's
          // variables — gqlize defers relay id translation that way.
          if (typeof v === "function") {
            v = v(selection?.variableValues);
          }
          if (v === null || v === undefined) {
            o[k] = null;
          } else {
            o[k] = translateId(v, k);
          }
        } else {
          o[k] = args.input[k];
        }
        return o;
      }, {} as MutationInput);
      // A read scope alone is a false sense of security: the caller cannot see
      // the row but can still name its id here. Merged after `translateFilter`,
      // which decodes the *caller's* opaque ids — the scope's values are already
      // raw, and a codec handed one would corrupt whatever it half recognised.
      const scoped = await this.scopedWriteWhere(defName, "update", context, translateFilter(args.where, globalKeys, idTargets));
      if (scoped === false) {
        scopeMiss(defName, "update", this.onScopeMiss);
        return [];
      }
      // The cast keeps the pre-existing shape: `getUpdateFunction` declares a
      // non-optional filter, and an absent `args.where` already reached it as
      // `undefined` before this line existed. Substituting `{}` would be a
      // behaviour change on a delete-shaped path, which is not this commit.
      const where = scoped as MutationFilter;
      if (definition.before) {
        // Unlike the query hook, this one is handed the *input* and returns it;
        // `where` is already built and out of its reach, so there is nothing to
        // re-assert here (compare F3 in `resolveFindAll`).
        i = await definition.before({
          params: i, args, context, info: selection?.raw,
          modelDefinition: definition,
          type: Events.MUTATION_UPDATE,
        });
      }
      const results = await processUpdate(where, async(model) => {
        const values = await this.processInputs(defName, i, args, context, selection?.raw, model);
        return this.applyInstanceTransforms(defName, definition, args.apply, model, values, args, context, selection?.raw);
      }, createResolveContext(context, selection, source, {limit: args.limit}));
      await waterfall(results, async(r: AdapterRow) => {
        await this.processRelationshipMutation(defName, r, args.input, context, selection);
      });
      // F6. The filter above decided which rows may be written; this decides
      // whether the write left them where it found them. A scope filtering on a
      // column the caller may also write is the ordinary case, not a corner one.
      await this.assertRowsInScope(defName, "update", context, results, createResolveContext(context, selection, source));
      return results;
    });
  }
  processSelect = async(defName: string, source: AdapterRow, args: { input?: MutationInputTree; where?: MutationFilter; limit?: number }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    // Find matching elements and run relationship mutations on them via `args.input`
    // WITHOUT modifying the elements themselves (no field write / lifecycle change);
    // scalar fields in `input` are ignored. Returns the found rows so the caller can
    // select fields back.
    return this.mutationEntry(defName, context, selection, async({context, adapter, definition, globalKeys, idTargets, translateFilter}) => {
      const options = createResolveContext(context, selection, source, {limit: args.limit});
      // `select` writes no field, so it is easy to mistake for a read. It runs
      // relationship sub-mutations against every row its filter matches, which
      // makes it an update in everything but name — a layer that scoped only
      // update and delete leaves this one open.
      const scoped = await this.scopedWriteWhere(defName, "update", context, translateFilter(args.where, globalKeys, idTargets));
      if (scoped === false) {
        scopeMiss(defName, "update", this.onScopeMiss);
        return [];
      }
      const where = await adapter.processFilterArgument(scoped, whereOperatorsFor(definition), options);
      const results = await adapter.findAll(defName, Object.assign({where, limit: args.limit}, options));
      await waterfall(results, async(r: AdapterRow) => {
        await this.processRelationshipMutation(defName, r, args.input, context, selection);
      });
      return results;
    });
  }
  processDelete = async(defName: string, source: AdapterRow, args: MutationFilter, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return this.mutationEntry(defName, context, selection, async({context, adapter, definition, globalKeys, idTargets, translateFilter}) => {
      const processDelete = adapter.getDeleteFunction(defName, whereOperatorsFor(definition));
      const scoped = await this.scopedWriteWhere(defName, "delete", context, translateFilter(args, globalKeys, idTargets));
      if (scoped === false) {
        scopeMiss(defName, "delete", this.onScopeMiss);
        return [];
      }
      const where = scoped as MutationFilter;
      const before = (model: AdapterRow) => {
        if (!definition.before) {
          return model;
        }
        return definition.before({
          params: model, args, context, info: selection?.raw,
          model, modelDefinition: definition,
          type: Events.MUTATION_DELETE,
        });
      };
      const after = (model: AdapterRow) => model;
      return processDelete(where, createResolveContext(context, selection, source), before, after);
    });
  }
  /**
   * Undelete soft-deleted rows. The mirror of {@link processDelete}, but scoped
   * as an **update**: a restore changes a row that is already there rather than
   * removing one, which is the same reading `VERB_OPERATIONS.restore` and the
   * `beforeRestore` hook mapping already take.
   *
   * Only available on a model whose adapter soft-deletes \u2014 there is nothing for
   * it to undo otherwise, and gqlize does not generate the mutation at all.
   */
  processRestore = async(defName: string, source: AdapterRow, args: MutationFilter, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return this.mutationEntry(defName, context, selection, async({context, adapter, definition, globalKeys, idTargets, translateFilter}) => {
      if (!adapter.getRestoreFunction) {
        throw new Error(`restore is not supported by the adapter backing ${defName}`);
      }
      const processRestore = adapter.getRestoreFunction(defName, whereOperatorsFor(definition));
      const scoped = await this.scopedWriteWhere(defName, "update", context, translateFilter(args, globalKeys, idTargets));
      if (scoped === false) {
        scopeMiss(defName, "update", this.onScopeMiss);
        return [];
      }
      const where = scoped as MutationFilter;
      const before = (model: AdapterRow) => {
        if (!definition.before) {
          return model;
        }
        // `Events.MUTATION_UPDATE` rather than an event of its own: a new member
        // is a surface change every exhaustive hook has to learn, and treating a
        // restore as an update is already this codebase's position everywhere
        // else it has had to choose.
        return definition.before({
          params: model, args, context, info: selection?.raw,
          model, modelDefinition: definition,
          type: Events.MUTATION_UPDATE,
        });
      };
      const after = (model: AdapterRow) => model;
      const results = await processRestore(where, createResolveContext(context, selection, source), before, after);
      // The same re-check `processUpdate` makes, for the same reason: the filter
      // decided which rows could be written, this decides whether the write left
      // them where it found them.
      await this.assertRowsInScope(defName, "update", context, results, createResolveContext(context, selection, source));
      return results;
    });
  }

}

// Build the resolve-context object passed to adapter fetch/mutation functions.
// Hooks read `options.getGraphQLArgs().info`; gqlize sets `selection.raw` to the
// real GraphQLResolveInfo so that behaviour is identical, while ormize itself
// stays graphql-free (it only forwards the opaque `raw`).
function createResolveContext(context: RequestContext, selection: Selection | undefined, source: AdapterRow, options: AdapterQueryOptions = {}): ResolveOptions {
  const base: ResolveOptions = {
    getGraphQLArgs() {
      return {
        context,
        info: selection?.raw,
        source,
      };
    },
  };
  // Propagate an in-flight transaction (set by withTransaction) so every nested
  // Sequelize call — create/update/destroy/findAll and relationship accessors —
  // joins the same transaction and a multi-step mutation is atomic.
  if (context && context.transaction) {
    base.transaction = context.transaction;
  }
  return Object.assign(base, options);
}

// Cursor-based offset from decoded `after`/`before` args (shared by the top-level
// list resolver and the relationship resolver).
function cursorOffset(args: FindAllArgs) {
  if (args.after) {
    return args.after.index + 1;
  }
  if (args.before) {
    let offset = args.before.index + 1;
    if (args.limit) {
      offset -= Number(args.limit);
    }
    return offset;
  }
  return undefined;
}
