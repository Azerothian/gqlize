// Hook composition for model and Sequelize-instance hooks.
//
// The functions here build the composed hooks that `addDefinition` registers on
// each model and `installInstanceHooks` registers on the Sequelize instance.
// Extracted from the `Ormize` class so each concern lives in its own module.

import { definitionHooks } from "@azerothian/utilize/utils/definition-hooks";
import type { OrmAdapter, AdapterRow, AdapterQueryOptions, IncludeMap } from "@azerothian/utilize/types/index";
import type { Permission } from "@azerothian/utilize/gate";
import type { Definition, HookMap } from "../types";
import type { ScopeHook } from "../scope-hooks";
import type ReadCache from "../read-cache";
import type { HookFunction } from "./constants";
import { sequelizeHookSet, WRITE_HOOKS, runHookEntry } from "./constants";
import type { InstanceRow } from "../types/engine";

// ---------------------------------------------------------------------------
// Host interface — what the hook helpers read from the class
// ---------------------------------------------------------------------------

/** The narrow slice of the `Ormize` class that the hook helpers need. */
export interface HookHost {
  defs: { [name: string]: Definition };
  hooks: { [defName: string]: HookMap };
  globalHooks: { [hookName: string]: HookFunction[] | HookFunction };
  permission: Permission | undefined;
  scopeHooks: { [hookName: string]: ScopeHook };
  scopeInstanceHooks: { [hookName: string]: (...args: unknown[]) => unknown };
  readCache: ReadCache | undefined;
  /** Set of adapter names already hooked; guarded so repeated `initialise()` doesn't double-register. */
  instanceHookedAdapters: Set<string>;
  getDefinitionHooks(defName: string): Promise<HookMap>;
}

// ---------------------------------------------------------------------------
// Definition-instance hook warning
// ---------------------------------------------------------------------------

/**
 * A definition cannot own a Sequelize-instance hook: it fires off the Sequelize
 * instance, which has no idea which model the caller had in mind. Before #45 the
 * name was accepted and filed on the model, where nothing would ever call it —
 * an audit hook that looked live and had never run. Say so instead.
 */
export function warnDefinitionInstanceHooks(def: Definition) {
  const authored = definitionHooks(def);
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

// ---------------------------------------------------------------------------
// Hook composition
// ---------------------------------------------------------------------------

/**
 * Build a composed model hook for one `hookName` on one definition.
 *
 * The composed hook runs definition hooks, then global hooks, then the scope
 * enforcement hook — structurally last, so nothing a deployment registers can
 * displace it.
 */
export function createHook(host: HookHost, hookName: string, def: Definition): HookFunction {
  // `first`/`args` take their types from `HookFunction` by context (the
  // declared return type above), rather than repeating its `any`s here.
  return async(first, ...args) => {
    const hooks = await host.getDefinitionHooks(def.name as string);
    // Definition hooks: `hook(value, ...args)`.
    // Forwards to `hook`, whose own return may or may not be a promise —
    // `waterfall`'s `.then()` chain adopts it either way.
    let v = await runHookEntry(hooks[hookName], first, (f) => [f, ...args]);
    // Global hooks: `hook(defName, value, ...args)`.
    v = await runHookEntry(host.globalHooks[hookName], v, (f) => [def.name, f, ...args]);
    // §13, and structurally last: not registered through `globalHooks`, so no
    // hook a deployment adds — before or after `initialise()`, at either
    // level — can run after this one or replace it. A definition hook that
    // rewrites `where` is answered here rather than trusted.
    const enforce = host.scopeHooks[hookName];
    if (enforce && typeof host.permission?.scope === "function") {
      v = await enforce(def.name as string, v, ...args);
    }
    if (host.readCache && WRITE_HOOKS.has(hookName)) {
      // A bulk hook is handed the options bag. An instance hook is handed the
      // row, and the options come after it.
      const options = (hookName.startsWith("afterBulk") ? first : args[0]) as {transaction?: unknown} | undefined;
      await host.readCache.invalidate([def.name as string], options?.transaction);
    }
    return v;
  };
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
export function createInstanceHook(host: HookHost, hookName: string): HookFunction {
  return async(...args: unknown[]) => {
    const registered = host.globalHooks[hookName];
    const hooks = Array.isArray(registered) ? registered : registered ? [registered] : [];
    for (const hook of hooks) {
      // Sequelize's own arguments, forwarded as-is; `HookFunction` names the
      // first one only because every model hook has a value to waterfall.
      await (hook as (...hookArgs: unknown[]) => unknown)(...args);
    }
    // Structurally last, and outside `globalHooks`, exactly as in `createHook`:
    // a backstop a deployment could register something after would not be one.
    const enforce = host.scopeInstanceHooks[hookName];
    if (enforce && typeof host.permission?.scope === "function") {
      await enforce(...args);
    }
  };
}

/**
 * Register the composed Sequelize-instance hooks on an adapter's underlying
 * connection. Once per adapter: `initialise()` is callable more than once and
 * `sequelize.addHook` appends, so without the guard every extra call would fire
 * an audit hook another time per query.
 */
export function installInstanceHooks(host: HookHost, adapterName: string, adapter: OrmAdapter) {
  if (!adapter.installInstanceHooks || host.instanceHookedAdapters.has(adapterName)) {
    return;
  }
  host.instanceHookedAdapters.add(adapterName);
  const sequelizeHookList = [...sequelizeHookSet];
  adapter.installInstanceHooks(sequelizeHookList.reduce((o, hookName) => {
    o[hookName] = createInstanceHook(host, hookName);
    return o;
  }, {} as HookMap));
}

// ---------------------------------------------------------------------------
// Runtime hook invocation
// ---------------------------------------------------------------------------

/**
 * Run a composed lifecycle hook (definition + global) by name and return the
 * transformed value. Used to manually fire find/count hooks that Sequelize does
 * not fire itself — e.g. a child model's beforeFind/afterFind for JOIN-loaded
 * relations, or afterCount. A no-op (returns `value`) when no such hook exists.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- must stay async: declared `Promise<T>` and every caller awaits it; the plain `return value` branch would otherwise return `T` where `Promise<T>` is declared
export async function runHook<T = unknown>(host: HookHost, defName: string, hookName: string, value: T, ...args: unknown[]): Promise<T> {
  const hooks = host.hooks[defName];
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
export async function applyEagerAfterFind(host: HookHost, planMap: IncludeMap | undefined, instances: AdapterRow[], options: AdapterQueryOptions): Promise<void> {
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
      const transformed = await runHook(host, desc.target, "afterFind", val, options);
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
        await applyEagerAfterFind(host, nested, Array.isArray(finalVal) ? finalVal : [finalVal], options);
      }
    }
  }
}
