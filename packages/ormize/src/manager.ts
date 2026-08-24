import Cache from "./utils/cache";
import pluralize from "pluralize";
import {globalKeysFromFields} from "@azerothian/utilize/utils/global-keys";
import {relationshipAccessors} from "@azerothian/utilize/utils/relationship-accessors";
import {lowercase} from "@azerothian/utilize/utils/word";
import waterfall from "@azerothian/utilize/utils/waterfall";
import {capitalize} from "@azerothian/utilize/utils/word";
import { isStructurallyWritable } from "@azerothian/utilize/gate";
import { Definitions, GqlizeOptions, Definition, HookMap, Relationship, Model, Association, AnyTypedDef, ModelNameOf, IORModel, IORBase, BaseOf } from './types';
import { OrmAdapter, AdapterRow, AdapterQueryOptions, AdapterWhere, DataTypeDescriptor, NativeDataType,
  RequestContext, Selection, IncludeMap, FindAllArgs } from '@azerothian/utilize/types/index';
import { DataTypes } from "@azerothian/utilize/types/data-type";
import Events from "./events";
import OrmizeTransaction from "./transaction";
import { store, getStore } from "./context";

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
  "beforeDefine",
  "afterDefine",
  "beforeInit",
  "afterInit",
  "beforeAssociate",
  "afterAssociate",
  "beforeConnect",
  "afterConnect",
  "beforeSync",
  "afterSync",
  "beforeBulkSync",
  "afterBulkSync",
  "beforeQuery",
  "afterQuery",
];

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
export type HookFunction = (value: any, ...args: any[]) => any;

/**
 * An adapter row seen through its dynamically-named members: the relationship
 * accessors an adapter installs (`addFiles`, `setItem`, ...), `dataValues`,
 * `restore`. {@link AdapterRow} is `unknown` by contract, so the engine narrows
 * to this at the points that have to reach a member whose name is only known at
 * runtime.
 */
type InstanceRow = { [member: string]: any };

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

/**
 * The options bag ormize builds for an adapter call. `getGraphQLArgs` is what
 * hooks read to reach the caller's context and — under gqlize — the execution
 * `info`, so it is the one member every adapter can count on being there.
 */
export type ResolveOptions = AdapterQueryOptions & {
  getGraphQLArgs: () => { context: RequestContext; info: unknown; source: AdapterRow };
};

/** A caller-supplied filter, before relay global ids have been translated out of it. */
export type MutationFilter = AdapterWhere;

/** A caller-supplied field bag for a create or an update. */
export type MutationInput = { [field: string]: unknown };

/**
 * The relationship sub-mutations for one relationship, as they arrive nested in a
 * create/update input: `{files: {create: [...], add: [...]}}`. Every operation is
 * optional, and the singular forms (`belongsTo`/`hasOne`) take a single filter
 * where a collection takes a list of them.
 */
export type RelationshipMutation = {
  create?: MutationInput[];
  update?: { where?: MutationFilter; limit?: number; input?: MutationInput }[];
  delete?: MutationFilter[];
  /** `true` to detach a singular relationship; filters to detach from a collection. */
  remove?: true | MutationFilter[];
  /** `belongsToMany` entries are `{where, through}`; other collections pass the filter directly. */
  add?: (MutationFilter | { where?: MutationFilter; through?: MutationInput })[];
  set?: MutationFilter | (MutationFilter | { where?: MutationFilter; through?: MutationInput })[];
  restore?: MutationFilter | MutationFilter[];
  select?: { where?: MutationFilter; input?: MutationInput } | { where?: MutationFilter; input?: MutationInput }[];
};

/**
 * A mutation input as the engine reads it: scalar columns alongside a
 * {@link RelationshipMutation} under each relationship name. The two cannot be
 * told apart structurally, so `processInputs` allow-lists the scalars by field
 * name and `processRelationshipMutation` picks out the relationships by
 * association name.
 */
export type MutationInputTree = { [name: string]: unknown };

