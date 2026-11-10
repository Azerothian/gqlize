// The Ormize class — the public entry point for the engine.
//
// This file used to hold the entire engine (~2300 lines). The logic now lives
// in cohesive modules under `./engine/`; this file keeps the class surface
// identical (same members, same types, same `this`-binding contract) and
// delegates to them.

import Cache from "./utils/cache";
import {globalKeyTargets, globalKeysFromFields} from "@azerothian/utilize/utils/global-keys";
import {definitionHooks} from "@azerothian/utilize/utils/definition-hooks";
import waterfall from "@azerothian/utilize/utils/waterfall";
import {copyDefinition} from "@azerothian/utilize/utils/copy-on-write";
import type { Permission, ScopeOperation } from "@azerothian/utilize/gate";
import type { ScopeMissBehaviour } from "./scope";
import { inheritScopeMemo } from "./scope";
import { buildScopeHooks, buildScopeInstanceHooks } from "./scope-hooks";
import { auditDefinitionScopeSurfaces, auditExtendFields, reportScopeSurfaces } from "./scope-audit";
import type { ScopeHook } from "./scope-hooks";
import { Definitions, GqlizeOptions, Definition, HookMap, Relationship, AnyTypedDef, ModelNameOf, IORModel, IORBase, BaseOf } from './types';
import { OrmAdapter, AdapterRow, AdapterQueryOptions, DataTypeDescriptor, InitialiseOptions, NativeDataType,
  RequestContext, Selection, FindAllArgs, Association, CsvOptions, ResolvedCsvLimits } from '@azerothian/utilize/types/index';
import type { MutationApply, MutationFilter, MutationHost, MutationInput,
  MutationInputTree } from "./types/engine";
import ReadCache from "./read-cache";

// Engine modules — the logic that used to be inline.
import {
  // constants
  sequelizeHookList as _sequelizeHookList, hookList, gqlizeHookList, OPAQUE_READ_HOOKS,
  // hooks
  warnDefinitionInstanceHooks, createHook, installInstanceHooks,
  runHook, applyEagerAfterFind,
  // scope-bridge
  resolveRowScope, scopeNativeWhere,
  assertRowsInScope, scopeMiss,
  // relationships
  validateCrossAdapterKeys, buildCrossAdapterAssociation,
  processRelationship, generateJoinModels,
  // resolution
  resolveClassMethod as _resolveClassMethod,
  resolveManyRelationship as _resolveManyRelationship,
  resolveSingleRelationship as _resolveSingleRelationship,
  resolveFindAll as _resolveFindAll,
  // mutations
  processInputs as _processInputs,
  processRelationshipMutation as _processRelationshipMutation,
  processCreate as _processCreate,
  processUpdate as _processUpdate,
  processSelect as _processSelect,
  processDelete as _processDelete,
  processRestore as _processRestore,
  // transactions
  transaction as _transaction,
  runWithContext as _runWithContext,
  getContext as _getContext,
  withTransaction as _withTransaction,
  // csv
  processCsv as _processCsv,
  processCsvImport as _processCsvImport,
} from "./engine";
import type { CsvImportHost, CsvImportRequest, CsvImportResult, CsvOperation, CsvRequest } from "./engine";
import { resolveCsvLimits, resolveCsvMaxFiles } from "./csv/limits";
import type { HookFunction, HookHost, MutationEntryHost, ReadCacheHost, RelationshipHost, ResolutionHost, ScopeHost,
  TransactionHost, WiredRelationship } from "./engine";

/** Every host interface the engine modules declare; see `Ormize.engine`. */
type EngineHost = HookHost & ScopeHost & ReadCacheHost & RelationshipHost & ResolutionHost & MutationEntryHost & TransactionHost;
import { getStore } from "./context";

