import Cache from "./utils/cache";
import pluralize from "pluralize";
import {globalKeysFromFields} from "@azerothian/utilize/utils/global-keys";
import {relationshipAccessors} from "@azerothian/utilize/utils/relationship-accessors";
import {lowercase} from "@azerothian/utilize/utils/word";
import waterfall from "@azerothian/utilize/utils/waterfall";
import {capitalize} from "@azerothian/utilize/utils/word";
import { isStructurallyWritable } from "@azerothian/utilize/gate";
import { Definitions, GqlizeOptions, Definition, HookMap, Relationship, Association, AnyTypedDef, ModelNameOf, IORModel, IORBase, BaseOf } from './types';
import { OrmAdapter, AdapterRow, AdapterQueryOptions, DataTypeDescriptor, NativeDataType,
  RelationshipType, RequestContext, Selection, IncludeMap, FindAllArgs } from '@azerothian/utilize/types/index';
import { DataTypes } from "@azerothian/utilize/types/data-type";
import type { InstanceRow, MutationFilter, MutationHost, MutationInput,
  MutationInputTree, ResolveOptions } from "./types/engine";
import { addProxyAccessor, btmGetter, createProxyFunction, joinScope, writeAccessors } from "./cross-adapter";
import { applyRelationshipMutations } from "./relationship-mutations";
import Events from "./events";
import OrmizeTransaction from "./transaction";
import { store, getStore } from "./context";

/** The relationship types ormize knows how to wire; `Relationship.type` is a widened string. */
const relationshipTypes: string[] = Object.values(RelationshipType);

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
    this.defs[def.name] = def;
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
    }, { ...nativeHooks });

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
          v = await (this.globalHooks[hookName])(def.name, v, ...args);
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
    const o = Object.assign({}, options);
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
      // record, so there is no single find to proxy — see {@link btmGetter}.
      addProxyAccessor(sourceAdapter, def.name, modelClass, funcName, btmGetter(this.host, association));
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
        ? createProxyFunction(sourceAdapter, foreignKey, targetKey, true, findFunc, adaptOptions)
        : createProxyFunction(sourceAdapter, sourceKey, foreignKey, rel.type === "hasOne", findFunc, adaptOptions);
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
    processInputs: (defName, input, args, context, info, model) => this.processInputs(defName, input, args, context, info, model),
    processCreate: (defName, source, args, context, selection) => this.processCreate(defName, source, args, context, selection),
    processDelete: (defName, source, args, context, selection) => this.processDelete(defName, source, args, context, selection),
    processRelationshipMutation: (defName, source, input, context, selection) => this.processRelationshipMutation(defName, source, input, context, selection),
  };
  /**
   * @deprecated Kept for the published surface; prefer the free
   * `createProxyFunction` in `./cross-adapter`, which this forwards to.
   */
  createProxyFunction(adapter: OrmAdapter, sourceKey: string, filterKey: string, singular: boolean, findFunc: (keyValue: string, filterKey: string, singular: boolean) => ((options: AdapterQueryOptions) => Promise<AdapterRow>), adaptOptions?: (options: AdapterQueryOptions | undefined) => Promise<AdapterQueryOptions | undefined>)  {
    return createProxyFunction(adapter, sourceKey, filterKey, singular, findFunc, adaptOptions);
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
    this.validateCrossAdapterKeys();
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
    const result = await adapter.resolveManyRelationship(defName, association, source, {
      args: a, offset, selection, whereOperators: definition.whereOperators, options, countOnly,
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
    const adapter = this.getModelAdapter(defName);
    const options = createResolveContext(context, selection, source);
    // afterFind for JOIN-eager single relations is fired by resolveFindAll's post-pass.
    return adapter.resolveSingleRelationship(defName, association, source, {args, selection, context, options});
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
    const {getOptions, countOptions} = await adapter.processListArgsToOptions(defName, {
      args: a, offset, selection, whereOperators: definition.whereOperators, options, selectedFields,
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
    }
    // Count-only: the connection selects `total` but not `edges`/rows — skip the
    // findAll and run a count (fires beforeCount natively + afterCount manually).
    if (selection?.countOnly) {
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
      return fn(Object.assign({}, context, { transaction: handle }));
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
      translateFilter: NonNullable<Selection["translateFilter"]>;
    }) => Promise<T>,
  ): Promise<T> => {
    return this.withTransaction(defName, context, (context: RequestContext) => fn({
      context,
      adapter: this.getModelAdapter(defName),
      definition: this.getDefinition(defName),
      globalKeys: this.getGlobalKeys(defName),
      translateFilter: selection?.translateFilter || (<W,>(w: W) => w),
    }));
  }

  processCreate = async(defName: string, source: AdapterRow, args: { input: MutationInputTree }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return this.mutationEntry(defName, context, selection, async({context, adapter, definition, globalKeys, translateFilter}) => {
      const processCreate = adapter.getCreateFunction(defName);
      const i = await this.processInputs(defName, args.input, args, context, selection?.raw);
      let input = translateFilter(i, globalKeys);
      if (definition.before) {
        input = await definition.before({
          params: input, args, context, info: selection?.raw,
          modelDefinition: definition,
          type: Events.MUTATION_CREATE,
        });
      }
      if (Object.keys(input).length > 0) {
        let result = await processCreate(input, createResolveContext(context, selection, source));
        if (result !== undefined && result !== null) {
          result = await this.processRelationshipMutation(defName, result, args.input, context, selection);
          return [result];
        }
      }
      return [];
    });
  }

  processUpdate = async(defName: string, source: AdapterRow, args: { input: MutationInputTree; where: MutationFilter; limit?: number }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]> => {
    return this.mutationEntry(defName, context, selection, async({context, adapter, definition, globalKeys, translateFilter}) => {
      const translateId = selection?.translateId || ((v: unknown) => v);
      const processUpdate = adapter.getUpdateFunction(defName, definition.whereOperators);
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
    // Find matching elements and run relationship mutations on them via `args.input`
    // WITHOUT modifying the elements themselves (no field write / lifecycle change);
    // scalar fields in `input` are ignored. Returns the found rows so the caller can
    // select fields back.
    return this.mutationEntry(defName, context, selection, async({context, adapter, definition, globalKeys, translateFilter}) => {
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
    return this.mutationEntry(defName, context, selection, async({context, adapter, definition, globalKeys, translateFilter}) => {
      const processDelete = adapter.getDeleteFunction(defName, definition.whereOperators);
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
      const after = (model: AdapterRow) => model;
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