export default class Ormize<
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
  /** Vestigial: initialised empty and never written. */
  globalKeys: {[name: string]: unknown};
  hooks: {[defName: string]: HookMap};
  /** Vestigial: initialised empty and never written. */
  hookmap: {[name: string]: unknown};
  globalHooks: {[hookName: string]: HookFunction[] | HookFunction};
  cache:  Cache;
  defaultAdapter: string | undefined;
  constructor(options: GqlizeOptions = {}) {
    this.defs = {};
    this.defsAdapters = {};
    this.adapters = {};
    this.models = {} as TModels;
    this.relationships = {};
    this.globalKeys = {};
    this.hooks = {};
    this.hookmap = {};
    this.globalHooks = hookList.reduce((o, hookName) => {
      o[hookName] = (options.globalHooks || {})[hookName] || [];
      return o;
    }, {} as {[hookName: string]: HookFunction[] | HookFunction});
    this.cache = new Cache();
    this.defaultAdapter = undefined;
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
    if (!this.defaultAdapter) {
      this.defaultAdapter = adapter.adapterName;
    }
    this.adapters[adapter.adapterName] =  adapter;
    // The runtime is unchanged; the return type narrows the typesystem base URI
    // (e.g. "sequelize") from the adapter's `__base` brand so `define()` produces
    // adapter-typed models.
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
    return this as unknown as Ormize<
      TModels & { [K in ModelNameOf<D>]: IORModel<TBase, [D], []> },
      TBase
    >;
  }
  getDefinitionHooks = async(defName: string): Promise<HookMap> => {
    const def = this.getDefinition(defName);
    return (def.hooks || def.options?.hooks) || {};
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
      throw new Error(`Model definition does not have a adapter name defined`);
    }
    this.defs[def.name] = def;
    const adapter = this.adapters[datasource];
    this.defsAdapters[def.name] = datasource
    

    // Native Sequelize hooks are registered on the model; gqlize-only hooks
    // (e.g. afterCount) are composed for `runHook` but withheld from the adapter.
    const nativeHooks = hookList.reduce((o, hookName) => {
      o[hookName] = this.createHook(hookName, def);
      return o;
    }, {} as HookMap);
    this.hooks[def.name] = gqlizeHookList.reduce((o, hookName) => {
      o[hookName] = this.createHook(hookName, def);
      return o;
    }, { ...nativeHooks } as HookMap);

    (this.models as Record<string, any>)[def.name] = await adapter.createModel(def, nativeHooks);
  }

  createHook(hookName: string, def: Definition): HookFunction {
    return async(first: any, ...args: any[]) => {
      const hooks = await this.getDefinitionHooks(def.name as string);
      let v = first;
      if (hooks[hookName]) {
        const hook = hooks[hookName];
        if (Array.isArray(hook)) {
          if (hooks[hookName].length > 0) {
            v = await waterfall(hook, async(hook: HookFunction, f: any) => {
              return hook(f, ...args);
            }, v);
          }
        } else  if (hook instanceof Function) {
          v = await hook(v, ...args);
        } 
      }
      if (this.globalHooks[hookName]) {
        if (this.globalHooks[hookName] instanceof Function) {
          v = await (this.globalHooks[hookName] as HookFunction)(def.name, v, ...args);
        } else if (Array.isArray(this.globalHooks[hookName])) {
          if (this.globalHooks[hookName].length > 0) {
            v = await waterfall(this.globalHooks[hookName], async(hook: HookFunction, f: any) => {
              return hook(def.name, f, ...args);
            }, v);
          }
        }
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
      accessors: relationshipAccessors(rel.name, rel.funcName as string),
    };
  }
  getModelAdapter = (modelName: string) => {
    const adapterName = this.defsAdapters[modelName];
    return this.adapters[adapterName];
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
    const o = Object.assign({}, options);
    if (handle === undefined) {
      delete o.transaction;
    } else {
      o.transaction = handle;
    }
    // Same keys as what came in, one of them re-pointed — so the caller keeps the
    // certainty it had about whether it handed over an options bag at all.
    return o as T;
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
  processRelationship = async(def: Definition, sourceAdapter: OrmAdapter , rel: Relationship) => {
    const targetAdapter = this.getModelAdapter(rel.model);
    if(!def.name) {
      throw new Error(`Attempting to use a definition without a name: ${JSON.stringify(def)}`);
    }
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
      // if (!foreignKey) {
      //   throw new Error("TODO: Add foreignKey detection from adapter");
      // }
      return undefined;

    }
    this.relationships[def.name][rel.name].internal = false;
    const modelClass = sourceAdapter.getModel(def.name);
    const sourcePrimaryKeyName = sourceAdapter.getPrimaryKeyNameForModel(def.name)[0]; //TODO: check for edge case with multi primary key table
    let funcName = `get${capitalize(rel.model)}`;
    switch (rel.type) {
      case "hasMany":
        funcName = pluralize.plural(funcName);
        break;
      case "belongsTo":
      case "hasOne":
        funcName = pluralize.singular(funcName);
        break;
      case "belongsToMany":
        funcName = pluralize.plural(funcName);
        break;
      default:
        throw new Error(`Unknown relationship type ${rel.type}`);
    }
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
      // record, so there is no single find to proxy — see {@link crossAdapterBtmGetter}.
      this.addProxyAccessor(sourceAdapter, def.name, modelClass, funcName, this.crossAdapterBtmGetter(association));
    } else {
      const findFunc = await targetAdapter.createFunctionForFind(rel.model);
      // Captured out of the closure: the `!def.name` guard at the top of this
      // method narrows the property, but that narrowing does not survive into a
      // callback.
      const defName = def.name;
      const adaptOptions = (options: AdapterQueryOptions | undefined) => this.optionsForAdapter(defName, rel.model, options);
      // The proxy reads its join value off `this`, which is a *source* instance —
      // so the read goes through the source adapter, not the target's. `belongsTo`
      // keeps the key on the source and points at the target's `targetKey`; the
      // other two keep it on each target and point back at the source's `sourceKey`,
      // differing only in whether one row or many come back.
      const proxy = rel.type === "belongsTo"
        ? this.createProxyFunction(sourceAdapter, foreignKey, targetKey, true, findFunc, adaptOptions)
        : this.createProxyFunction(sourceAdapter, sourceKey, foreignKey, rel.type === "hasOne", findFunc, adaptOptions);
      this.addProxyAccessor(sourceAdapter, def.name, modelClass, funcName, proxy);
    }
    for (const [accessor, func] of Object.entries(this.crossAdapterWriteAccessors(association, sourceAdapter, targetAdapter))) {
      this.addProxyAccessor(sourceAdapter, def.name, modelClass, accessor, func);
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
        options: {timestamps: false},
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
  /** `mergeFilterStatement` on an adapter, with the error the missing case deserves. */
  private filterMerger(defName: string) {
    const adapter = this.getModelAdapter(defName);
    if (!adapter.mergeFilterStatement) {
      throw new Error(`Adapter '${adapter.adapterName}' cannot scope a query and so cannot take part in a cross-adapter relationship: it does not implement mergeFilterStatement`);
    }
    return adapter.mergeFilterStatement.bind(adapter);
  }
  /**
   * The target keys a cross-adapter `belongsToMany` currently links to, read from
   * the join model. Duplicated join rows collapse to one key.
   *
   * Only the transaction is carried over from the caller's options: everything
   * else in them (`where`, `limit`, `paranoid`, …) describes the *target* query
   * that these keys go on to scope, and would be nonsense against the join model.
   */
  private crossAdapterBtmKeys = async(association: Association, source: AdapterRow, options?: AdapterQueryOptions): Promise<unknown[]> => {
    const throughName = association.through as string;
    const sourceValue = this.getModelAdapter(association.source).getValueFromInstance(source, association.sourceKey);
    if (sourceValue === undefined || sourceValue === null) {
      return [];
    }
    const throughAdapter = this.getModelAdapter(throughName);
    const opts = await this.optionsForAdapter(association.source, throughName, options);
    const edges = await throughAdapter.findAll(throughName, {
      where: this.filterMerger(throughName)(association.foreignKey, sourceValue, true, undefined),
      ...(opts?.transaction !== undefined ? {transaction: opts.transaction} : {}),
    });
    const keys: unknown[] = [];
    const seen = new Set<unknown>();
    for (const edge of edges) {
      const value = throughAdapter.getValueFromInstance(edge, association.otherKey as string);
      if (value === undefined || value === null || seen.has(value)) {
        continue;
      }
      seen.add(value);
      keys.push(value);
    }
    return keys;
  }
  /**
   * The `get` accessor of a cross-adapter `belongsToMany`: resolve the linked keys
   * from the join model, then run one query on the target scoped to them. Going
   * through the target's own `findAll` (rather than fetching row by row) keeps a
   * caller-supplied `where`/`limit` working exactly as it does for the other types.
   */
  private crossAdapterBtmGetter(association: Association) {
    const self = this;
    const targetAdapter = this.getModelAdapter(association.target);
    return async function(this: InstanceRow, options?: AdapterQueryOptions) {
      const keys = await self.crossAdapterBtmKeys(association, this, options);
      if (keys.length === 0) {
        return [];
      }
      const opts = (await self.optionsForAdapter(association.source, association.target, options)) || {};
      return targetAdapter.findAll(association.target, {
        ...opts,
        where: self.filterMerger(association.target)(association.targetKey, keys, true, opts.where),
      });
    };
  }
  /**
   * The write half of a cross-adapter relationship. There is no native association
   * to delegate to, so linking and unlinking is done by writing the foreign key
   * directly — on the target for `hasMany`, on the source for `belongsTo`, and by
   * creating and deleting join rows for `belongsToMany`.
   *
   * These are installed under the same accessor names a native association would
   * use, so `processRelationshipMutation` drives them without knowing the
   * relationship spans two datastores. Note that each write is an independent
   * statement against its own adapter: they are only atomic when the whole
   * mutation runs inside `orm.transaction()`, which coordinates a transaction per
   * adapter.
   */
  private crossAdapterWriteAccessors(association: Association, sourceAdapter: OrmAdapter, targetAdapter: OrmAdapter) {
    const {foreignKey, sourceKey, targetKey, accessors} = association;
    const list = (targets: AdapterRow | AdapterRow[]) => (Array.isArray(targets) ? targets : [targets]).filter((t) => t !== undefined && t !== null);
    // Callers build one options object for the source's adapter; writes aimed at
    // the target's adapter need its own transaction handle instead.
    const forTarget = (options: AdapterQueryOptions | undefined) => this.optionsForAdapter(association.source, association.target, options);
    if (association.associationType === "belongsTo") {
      // The key lives on the source: pointing it elsewhere is a write to `this`.
      const set = async function(this: InstanceRow, target: AdapterRow, options?: AdapterQueryOptions) {
        const value = target ? targetAdapter.getValueFromInstance(target, targetKey) : null;
        return sourceAdapter.update(this, {[foreignKey]: value}, options as AdapterQueryOptions);
      };
      const clear = async function(this: InstanceRow, _target?: AdapterRow, options?: AdapterQueryOptions) {
        return sourceAdapter.update(this, {[foreignKey]: null}, options as AdapterQueryOptions);
      };
      return {
        [accessors.set]: set,
        [accessors.add]: set,
        [accessors.remove]: clear,
        [accessors.count]: async function(this: InstanceRow) {
          return sourceAdapter.getValueFromInstance(this, foreignKey) === null ? 0 : 1;
        },
      };
    }
    if (association.associationType === "belongsToMany") {
      // The link is a row of its own: (un)linking creates and deletes join rows on
      // whichever adapter hosts the through model — a third hop, independent of
      // both the source's and the target's.
      const self = this;
      const throughName = association.through as string;
      const otherKey = association.otherKey as string;
      // Resolved on use, not on wiring: a join model ormize generates itself is
      // only defined once every relationship has been read.
      const edgeWhere = (sourceValue: unknown, targetValues?: unknown) => {
        const merge = self.filterMerger(throughName);
        const where = merge(foreignKey, sourceValue, true, undefined);
        return targetValues === undefined ? where : merge(otherKey, targetValues, true, where);
      };
      // Only the transaction crosses over: the rest of the caller's options describe
      // the source's or the target's query, not the join model's.
      const forThrough = async(options: AdapterQueryOptions | undefined) => {
        const opts = await self.optionsForAdapter(association.source, throughName, options);
        return opts?.transaction !== undefined ? {transaction: opts.transaction} : {};
      };
      const link = async function(this: InstanceRow, targets: AdapterRow | AdapterRow[], options?: AdapterQueryOptions) {
        const sourceValue = sourceAdapter.getValueFromInstance(this, sourceKey);
        // `through` carries attribute values for the join row itself (the columns a
        // join table has beyond its two keys).
        const attributes: MutationInput = (options || {}).through || {};
        const opts = await forThrough(options);
        const throughAdapter = self.getModelAdapter(throughName);
        for (const target of list(targets)) {
          const targetValue = targetAdapter.getValueFromInstance(target, targetKey);
          const [existing] = await throughAdapter.findAll(throughName, {where: edgeWhere(sourceValue, targetValue), ...opts});
          if (!existing) {
            await throughAdapter.getCreateFunction(throughName)({[foreignKey]: sourceValue, [otherKey]: targetValue, ...attributes}, opts);
          } else if (Object.keys(attributes).length > 0) {
            await throughAdapter.update(existing, attributes, opts);
          }
        }
      };
      const unlinkWhere = async(where: AdapterWhere, options: AdapterQueryOptions | undefined) => {
        const opts = await forThrough(options);
        await self.getModelAdapter(throughName).getDeleteFunction(throughName, undefined)(where, opts, (r) => r, (r) => r);
      };
      const unlink = async function(this: InstanceRow, targets: AdapterRow | AdapterRow[], options?: AdapterQueryOptions) {
        const sourceValue = sourceAdapter.getValueFromInstance(this, sourceKey);
        const targetValues = list(targets).map((t) => targetAdapter.getValueFromInstance(t, targetKey));
        if (targetValues.length === 0) {
          return;
        }
        await unlinkWhere(edgeWhere(sourceValue, targetValues), options);
      };
      return {
        [accessors.add]: link,
        [accessors.addMultiple]: link,
        [accessors.remove]: unlink,
        [accessors.removeMultiple]: unlink,
        // `set` replaces the whole collection: drop every join row, then relink.
        [accessors.set]: async function(this: InstanceRow, targets: AdapterRow | AdapterRow[], options?: AdapterQueryOptions) {
          await unlinkWhere(edgeWhere(sourceAdapter.getValueFromInstance(this, sourceKey)), options);
          return link.call(this, targets, options);
        },
        [accessors.count]: async function(this: InstanceRow, options?: AdapterQueryOptions) {
          return (await self.crossAdapterBtmKeys(association, this, options)).length;
        },
      };
    }
    // hasMany/hasOne: the key lives on each target, so (un)linking writes there.
    const relink = (value: (self: InstanceRow) => unknown) => async function(this: InstanceRow, targets: AdapterRow | AdapterRow[], options?: AdapterQueryOptions) {
      const fk = value(this);
      const opts = await forTarget(options);
      for (const target of list(targets)) {
        await targetAdapter.update(target, {[foreignKey]: fk}, opts as AdapterQueryOptions);
      }
    };
    const link = relink((self) => sourceAdapter.getValueFromInstance(self, sourceKey));
    const unlink = relink(() => null);
    return {
      [accessors.add]: link,
      [accessors.addMultiple]: link,
      [accessors.remove]: unlink,
      [accessors.removeMultiple]: unlink,
      // `set` replaces the whole collection: drop the ones no longer in it, then link.
      [accessors.set]: async function(this: InstanceRow, targets: AdapterRow | AdapterRow[], options?: AdapterQueryOptions) {
        const next = list(targets);
        const nextKeys = new Set(next.map((t) => targetAdapter.getValueFromInstance(t, targetKey)));
        const current = await this[accessors.get](options);
        const opts = await forTarget(options);
        for (const existing of list(current)) {
          if (!nextKeys.has(targetAdapter.getValueFromInstance(existing, targetKey))) {
            await targetAdapter.update(existing, {[foreignKey]: null}, opts as AdapterQueryOptions);
          }
        }
        return link.call(this, next, options);
      },
      [accessors.count]: async function(this: InstanceRow, options?: AdapterQueryOptions) {
        return list(await this[accessors.get](options)).length;
      },
    };
  }
  /**
   * Install the cross-adapter accessor (`getFiles()`, `getItem()`, …) on the
   * source model. Class-based adapters (Sequelize) take it on the prototype;
   * adapters whose "model" is a plain descriptor rather than a constructor get
   * it via `addInstanceFunction`, and those with neither simply go without —
   * the GraphQL and `resolveXRelationship` paths do not depend on it.
   */
  private addProxyAccessor(sourceAdapter: OrmAdapter, defName: string, modelClass: Model | undefined, funcName: string, func: (...args: any[]) => any) {
    if (modelClass?.prototype) {
      // Installing by name onto a prototype the adapter's own types describe
      // without an index signature — see {@link Model.prototype}.
      (modelClass.prototype as Record<string, unknown>)[funcName] = func;
      return;
    }
    if (sourceAdapter.addInstanceFunction) {
      sourceAdapter.addInstanceFunction(defName, funcName, func);
    }
  }
  createProxyFunction(adapter: OrmAdapter, sourceKey: string, filterKey: string, singular: boolean, findFunc: (keyValue: string, filterKey: string, singular: boolean) => ((options: AdapterQueryOptions) => Promise<AdapterRow>), adaptOptions?: (options: AdapterQueryOptions | undefined) => Promise<AdapterQueryOptions | undefined>)  {
    return async function(this: InstanceRow, options?: AdapterQueryOptions) {
      // The join key — whatever column `sourceKey` names, so its type belongs to
      // the definition, not to this layer. `getValueFromInstance` returns
      // `unknown` for that reason; the find function takes it as given.
      const keyValue = adapter.getValueFromInstance(this, sourceKey) as string;
      // The find runs on the *target's* adapter while `options` were built for the
      // source's, so any transaction handle in them has to be swapped first.
      const opts = adaptOptions ? await adaptOptions(options) : options;
      return findFunc(keyValue, filterKey, singular)
        .call(this, opts as AdapterQueryOptions);
    };
  }
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
    await Promise.all(Object.keys(this.adapters).map((adapterName) => {
      const adapter = this.adapters[adapterName];
      return adapter.initialise();
    }));
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
  resolveClassMethod = async(defName: string, methodName: string, args: unknown, context: RequestContext,
    before?: (args: unknown, context: RequestContext) => unknown,
    after?: (result: unknown, context: RequestContext) => unknown) => {
    const Model = this.getModel(defName);
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
    const Model = this.getModel(defName) as unknown as abstract new (...args: any[]) => unknown;
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
   * Resolve the join key for a cross-adapter relationship: which field on the
   * *target* to filter, and the value to filter it by, read off the source
   * instance through the source adapter (a Sequelize instance and a Valkey
   * record expose their values differently).
   *
   * `belongsTo` keeps the foreign key on the source and points at the target's
   * `targetKey`; `hasMany`/`hasOne` keep it on the target and point back at the
   * source's `sourceKey`. `belongsToMany` keeps it on neither — the pair comes
   * from the join model, so the scope is a *list* of target keys (which the
   * adapters' `mergeFilterStatement` turns into an `in`) and reading it costs a
   * query of its own.
   */
  private crossAdapterScope = async(association: Association, source: AdapterRow, options?: AdapterQueryOptions) => {
    if (association.associationType === "belongsToMany") {
      return {field: association.targetKey, value: await this.crossAdapterBtmKeys(association, source, options)};
    }
    const sourceAdapter = this.getModelAdapter(association.source);
    const belongsTo = association.associationType === "belongsTo";
    const onSource = belongsTo ? association.foreignKey : association.sourceKey;
    const onTarget = belongsTo ? association.targetKey : association.foreignKey;
    return {field: onTarget, value: sourceAdapter.getValueFromInstance(source, onSource)};
  }
  /**
   * A cross-adapter relationship is just a root query on the target model scoped
   * to the join key — the target's adapter cannot see the source's rows, so there
   * is nothing to JOIN and no accessor to call. Routing it through
   * {@link resolveFindAll} keeps `where`, ordering, pagination, count-only and
   * the target model's own hooks behaving exactly as they do at the root.
   */
  private resolveCrossAdapterRelationship = async(defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection) => {
    const scope = await this.crossAdapterScope(association, source, context);
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
      return this.resolveCrossAdapterRelationship(defName, association, source, args, context, selection);
    }
    const options = createResolveContext(context, selection, source);
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    const a = args;
    const offset = cursorOffset(args);
    // Count-only: the nested connection selects `total` but not `edges`/rows — the
    // adapter runs a count instead of a findAll (fires beforeCount natively); fire
    // afterCount here.
    const countOnly = Boolean(selection?.countOnly);
    const result = await adapter.resolveManyRelationship(defName, association, source, a, offset, definition.whereOperators, selection as Selection, options, countOnly);
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
    const adapter = this.getModelAdapter(defName);
    const options = createResolveContext(context, selection, source);
    // afterFind for JOIN-eager single relations is fired by resolveFindAll's post-pass.
    return adapter.resolveSingleRelationship(defName, association, source, args, context, selection as Selection, options);
  }
  /**
   * @param scope optional `{field, value}` equality filter merged into the built
   * query on top of the caller's `where`. Used to scope a cross-adapter
   * relationship to its join key.
   */
  resolveFindAll = async(defName: string, source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection, scope?: {field: string, value: unknown}) => {
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const options = createResolveContext(context, selection, source);
    const a = args;
    const selectedFields = selection?.fields;
    // The eager-include plan is built by the caller (gqlize, from the GraphQL
    // selection set) and passed via `selection.include`; apply it when the args
    // don't already carry one.
    if (selection?.include && !a.include) {
      a.include = selection.include;
    }
    const offset = cursorOffset(args);
    const {getOptions, countOptions} = await adapter.processListArgsToOptions(defName, a, offset, selection as Selection, definition.whereOperators, options, selectedFields, this.runHook);
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
    }
    // Count-only: the connection selects `total` but not `edges`/rows — skip the
    // findAll and run a count (fires beforeCount natively + afterCount manually).
    if (Boolean(selection?.countOnly)) {
      const countOnlyOptions = countOptions || {
        where: getOptions.where,
        include: (getOptions.include || []).filter((i: {required?: boolean, separate?: boolean}) => i.required && !i.separate),
        getGraphQLArgs: getOptions.getGraphQLArgs,
      };
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
      total = await adapter.count(defName, countOptions);
    }
    return {
      total, models,
    };
  }
  processInputs = async(defName: string, input: MutationInputTree, args: unknown, context: RequestContext, info: unknown, model?: AdapterRow): Promise<MutationInput> => {
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
    return i;
  }
  processRelationshipMutation = async(defName: string, source: AdapterRow, input: MutationInputTree | undefined, context: RequestContext, selection?: Selection) => {
    if (!input) {
      // A select with no `input` is a plain find — there is nothing nested to
      // apply. Reading `input[key]` per association would throw on the way past.
      return source;
    }
    const translateFilter = selection?.translateFilter || (<W,>(w: W) => w);
    // A collection's getter returns an array, a singular relationship's returns one
    // record or null — every branch below treats what it got back as a list.
    const asList = (res: unknown): InstanceRow[] => Array.isArray(res) ? res : (res ? [res] : []);
    const associations = this.getAssociations(defName);
    const defaultOptions = createResolveContext(context, selection, source);
    // The relationship accessors are reached off the row by name — see {@link InstanceRow}.
    const row = source as InstanceRow;
    await waterfall(Object.keys(associations), async(key: string) => {
      const association = associations[key];
      const targetName = association.target;
      const targetAdapter = this.getModelAdapter(targetName);
      const targetGlobalKeys = this.getGlobalKeys(targetName);
      const targetDef = this.getDefinition(targetName);
      if (input[key]) {
        // Anything handed to the target's adapter needs that adapter's transaction
        // handle: for a cross-adapter relationship the one in `defaultOptions` /
        // `context` was opened by this model's adapter and is meaningless there.
        // (Resolving it enrols the target adapter in the unit of work, so only do
        // it for a relationship the mutation actually touches.)
        const targetOptions = await this.optionsForAdapter(defName, targetName, defaultOptions);
        const targetContext = await this.optionsForAdapter(defName, targetName, context);
        const args = input[key] as RelationshipMutation;
        const singular = association.associationType === "belongsTo" || association.associationType === "hasOne";
        const isBtm = association.associationType === "belongsToMany";
        if (args.create) {
          await waterfall(args.create, async(arg: MutationInput) => {
            if (targetDef.before) {
              arg = await targetDef.before({
                params: arg, args, context, info: selection?.raw,
                modelDefinition: targetDef,
                type: Events.MUTATION_CREATE,
              });
            }

            const [result] = await this.processCreate(targetName, source, {input: arg}, targetContext, selection);

            switch (association.associationType) {
              case "hasMany":
              case "belongsToMany":
                await row[association.accessors.add](result, defaultOptions);
                break;
              default:
                await row[association.accessors.set](result, defaultOptions);
                break;
            }

          });
        }
        if (args.update) {
          await waterfall(args.update, async(arg: { where?: MutationFilter; limit?: number; input?: MutationInput }) => {
            const {where, limit, input} = arg;
            const whereObj = await targetAdapter.processFilterArgument(translateFilter(where, targetGlobalKeys), targetDef.whereOperators, targetOptions);
            const targets = asList(await row[association.accessors.get]({
              limit,
              where: whereObj,
              ...defaultOptions
            }));
            let i: MutationInput = await this.processInputs(targetName, input as MutationInputTree, args, targetContext, selection?.raw);
            if (targetDef.before) {
              i = await targetDef.before({
                params: input, args, context, info: selection?.raw,
                modelDefinition: targetDef,
                type: Events.MUTATION_UPDATE,
              });
            }
            await Promise.all(targets.map(async(model: InstanceRow) => {
              const m = await targetAdapter.update(model, i, targetOptions);
              const defName = targetDef.name as string;
              await this.processRelationshipMutation(defName, m, input as MutationInputTree, targetContext, selection);
              return m;
            }));
          });
        }
        if (args.delete) {
          await waterfall(args.delete, async(arg: MutationFilter) => {
            const targets = asList(await row[association.accessors.get](Object.assign({
              where: await targetAdapter.processFilterArgument(translateFilter(arg, targetGlobalKeys), targetDef.whereOperators, targetOptions),
            }, defaultOptions)));
            await Promise.all(targets.map(async(model: InstanceRow) => {
              const defName = targetDef.name as string;
              await this.processRelationshipMutation(defName, model, input as MutationInputTree, targetContext, selection);
              if (targetDef.before) {
                await targetDef.before({
                  params: model, args, context, info: selection?.raw,
                  model, modelDefinition: targetDef,
                  type: Events.MUTATION_DELETE,
                });
              }
              await this.processDelete(defName, source, arg, targetContext, selection);
              return model;
            }));
          });
        }
        if (args.remove !== undefined && args.remove !== null) {
          if (singular) {
            // belongsTo/hasOne: disassociate by nulling the relationship.
            if (args.remove === true) {
              await row[association.accessors.set](null, defaultOptions);
            }
          } else {
            // The list forms are the collection branch of each pair — a singular
            // relationship takes one filter, and is handled above.
            await waterfall(args.remove as MutationFilter[], async(arg: MutationFilter) => {
              const where = await targetAdapter.processFilterArgument(translateFilter(arg, targetGlobalKeys), targetDef.whereOperators, targetOptions);
              const results = await targetAdapter.findAll(targetName, Object.assign({
                where,
              }, targetOptions));
              if (results.length > 0) {
                return row[association.accessors.removeMultiple](results, defaultOptions);
              }
              return undefined;
            });
          }
        }

        if (args.add) {
          await waterfall(args.add, async(arg: MutationFilter | { where?: MutationFilter; through?: MutationInput }) => {
            // belongsToMany add entries are `{ where, through }`; other collections
            // pass the filter directly.
            const entry = (arg || {}) as { where?: MutationFilter; through?: MutationInput };
            const filter = isBtm ? entry.where : (arg as MutationFilter);
            const through = isBtm ? entry.through : undefined;
            const where = await targetAdapter.processFilterArgument(translateFilter(filter, targetGlobalKeys), targetDef.whereOperators, targetOptions);
            const results = await targetAdapter.findAll(targetName, Object.assign({
              where,
            }, targetOptions));
            if (results.length > 0) {
              return row[association.accessors.addMultiple](results, through !== undefined ? Object.assign({through}, defaultOptions) : defaultOptions);
            }
            return undefined;
          });
        }

        if (args.set !== undefined && args.set !== null) {
          if (singular) {
            // belongsTo/hasOne: associate one existing record found by filter.
            const where = await targetAdapter.processFilterArgument(translateFilter(args.set as MutationFilter, targetGlobalKeys), targetDef.whereOperators, targetOptions);
            const found = await targetAdapter.findAll(targetName, Object.assign({where, limit: 1}, targetOptions));
            await row[association.accessors.set](found[0] || null, defaultOptions);
          } else {
            // Collections: replace the entire set with all matching existing records.
            const all: AdapterRow[] = [];
            let through: MutationInput | undefined;
            await waterfall(args.set as (MutationFilter | { where?: MutationFilter; through?: MutationInput })[], async(arg: MutationFilter | { where?: MutationFilter; through?: MutationInput }) => {
              const entry = (arg || {}) as { where?: MutationFilter; through?: MutationInput };
              const filter = isBtm ? entry.where : (arg as MutationFilter);
              if (isBtm && entry.through !== undefined) {
                through = entry.through;
              }
              const where = await targetAdapter.processFilterArgument(translateFilter(filter, targetGlobalKeys), targetDef.whereOperators, targetOptions);
              const results = await targetAdapter.findAll(targetName, Object.assign({where}, targetOptions));
              all.push(...results);
              return undefined;
            });
            await row[association.accessors.set](all, through !== undefined ? Object.assign({through}, defaultOptions) : defaultOptions);
          }
        }

        if (args.restore !== undefined && args.restore !== null) {
          // Restore soft-deleted (paranoid) related records scoped to this relationship.
          const restoreByFilter = async(arg: MutationFilter) => {
            const where = await targetAdapter.processFilterArgument(translateFilter(arg, targetGlobalKeys), targetDef.whereOperators, targetOptions);
            const res = await row[association.accessors.get](Object.assign({where, paranoid: false}, defaultOptions));
            const records = asList(res);
            await Promise.all(records
              .filter((r) => r && r.deletedAt)
              .map((r) => r.restore(targetOptions)));
          };
          if (singular) {
            await restoreByFilter(args.restore as MutationFilter);
          } else {
            await waterfall(args.restore as MutationFilter[], restoreByFilter);
          }
        }

        if (args.select !== undefined && args.select !== null) {
          // Find related records (scoped to this relationship via the get accessor,
          // so beforeFind/afterFind fire) and run further relationship mutations on
          // them via `arg.input`. The selected records themselves are NOT modified —
          // no field write, no create/update/delete; scalar fields in `input` are
          // ignored (only relationship sub-mutations are applied).
          const selectByFilter = async(arg: { where?: MutationFilter; input?: MutationInput }) => {
            const where = await targetAdapter.processFilterArgument(translateFilter(arg.where, targetGlobalKeys), targetDef.whereOperators, targetOptions);
            const res = await row[association.accessors.get](Object.assign({where}, defaultOptions));
            const records = asList(res);
            await waterfall(records, async(m: InstanceRow) => {
              await this.processRelationshipMutation(targetDef.name as string, m, arg.input as MutationInputTree, targetContext, selection);
            });
          };
          if (singular) {
            await selectByFilter(args.select as { where?: MutationFilter; input?: MutationInput });
          } else {
            await waterfall(args.select as { where?: MutationFilter; input?: MutationInput }[], selectByFilter);
          }
        }
      }
    });
    return source;
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
      return fn(Object.assign({}, context, { transaction: handle }));
    }
    if (context && context.transaction) {
      return fn(context);
    }
    const adapter = this.adapters[adapterName];
    if (!adapter || (typeof adapter.beginTransaction !== "function" && typeof adapter.transaction !== "function")) {
      return fn(context);
    }
    return this.transaction(async() => this.withTransaction(defName, context, fn));
  }

  processCreate = async(defName: string, source: AdapterRow, args: { input: MutationInputTree }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return this.withTransaction(defName, context, async(context: RequestContext) => {
    const translateFilter = selection?.translateFilter || (<W,>(w: W) => w);
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    const processCreate = adapter.getCreateFunction(defName);
    const globalKeys = this.getGlobalKeys(defName);
    let i = await this.processInputs(defName, args.input, args, context, selection?.raw);
    let input = translateFilter(i, globalKeys);
    if (definition.before) {
      input = await definition.before({
        params: input, args, context, info: selection?.raw,
        modelDefinition: definition,
        type: Events.MUTATION_CREATE,
      });
    }
    let result: AdapterRow;
    if (Object.keys(input).length > 0) {
      result = await processCreate(input, createResolveContext(context, selection, source));

      if (result !== undefined && result !== null) {
        result = await this.processRelationshipMutation(defName, result, args.input, context, selection);
        return [result];
      }

    }
    return [];
    });
  }

  processUpdate = async(defName: string, source: AdapterRow, args: { input: MutationInputTree; where: MutationFilter; limit?: number }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return this.withTransaction(defName, context, async(context: RequestContext) => {
    const translateFilter = selection?.translateFilter || (<W,>(w: W) => w);
    const translateId = selection?.translateId || ((v: unknown) => v);
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const processUpdate = adapter.getUpdateFunction(defName, definition.whereOperators);
    const globalKeys = this.getGlobalKeys(defName);

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
          o[k] = translateId(v);
        }
      } else {
        o[k] = args.input[k];
      }
      return o;
    }, {} as MutationInput);
    const where = translateFilter(args.where, globalKeys);
    if (definition.before) {
      i = await definition.before({
        params: i, args, context, info: selection?.raw,
        modelDefinition: definition,
        type: Events.MUTATION_UPDATE,
      });
    }
    const results = await processUpdate(where, (model) => {
      return this.processInputs(defName, i, args, context, selection?.raw, model);
    }, createResolveContext(context, selection, source, {limit: args.limit}));

    await waterfall(results, async(r: AdapterRow) => {
      await this.processRelationshipMutation(defName, r, args.input, context, selection);
    });

    return results;
    });
  }
  processSelect = async(defName: string, source: AdapterRow, args: { input?: MutationInputTree; where?: MutationFilter; limit?: number }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return this.withTransaction(defName, context, async(context: RequestContext) => {
    const translateFilter = selection?.translateFilter || (<W,>(w: W) => w);
    // Find matching elements and run relationship mutations on them via `args.input`
    // WITHOUT modifying the elements themselves (no field write / lifecycle change);
    // scalar fields in `input` are ignored. Returns the found rows so the caller can
    // select fields back.
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const globalKeys = this.getGlobalKeys(defName);
    const options = createResolveContext(context, selection, source, {limit: args.limit});
    const where = await adapter.processFilterArgument(
      translateFilter(args.where, globalKeys),
      definition.whereOperators,
      options,
    );
    const results = await adapter.findAll(defName, Object.assign({where, limit: args.limit}, options));
    await waterfall(results, async(r: AdapterRow) => {
      await this.processRelationshipMutation(defName, r, args.input, context, selection);
    });
    return results;
    });
  }
  processDelete = async(defName: string, source: AdapterRow, args: MutationFilter, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return this.withTransaction(defName, context, async(context: RequestContext) => {
    const translateFilter = selection?.translateFilter || (<W,>(w: W) => w);
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const processDelete = adapter.getDeleteFunction(defName, definition.whereOperators);
    const globalKeys = this.getGlobalKeys(defName);
    const where = translateFilter(args, globalKeys);
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
    const after = (model: AdapterRow) => {
      return model;

    };
    return processDelete(where, createResolveContext(context, selection, source), before, after);
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