// Re-export the public symbols that used to live in this file.
export { _sequelizeHookList as sequelizeHookList };
export type { HookFunction, WiredRelationship };

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
  /** See `GqlizeOptions.writableForeignKeys`; applied in `getFields`. */
  private writableForeignKeys: boolean;
  /** `GqlizeOptions.csv`, folded with each definition's own by `csvLimits`. */
  private csv: boolean | CsvOptions | undefined;
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
  /**
   * The read cache from `GqlizeOptions.cache`, or `undefined` when it is off.
   * Public so a host that writes behind ormize's back (raw SQL, another
   * service) can call `invalidate([modelName])` or `clear()` itself.
   */
  readCache: ReadCache | undefined;
  defaultAdapter: string | undefined;
  constructor(options: GqlizeOptions = {}) {
    this.defs = {};
    this.defsAdapters = {};
    this.adapters = {};
    this.models = {} as TModels;
    this.relationships = {};
    this.hooks = {};
    this.globalHooks = [...hookList, ..._sequelizeHookList].reduce((o, hookName) => {
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
    this.writableForeignKeys = options.writableForeignKeys === true;
    this.csv = options.csv;
    this.readCache = options.cache ? new ReadCache(options.cache, {
      definitionCache: (defName) => this.defs[defName]?.cache,
      hasOpaqueHooks: (defName, operation) => OPAQUE_READ_HOOKS[operation].some((hookName) => {
        const own = definitionHooks(this.defs[defName])[hookName];
        const global = this.globalHooks[hookName];
        return [own, global].some((h) => Array.isArray(h) ? h.length > 0 : Boolean(h));
      }),
    }) : undefined;
    // Built unconditionally: whether a scope is configured is asked at call
    // time, so a `setPermission` after `initialise()` reaches the models that
    // already exist. Field initialisers have all run by here, so `this.host`
    // is the same object the cross-adapter and mutation modules were handed.
    this.scopeHooks = buildScopeHooks(this.host);
    this.scopeInstanceHooks = buildScopeInstanceHooks((name) => Boolean(this.defs[name]));
  }

  // -------------------------------------------------------------------------
  // Permission and scope auditing
  // -------------------------------------------------------------------------

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
      this.auditScopeSurfaces();
    }
  }

  /**
   * §12: refuse to build a scoped model whose methods the engine cannot reach.
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

  // -------------------------------------------------------------------------
  // Hook management (public API)
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Adapter registration
  // -------------------------------------------------------------------------

  registerAdapter = <A extends OrmAdapter>(adapter: A, overrideName?: string): Ormize<TModels, BaseOf<A>> => {
    if (overrideName) {
      adapter.adapterName = overrideName;
    }
    if (!adapter.adapterName) {
      throw new Error("Ormize.registerAdapter: adapter has no adapterName and no override name was given");
    }
    if (!this.defaultAdapter) {
      this.defaultAdapter = adapter.adapterName;
    }
    this.adapters[adapter.adapterName] =  adapter;
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

  // -------------------------------------------------------------------------
  // Definition management
  // -------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/require-await -- must stay async: callers (and __tests__/resolution-errors.test.ts) rely on requireDefinition's throw arriving as a rejected promise, not a sync throw
  getDefinitionHooks = async(defName: string): Promise<HookMap> => {
    const def = this.requireDefinition(defName, "Ormize.getDefinitionHooks");
    return definitionHooks(def);
  }

  /**
   * The adapter registered under `datasource`, or a message that says which name
   * failed, where the caller got it from, and what is actually registered.
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
      if (Object.keys(this.adapters).length === 0) {
        throw new Error(`Cannot add definition '${def.name}': no adapters are registered - call registerAdapter() before addDefinition().`);
      }
      throw new Error(`Model definition does not have a adapter name defined`);
    }
    const adapter = this.requireAdapter(datasource, `Cannot add definition '${def.name}'`,
      adapterName ? "from the adapterName argument"
        : def.datasource ? "from def.datasource"
          : "the default adapter");
    const owned = copyDefinition(def);
    const defName = owned.name as string;
    this.defs[defName] = owned;
    this.defsAdapters[defName] = datasource


    warnDefinitionInstanceHooks(owned);

    // Native Sequelize hooks are registered on the model; gqlize-only hooks
    // (e.g. afterCount) are composed for `runHook` but withheld from the adapter.
    const nativeHooks = hookList.reduce((o, hookName) => {
      o[hookName] = createHook(this.engine, hookName, owned);
      return o;
    }, {} as HookMap);
    this.hooks[defName] = gqlizeHookList.reduce((o, hookName) => {
      o[hookName] = createHook(this.engine, hookName, owned);
      return o;
    }, { ...nativeHooks });

    (this.models as Record<string, unknown>)[defName] = await adapter.createModel(owned, nativeHooks);
  }

  // -------------------------------------------------------------------------
  // Model / adapter accessors
  // -------------------------------------------------------------------------

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
  getGlobalKeyTargets = (defName: string) => globalKeyTargets(this.getFields(defName), defName);
  getFields = (defName: string) => {
    const adapter = this.getModelAdapter(defName);
    //TODO: add cross adapter fields
    const fields = adapter.getFields(defName);
    if (!this.writableForeignKeys || !fields) {
      return fields;
    }
    return Object.keys(fields).reduce((o, key) => {
      const field = fields[key];
      o[key] = field.foreignKey && !field.primaryKey && field.writable === undefined
        ? {...field, writable: true}
        : field;
      return o;
    }, {} as typeof fields);
  }

  /**
   * Associations for a model, merging the adapter's native ones with the
   * cross-adapter relationships ormize wires itself.
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
      associations[relName] = {
        ...associations[relName],
        ...buildCrossAdapterAssociation(defName, rel),
      };
    }
    return associations;
  }

  /**
   * The adapter a model was defined against. Throws for an unknown model.
   */
  getModelAdapter = (modelName: string) => {
    return this.requireModelAdapter(modelName, "Ormize.getModelAdapter");
  }

  /**
   * Re-point an options (or context) object's transaction handle from one model's
   * adapter at another's.
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
    return o;
  }

  /**
   * Convert an adapter-native type into the abstract ormize `DataType` descriptor.
   */
  mapDataType = (nativeType: NativeDataType, adapterName?: string): DataTypeDescriptor => {
    const name = adapterName || this.defaultAdapter || Object.keys(this.adapters)[0];
    const adapter = name ? this.adapters[name] : undefined;
    if (!adapter) {
      throw new Error("Ormize.mapDataType: no adapter registered");
    }
    return adapter.mapDataType(nativeType);
  }

  // -------------------------------------------------------------------------
  // Host objects — the narrow interfaces the engine modules read from `this`
  // -------------------------------------------------------------------------

  /**
   * The slice of this manager the cross-adapter and mutation modules are written
   * against. An object literal rather than `this` because `optionsForAdapter` is
   * private, and a private member cannot satisfy a structurally-required public
   * one — see {@link MutationHost}.
   */
  /**
   * What `processCsv` reads. Everything on it is public already, so unlike
   * {@link engine} it is a plain forwarding object — kept anyway so the
   * module is written against an interface rather than the whole class.
   */
  private csvHost: CsvImportHost = {
    csvLimits: (defName) => this.csvLimits(defName),
    csvMaxFiles: () => this.csvMaxFiles(),
    getModelAdapter: (defName) => this.getModelAdapter(defName),
    transaction: (fn) => this.transaction(fn),
    processCreate: (defName, source, args, context, selection) => this.processCreate(defName, source, args, context, selection),
    processUpdate: (defName, source, args, context, selection) => this.processUpdate(defName, source, args, context, selection),
    processDelete: (defName, source, args, context, selection) => this.processDelete(defName, source, args, context, selection),
  };

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
    resolveScope: (defName, operation, context) => resolveRowScope(this.engine, defName, operation, context),
    scopeMiss: (defName, operation) => scopeMiss(defName, operation, this.onScopeMiss),
    scopedWhere: (defName, operation, context, where, options) => scopeNativeWhere(this.engine, defName, operation, context, where, options),
    assertRowsInScope: (defName, operation, context, rows, options) => assertRowsInScope(this.engine, defName, operation, context, rows, options),
  };

  /**
   * The slice of this manager the engine modules (`./engine/*`) are written
   * against: every host interface they declare, in one object.
   *
   * Not `this`. Most of what they read is private here (the permission bag,
   * the §13 scope hooks, the join-model table), and a class can only satisfy an
   * interface with public members. Widening those to public would let any
   * caller assign `orm.permission` past `setPermission`'s re-audit, or swap out
   * the scope hooks that are private precisely so nothing can register after
   * them.
   *
   * Every field is a getter, not a copy. A hook is built once per model and
   * keeps this object for the life of the process, so it has to see what the
   * manager holds *now*: a `setPermission` after models exist must reach the
   * §13 hooks they already carry.
   */
  private engine: EngineHost = (() => {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters below run with the facade as `this`, so the manager has to be named
    const orm = this;
    return {
      get defs() { return orm.defs; },
      get defsAdapters() { return orm.defsAdapters; },
      get adapters() { return orm.adapters; },
      get relationships() { return orm.relationships; },
      get _joinModels() { return orm._joinModels; },
      get defaultAdapter() { return orm.defaultAdapter; },
      get hooks() { return orm.hooks; },
      get globalHooks() { return orm.globalHooks; },
      get permission() { return orm.permission; },
      get onScopeMiss() { return orm.onScopeMiss; },
      get scopeHooks() { return orm.scopeHooks; },
      get scopeInstanceHooks() { return orm.scopeInstanceHooks; },
      get readCache() { return orm.readCache; },
      get instanceHookedAdapters() { return orm._instanceHookedAdapters; },
      get host() { return orm.host; },
      getDefinitionHooks: (defName: string) => orm.getDefinitionHooks(defName),
      getModelAdapter: (modelName: string) => orm.getModelAdapter(modelName),
      getDefinition: (defName: string) => orm.getDefinition(defName),
      getAssociations: (defName: string) => orm.getAssociations(defName),
      getFields: (defName: string) => orm.getFields(defName),
      getGlobalKeys: (defName: string) => orm.getGlobalKeys(defName),
      getGlobalKeyTargets: (defName: string) => orm.getGlobalKeyTargets(defName),
      addDefinition: (def: Definition, adapterName?: string) => orm.addDefinition(def, adapterName),
      requireDefinition: (defName: string, subject: string) => orm.requireDefinition(defName, subject),
      findAdapter: (datasource: string | undefined) => orm.findAdapter(datasource),
      optionsForAdapter: <T extends AdapterQueryOptions | undefined>(fromDefName: string, toDefName: string, options: T) =>
        orm.optionsForAdapter(fromDefName, toDefName, options),
      withTransaction: <T>(defName: string, context: RequestContext, fn: (ctx: RequestContext) => Promise<T>) =>
        orm.withTransaction(defName, context, fn),
    };
  })();

  processRelationship = async(def: Definition, sourceAdapter: OrmAdapter , rel: Relationship) => {
    return processRelationship(this.engine, def, sourceAdapter, rel);
  }

  // -------------------------------------------------------------------------
  // Instance helpers
  // -------------------------------------------------------------------------

  /** See {@link OrmAdapter.asInstance}; a row that is not an object passes through. */
  asInstance = (defName: string, row: AdapterRow): AdapterRow => {
    if (!row || typeof row !== "object") {
      return row;
    }
    const adapter = this.getModelAdapter(defName);
    return adapter.asInstance ? adapter.asInstance(defName, row) : row;
  }
  getValueFromInstance = (defName: string, data: AdapterRow, keyName: string): unknown => {
    if (!data) {
      return undefined;
    }
    const adapter = this.getModelAdapter(defName);
    return adapter.getValueFromInstance(data, keyName);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Wire the registered definitions into models, relationships and join models.
   */
  initialise = async(options?: InitialiseOptions) => {
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
        processRelationship(this.engine, def, sourceAdapter, rel));
    }));
    await generateJoinModels(this.engine);
    validateCrossAdapterKeys(this.engine);
    await Promise.all(Object.keys(this.adapters).map((adapterName) => {
      const adapter = this.adapters[adapterName];
      installInstanceHooks(this.engine, adapterName, adapter);
      return adapter.initialise(options);
    }));
    this._initialised = true;
    this.auditScopeSurfaces();
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

  // -------------------------------------------------------------------------
  // Hook invocation (delegating)
  // -------------------------------------------------------------------------

  runHook = async <T = unknown>(defName: string, hookName: string, value: T, ...args: unknown[]): Promise<T> => {
    return runHook(this.engine, defName, hookName, value, ...args);
  }

  applyEagerAfterFind = async(planMap: import("@azerothian/utilize/types/index").IncludeMap | undefined, instances: AdapterRow[], options: AdapterQueryOptions): Promise<void> => {
    return applyEagerAfterFind(this.engine, planMap, instances, options);
  }

  // -------------------------------------------------------------------------
  // Resolution engine (delegating)
  // -------------------------------------------------------------------------

  isTypeOf = (defName: string, _definition: Definition, value: unknown): boolean => {
    const Model = this.getModel(defName) as unknown as abstract new (...args: unknown[]) => unknown;
    const isType = value instanceof Model;
    return isType;
  }

  resolveClassMethod = async(defName: string, methodName: string, args: unknown, context: RequestContext,
    before?: (args: unknown, context: RequestContext) => unknown,
    after?: (result: unknown, context: RequestContext) => unknown) => {
    return _resolveClassMethod(this.engine, defName, methodName, args, context, before, after);
  }

  resolveManyRelationship = async(defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection) => {
    return _resolveManyRelationship(this.engine, defName, association, source, args, context, selection);
  }

  resolveSingleRelationship = async(defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection) => {
    return _resolveSingleRelationship(this.engine, defName, association, source, args, context, selection);
  }

  resolveFindAll = async(defName: string, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection, scope?: {field: string, value: unknown}) => {
    return _resolveFindAll(this.engine, defName, source, args, context, selection, scope);
  }

  // -------------------------------------------------------------------------
  // Mutations (delegating)
  // -------------------------------------------------------------------------

  processInputs = async(defName: string, input: MutationInputTree, args: unknown, context: RequestContext, info: unknown, model?: AdapterRow, operationHint?: ScopeOperation): Promise<MutationInput> => {
    return _processInputs(this.engine, defName, input, args, context, info, model, operationHint);
  }

  processRelationshipMutation = async(defName: string, source: AdapterRow, input: MutationInputTree | undefined, context: RequestContext, selection?: Selection): Promise<AdapterRow> => {
    return _processRelationshipMutation(this.engine, defName, source, input, context, selection);
  }

  processCreate = async(defName: string, source: AdapterRow, args: { input: MutationInputTree; apply?: MutationApply }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return _processCreate(this.engine, defName, source, args, context, selection);
  }

  processUpdate = async(defName: string, source: AdapterRow, args: { input: MutationInputTree; where: MutationFilter; limit?: number; apply?: MutationApply }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return _processUpdate(this.engine, defName, source, args, context, selection);
  }

  processSelect = async(defName: string, source: AdapterRow, args: { input?: MutationInputTree; where?: MutationFilter; limit?: number }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return _processSelect(this.engine, defName, source, args, context, selection);
  }

  processDelete = async(defName: string, source: AdapterRow, args: MutationFilter, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return _processDelete(this.engine, defName, source, args, context, selection);
  }

  processRestore = async(defName: string, source: AdapterRow, args: MutationFilter, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return _processRestore(this.engine, defName, source, args, context, selection);
  }

  /**
   * The limits a CSV upload to `defName` runs under, or `undefined` when the
   * model takes none — `GqlizeOptions.csv` is off, or the definition says
   * `csv: false`. The surfaces read this to decide whether to offer CSV at all.
   */
  csvLimits = (defName: string): ResolvedCsvLimits | undefined => {
    return resolveCsvLimits(this.csv, this.defs[defName]?.csv);
  }

  /** How many files one multi-file CSV import may carry, or `undefined` when CSV is off. */
  csvMaxFiles = (): number | undefined => resolveCsvMaxFiles(this.csv);

  /**
   * Apply a CSV upload as one create, update or delete per row, all-or-nothing.
   * See `./engine/csv` — and note it only *transports* the rows: permission to
   * perform the operation is the caller's to check, as for `processCreate`.
   */
  processCsv = async(defName: string, operation: CsvOperation, request: CsvRequest, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return _processCsv(this.csvHost, defName, operation, request, context, selection);
  }

  /**
   * Apply several CSV uploads, each a create or an update on its own model, as
   * one all-or-nothing unit, rows in one file referring to rows another writes
   * through `@ref` labels. See `./engine/csv-import`. As with `processCsv`,
   * permission to perform each file's operation is the caller's to check.
   */
  processCsvImport = async(request: CsvImportRequest, context: RequestContext): Promise<CsvImportResult> => {
    return _processCsvImport(this.csvHost, request, context);
  }

  // -------------------------------------------------------------------------
  // Transaction coordination (delegating)
  // -------------------------------------------------------------------------

  transaction = async <T = unknown>(fn: (tx: import("./transaction").default) => Promise<T>): Promise<T> => {
    return _transaction(this, fn);
  }

  runWithContext = <T = unknown>(context: RequestContext, fn: () => T): T => {
    return _runWithContext(context, fn);
  }

  getContext = (): RequestContext => {
    return _getContext();
  }

  withTransaction = async <T>(defName: string, context: RequestContext, fn: (ctx: RequestContext) => Promise<T>): Promise<T> => {
    return _withTransaction(this.engine, this, defName, context, fn);
  }
}
