import Cache from "./utils/cache";
import pluralize from "pluralize";
import waterfall from "@azerothian/gqlize-shared/utils/waterfall";
import {capitalize} from "@azerothian/gqlize-shared/utils/word";
import { Definitions, GqlizeOptions, Definition, HookMap, Relationship, Model, Association, AnyTypedDef, ModelNameOf, IORModel, IORBase, BaseOf } from './types';
import { OrmAdapter, DataTypeDescriptor, Selection } from '@azerothian/gqlize-shared/types/index';
import Events from "./events";

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
  relationships: {[name: string]: any};
  globalKeys: {[name: string]: any};
  hooks: {[defName: string]: HookMap};
  hookmap: {[name: string]: any};
  globalHooks: {[name: string]: any};
  // this.reference = {};
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
    }, {} as {[name: string]: any});
    // this.reference = {};
    this.cache = new Cache();
    this.defaultAdapter = undefined;
  }
  addHook = (hookName: string, hook: any) => {
    this.globalHooks[hookName].push(hook);
  }
  addHookObject = (hooks: { [x: string]: any; }) => {
    return Object.keys(hooks).forEach((h) => {
      const hook = hooks[h];
      return this.addHook(h, hook);
    });
  }
  unshiftHook = (hookName: string, hook: any) => {
    this.globalHooks[hookName].unshift(hook);
  }
  unshiftHookObject = (hooks: { [x: string]: any; }) => {
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
  getDefinitionHooks = async(defName: any) => {
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
    
    // this.hookmap[def.name] = this.generateHookMap(def.name);

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

  createHook(hookName: string, def: Definition) {
    return async(first: any, ...args: any) => {
      const hooks = await this.getDefinitionHooks(def.name);
      let v = first;
      if (hooks[hookName]) {
        const hook = hooks[hookName];
        if (Array.isArray(hook)) {
          if (hooks[hookName].length > 0) {
            v = await waterfall(hook, async(hook: (...arg0: any) => any, f: any) => {
              return hook(f, ...args);
            }, v);
          }
        } else  if (hook instanceof Function) {
          v = await hook(v, ...args);
        } 
      }
      if (this.globalHooks[hookName]) {
        if (this.globalHooks[hookName] instanceof Function) {
          v = await this.globalHooks[hookName](def.name, v, ...args);
        } else if (Array.isArray(this.globalHooks[hookName])) {
          if (this.globalHooks[hookName].length > 0) {
            v = await waterfall(this.globalHooks[hookName], async(hook: (defName: any, arg1: any, ...arg2: any) => any, f: any) => {
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
  runHook = async(defName: string, hookName: string, value: any, ...args: any) => {
    const hooks = this.hooks[defName];
    if (hooks && hooks[hookName]) {
      return (hooks[hookName] as (...a: any) => any)(value, ...args);
    }
    return value;
  }

  /**
   * Fire the child model's afterFind for JOIN-loaded relations in an include plan.
   * Sequelize does not run a JOIN-included model's find hooks, so this emulates
   * them on the eager-loaded values. `separate` entries are skipped (they fired
   * natively via their own query). Recurses into nested JOIN includes.
   */
  applyEagerAfterFind = async(planMap: any, instances: any[], options: any): Promise<void> => {
    if (!planMap || !Array.isArray(instances) || instances.length === 0) {
      return;
    }
    for (const relName of Object.keys(planMap)) {
      const desc = planMap[relName];
      if (!desc || desc.separate || !desc.target) {
        continue;
      }
      const nested = desc.include && desc.include[0];
      for (const inst of instances) {
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
  getDefinition = (defName: string | number) => {
    return this.defs[defName];
  }
  getGlobalKeys = (defName: any) => {
    const fields = this.getFields(defName);
    return Object.keys(fields).filter((key) => {
      return (fields[key].foreignKey || fields[key].primaryKey) && !fields[key].ignoreGlobalKey;
    });
  }
  getFields = (defName: any) => {
    const adapter = this.getModelAdapter(defName);
    //TODO: add cross adapter fields
    return adapter.getFields(defName);
  }
  getAssociations = (defName: string) => {
    const adapter = this.getModelAdapter(defName);
    //TODO: add cross adapter relationships
    return adapter.getAssociations(defName);
  }
  getModelAdapter = (modelName: string) => {
    const adapterName = this.defsAdapters[modelName];
    return this.adapters[adapterName];
  }
  /**
   * Convert an adapter-native type (e.g. `Sequelize.DataTypes.STRING`) into the
   * abstract ormize `DataType` descriptor via the chosen adapter (defaults to the
   * sole/first registered adapter). e.g. `mapDataType(Sequelize.DataTypes.STRING)`
   * → `{ type: DataType.String }`.
   */
  mapDataType = (nativeType: any, adapterName?: string): DataTypeDescriptor => {
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
    let {foreignKey} = rel.options;
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
        funcName = pluralize.singular(funcName);
        break;
    }
    this.relationships[def.name][rel.name].funcName = funcName;
    // const {foreignKey} = rel.options;
    if (!foreignKey) {
      throw new Error(`For cross adapter relationships you must define a foreign key ${def.name} (${rel.type}) ${rel.model}: ${rel.name}`);
    }
    let sourceKey = rel.options?.sourceKey || sourcePrimaryKeyName;
    const findFunc = await targetAdapter.createFunctionForFind(rel.model);
    switch (rel.type) {
      case "hasMany":
        modelClass.prototype[funcName] =
          this.createProxyFunction(targetAdapter, sourceKey, foreignKey, false, findFunc);
        return undefined;
      case "belongsTo":
        modelClass.prototype[funcName] =
          this.createProxyFunction(targetAdapter, foreignKey, sourceKey, true, findFunc);
        return undefined;
    }
    throw new Error(`Unknown relationship type ${rel.type}`);
  }
  createProxyFunction(adapter: OrmAdapter, sourceKey: string, filterKey: string, singular: boolean, findFunc: (keyValue: string, filterKey: string, singular: boolean) => ((...args: any) => any))  {
    return function(this: Model) {
      const keyValue = adapter.getValueFromInstance(this, sourceKey);
      return findFunc(keyValue, filterKey, singular)
        .apply(this, Array.from(arguments));
    };
  }
  getValueFromInstance = (defName: any, data: any, keyName: any) => {
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
      return waterfall(def.relationships, async(rel: any) =>
        this.processRelationship(def, sourceAdapter, rel));
    }));
    await Promise.all(Object.keys(this.adapters).map((adapterName) => {
      const adapter = this.adapters[adapterName];
      return adapter.initialise();
    }));
  }
  reset = async(options: any) => {
    await Promise.all(Object.keys(this.adapters).map((adapterName) => {
      const adapter = this.adapters[adapterName];
      return adapter.reset(options);
    }));
  }
  sync = async(options?: any) => {
    await Promise.all(Object.keys(this.adapters).map((adapterName) => {
      const adapter = this.adapters[adapterName];
      return adapter.sync(options);
    }));
  }
  resolveClassMethod = async(defName: any, methodName: string | number, args: any, context: any, before?: any, after?: any) => {
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
  isTypeOf = (defName: any, definition: any, value: any) => {
    const Model = this.getModel(defName) as any;
    const isType = value instanceof Model;
    return isType;
  }

  // ---------------------------------------------------------------------------
  // Resolution engine (graphql-free). The GraphQL `info` coupling and relay
  // global-id translation are injected via the `Selection` argument, so gqlize
  // (and a future REST binding) can share this engine. gqlize builds the
  // `Selection` from execution `info`; here the engine only reads its fields.
  // ---------------------------------------------------------------------------

  resolveManyRelationship = async(defName: string, association: Association, source: Model, args: any, context: any, selection?: Selection) => {
    const options = createResolveContext(context, selection, source);
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    const a = args;
    const offset = cursorOffset(args);
    // Count-only: the nested connection selects `total` but not `edges`/rows — the
    // adapter runs a count instead of a findAll (fires beforeCount natively); fire
    // afterCount here.
    const countOnly = Boolean(selection?.countOnly);
    const result = await adapter.resolveManyRelationship(defName, association, source, a, offset, definition.whereOperators, selection as any, options, countOnly);
    if (countOnly && result) {
      result.total = await this.runHook(defName, "afterCount", result.total, options);
    }
    // afterFind for JOIN-eager loads is fired centrally by resolveFindAll's
    // post-pass (which knows JOIN vs separate authoritatively). A fresh accessor
    // query and the separate path both fire it natively.
    return result;
  }
  resolveSingleRelationship = async(defName: string, association: Association, source: any, args: any, context: any, selection?: Selection) => {
    const adapter = this.getModelAdapter(defName);
    const options = createResolveContext(context, selection, source);
    // afterFind for JOIN-eager single relations is fired by resolveFindAll's post-pass.
    return adapter.resolveSingleRelationship(defName, association, source, args, context, selection as any, options);
  }
  resolveFindAll = async(defName: any, source: any, args: { after?: { index: number; }; before?: { index: number; }; limit?: any; }, context: any, selection?: Selection) => {
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const options = createResolveContext(context, selection, source);
    const a = args;
    const selectedFields = selection?.fields;
    // The eager-include plan is built by the caller (gqlize, from the GraphQL
    // selection set) and passed via `selection.include`; apply it when the args
    // don't already carry one.
    if (selection?.include && !(a as any).include) {
      (a as any).include = selection.include;
    }
    const offset = cursorOffset(args);
    const {getOptions, countOptions} = await adapter.processListArgsToOptions(defName, a, offset, selection as any, definition.whereOperators, options, selectedFields, this.runHook);
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
        include: (getOptions.include || []).filter((i: any) => i.required && !i.separate),
        getGraphQLArgs: getOptions.getGraphQLArgs,
      };
      let total = await adapter.count(defName, countOnlyOptions);
      total = await this.runHook(defName, "afterCount", total, countOnlyOptions);
      return { total, models: [] };
    }
    let models = (await adapter.findAll(defName, getOptions)).filter((m: any) => (m !== undefined && m !== null));

    // Sequelize does not fire a child model's afterFind for JOIN-loaded includes.
    // Walk the built include plan and fire afterFind for each JOIN (non-separate)
    // relation on the loaded instances before the nested field resolvers read them;
    // separate/cross-adapter relations fire it natively via their own query.
    const plan = (a as any).include && (a as any).include[0];
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
  processInputs = async(defName: any, input: { [x: string]: any; }, args: any, context: any, info: any, model?: any) => {
    const definition = this.getDefinition(defName);
    let i = Object.keys(this.getFields(defName)).reduce((o, key) => {
      if (input[key] !== undefined) {
        o[key] = input[key];
      }
      return o;
    }, {} as any);

    if (definition.override) {
      i = await waterfall(Object.keys(definition.override), async(key: string | number, o: { [x: string]: any; }) => {
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
  processRelationshipMutation = async(defName: any, source: any, input: any, context: any, selection?: Selection) => {
    const translateFilter = selection?.translateFilter || ((w: any) => w);
    const associations = this.getAssociations(defName);
    const defaultOptions = createResolveContext(context, selection, source);
    await waterfall(Object.keys(associations), async(key: string, o: any) => {
      const association = associations[key];
      const targetName = association.target;
      const targetAdapter = this.getModelAdapter(targetName);
      const targetGlobalKeys = this.getGlobalKeys(targetName);
      const targetDef = this.getDefinition(targetName);
      if (input[key]) {
        const args = input[key];
        const singular = association.associationType === "belongsTo" || association.associationType === "hasOne";
        const isBtm = association.associationType === "belongsToMany";
        if (args.create) {
          await waterfall(args.create, async(arg: any) => {
            if (targetDef.before) {
              arg = await targetDef.before({
                params: arg, args, context, info: selection?.raw,
                modelDefinition: targetDef,
                type: Events.MUTATION_CREATE,
              });
            }

            const [result] = await this.processCreate(targetName, source, {input: arg}, context, selection);
            // const targetAdapter = this.getModelAdapter(targetName);
            // const k = this.getValueFromInstance(targetName, result, targetAdapter.getPrimaryKeyNameForModel(targetName));

            switch (association.associationType) {
              case "hasMany":
              case "belongsToMany":
                await source[association.accessors.add](result, defaultOptions);
                break;
              default:
                await source[association.accessors.set](result, defaultOptions);
                break;
            }

            // await this.processRelationshipMutation(targetDef, result, input, context, info);
          });
        }
        if (args.update) {
          await waterfall(args.update, async(arg: { where: any; limit: any; input: any; }) => {
            const {where, limit, input} = arg;
            // const [result] = await this.processUpdate(targetName, source, {input: arg}, context, info);
            const whereObj = await targetAdapter.processFilterArgument(translateFilter(where, targetGlobalKeys), targetDef.whereOperators, defaultOptions);
            const targets = await source[association.accessors.get]({
              limit,
              where: whereObj,
              ...defaultOptions
            });
            let i = await this.processInputs(targetName, input, source, args, context, selection?.raw);
            if (targetDef.before) {
              i = await targetDef.before({
                params: input, args, context, info: selection?.raw,
                modelDefinition: targetDef,
                type: Events.MUTATION_UPDATE,
              });
            }
            await Promise.all(targets.map(async(model: any) => {
              let m = await targetAdapter.update(model, i, defaultOptions);
              // if (targetDef.after) {
              //   m = await targetDef.after({
              //     result: m, args, context, info,
              //     modelDefinition: targetDef,
              //     type: events.MUTATION_UPDATE,
              //   });
              // }
              const defName = targetDef.name;
              await this.processRelationshipMutation(defName, m, input, context, selection);
              return m;
            }));
          });
        }
        if (args.delete) {
          await waterfall(args.delete, async(arg: any) => {
            const targets = await source[association.accessors.get](Object.assign({
              where: await targetAdapter.processFilterArgument(translateFilter(arg, targetGlobalKeys), targetDef.whereOperators, defaultOptions),
            }, defaultOptions));
            // let i = await this.processInputs(targetName, input, source, args, context, info);
            await Promise.all(targets.map(async(model: any) => {
              const defName = targetDef.name;
              await this.processRelationshipMutation(defName, model, input, context, selection);
              if (targetDef.before) {
                await targetDef.before({
                  params: model, args, context, info: selection?.raw,
                  model, modelDefinition: targetDef,
                  type: Events.MUTATION_DELETE,
                });
              }
              await this.processDelete(defName, source, arg, context, selection);
              // if (targetDef.after) {
              //   await targetDef.after({
              //     result: model, args, context, info,
              //     modelDefinition: targetDef,
              //     type: events.MUTATION_DELETE,
              //   });
              // }
              return model;
            }));
          });
        }
        if (args.remove !== undefined && args.remove !== null) {
          if (singular) {
            // belongsTo/hasOne: disassociate by nulling the relationship.
            if (args.remove === true) {
              await source[association.accessors.set](null, defaultOptions);
            }
          } else {
            await waterfall(args.remove, async(arg: any) => {
              const where = await targetAdapter.processFilterArgument(translateFilter(arg, targetGlobalKeys), targetDef.whereOperators, defaultOptions);
              const results = await targetAdapter.findAll(targetName, Object.assign({
                where,
              }, defaultOptions));
              if (results.length > 0) {
                return source[association.accessors.removeMultiple](results, defaultOptions);
              }
              return undefined;
            });
          }
        }

        if (args.add) {
          await waterfall(args.add, async(arg: any) => {
            // belongsToMany add entries are `{ where, through }`; other collections
            // pass the filter directly.
            const filter = isBtm ? (arg || {}).where : arg;
            const through = isBtm ? (arg || {}).through : undefined;
            const where = await targetAdapter.processFilterArgument(translateFilter(filter, targetGlobalKeys), targetDef.whereOperators, defaultOptions);
            const results = await targetAdapter.findAll(targetName, Object.assign({
              where,
            }, defaultOptions));
            if (results.length > 0) {
              return source[association.accessors.addMultiple](results, through !== undefined ? Object.assign({through}, defaultOptions) : defaultOptions);
            }
            return undefined;
          });
        }

        if (args.set !== undefined && args.set !== null) {
          if (singular) {
            // belongsTo/hasOne: associate one existing record found by filter.
            const where = await targetAdapter.processFilterArgument(translateFilter(args.set, targetGlobalKeys), targetDef.whereOperators, defaultOptions);
            const found = await targetAdapter.findAll(targetName, Object.assign({where, limit: 1}, defaultOptions));
            await source[association.accessors.set](found[0] || null, defaultOptions);
          } else {
            // Collections: replace the entire set with all matching existing records.
            const all: any[] = [];
            let through: any;
            await waterfall(args.set, async(arg: any) => {
              const filter = isBtm ? (arg || {}).where : arg;
              if (isBtm && (arg || {}).through !== undefined) {
                through = arg.through;
              }
              const where = await targetAdapter.processFilterArgument(translateFilter(filter, targetGlobalKeys), targetDef.whereOperators, defaultOptions);
              const results = await targetAdapter.findAll(targetName, Object.assign({where}, defaultOptions));
              all.push(...results);
              return undefined;
            });
            await source[association.accessors.set](all, through !== undefined ? Object.assign({through}, defaultOptions) : defaultOptions);
          }
        }

        if (args.restore !== undefined && args.restore !== null) {
          // Restore soft-deleted (paranoid) related records scoped to this relationship.
          const restoreByFilter = async(arg: any) => {
            const where = await targetAdapter.processFilterArgument(translateFilter(arg, targetGlobalKeys), targetDef.whereOperators, defaultOptions);
            const res = await source[association.accessors.get](Object.assign({where, paranoid: false}, defaultOptions));
            const records = Array.isArray(res) ? res : (res ? [res] : []);
            await Promise.all(records
              .filter((r: any) => r && r.deletedAt)
              .map((r: any) => r.restore(defaultOptions)));
          };
          if (singular) {
            await restoreByFilter(args.restore);
          } else {
            await waterfall(args.restore, restoreByFilter);
          }
        }

        if (args.select !== undefined && args.select !== null) {
          // Find related records (scoped to this relationship via the get accessor,
          // so beforeFind/afterFind fire) and run further relationship mutations on
          // them via `arg.input`. The selected records themselves are NOT modified —
          // no field write, no create/update/delete; scalar fields in `input` are
          // ignored (only relationship sub-mutations are applied).
          const selectByFilter = async(arg: any) => {
            const where = await targetAdapter.processFilterArgument(translateFilter(arg.where, targetGlobalKeys), targetDef.whereOperators, defaultOptions);
            const res = await source[association.accessors.get](Object.assign({where}, defaultOptions));
            const records = Array.isArray(res) ? res : (res ? [res] : []);
            await waterfall(records, async(m: any) => {
              await this.processRelationshipMutation(targetDef.name, m, arg.input, context, selection);
            });
          };
          if (singular) {
            await selectByFilter(args.select);
          } else {
            await waterfall(args.select, selectByFilter);
          }
        }
      }
    });
    return source;
  }
  processCreate = async(defName: any, source: any, args: { input: any; }, context: any, selection?: Selection) => {
    const translateFilter = selection?.translateFilter || ((w: any) => w);
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
    let result;
    if (Object.keys(input).length > 0) {
      result = await processCreate(input, createResolveContext(context, selection, source));
      // if (definition.after) {
      //   result = definition.after({
      //     result, args, context, info,
      //     modelDefinition: definition,
      //     type: events.MUTATION_CREATE,
      //   });
      // }

      if (result !== undefined && result !== null) {
        result = await this.processRelationshipMutation(defName, result, args.input, context, selection);
        return [result];
      }

    }
    return [];
  }

  processUpdate = async(defName: any, source: any, args: { input: { [x: string]: any; }; where: any; limit: any; }, context: any, selection?: Selection) => {
    const translateFilter = selection?.translateFilter || ((w: any) => w);
    const translateId = selection?.translateId || ((v: any) => v);
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const processUpdate = adapter.getUpdateFunction(defName, definition.whereOperators);
    const globalKeys = this.getGlobalKeys(defName);

    let i = Object.keys(args.input).reduce((o, k) => {
      if (globalKeys.indexOf(k) > -1) {
        let v = args.input[k];
        if (typeof args.input[k] === "function") {
          v = args.input[k](selection?.variableValues);
        }
        if (v === null || v === undefined) {
          o[k] = null;
        } else {
          o[k] = translateId(v);
        }
        //o[k] = fromGlobalId(v).id;
      } else {
        o[k] = args.input[k];
      }
      return o;
    }, {} as any);
    const where = translateFilter(args.where, globalKeys);
    if (definition.before) {
      i = await definition.before({
        params: i, args, context, info: selection?.raw,
        modelDefinition: definition,
        type: Events.MUTATION_UPDATE,
      });
    }
    const results = await processUpdate(where, (model: any) => {
      return this.processInputs(defName, i, args, context, selection?.raw, model);
    }, createResolveContext(context, selection, source, {limit: args.limit}));

    await waterfall(results, async(r: any) => {
      await this.processRelationshipMutation(defName, r, args.input, context, selection);
      // if (definition.after) {
      //   await definition.after({
      //     result: r, args, context, info,
      //     modelDefinition: definition,
      //     type: events.MUTATION_UPDATE,
      //   });
      // }
    });

    return results;
  }
  processSelect = async(defName: any, source: any, args: { input: any; where: any; limit: any; }, context: any, selection?: Selection) => {
    const translateFilter = selection?.translateFilter || ((w: any) => w);
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
    await waterfall(results, async(r: any) => {
      await this.processRelationshipMutation(defName, r, args.input, context, selection);
    });
    return results;
  }
  processDelete = async(defName: any, source: any, args: any, context: any, selection?: Selection) => {
    const translateFilter = selection?.translateFilter || ((w: any) => w);
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const processDelete = adapter.getDeleteFunction(defName, definition.whereOperators);
    const globalKeys = this.getGlobalKeys(defName);
    const where = translateFilter(args, globalKeys);
    const before = (model: any) => {
      if (!definition.before) {
        return model;
      }
      return definition.before({
        params: model, args, context, info: selection?.raw,
        model, modelDefinition: definition,
        type: Events.MUTATION_DELETE,
      });
    };
    const after = (model: any) => {
      return model;
      // if (!definition.after) {

      // }
      // return definition.after({
      //   result: model, args, context, info,
      //   modelDefinition: definition,
      //   type: events.MUTATION_DELETE,
      // });
    };
    return processDelete(where, createResolveContext(context, selection, source), before, after);
  }

}

// Build the resolve-context object passed to adapter fetch/mutation functions.
// Hooks read `options.getGraphQLArgs().info`; gqlize sets `selection.raw` to the
// real GraphQLResolveInfo so that behaviour is identical, while ormize itself
// stays graphql-free (it only forwards the opaque `raw`).
function createResolveContext(context: any, selection: any, source: any, options: any = {}) {
  return Object.assign({
    getGraphQLArgs() {
      return {
        context,
        info: selection?.raw,
        source,
      };
    },
  }, options);
}

// Cursor-based offset from decoded `after`/`before` args (shared by the top-level
// list resolver and the relationship resolver).
function cursorOffset(args: any) {
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
