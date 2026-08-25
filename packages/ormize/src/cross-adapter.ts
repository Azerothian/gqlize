// Resolving and writing a relationship whose two ends live on different adapters.
//
// There is no native association to delegate to — no JOIN spans two datastores —
// so ormize resolves the pair itself: read the join key off the source through
// its own adapter, then run one scoped query (or one foreign-key write, or a
// join-row insert) on the target's. The accessors built here are installed under
// the names a native association would use, so the mutation and resolution
// engines drive them without knowing the relationship spans two datastores.
//
// Free functions over a structural host rather than methods, so each hop is
// reachable on its own and the manager keeps only the wiring that calls them.

import type {
  AdapterQueryOptions, AdapterRow, AdapterWhere, Association, Model, OrmAdapter, RequestContext,
} from "@azerothian/utilize/types/index";
import type { ScopeOperation } from "@azerothian/utilize/gate";
import { markSystemQuery } from "./scope";
import type { AdapterRoutingHost, InstanceRow, MutationInput } from "./types/engine";

/**
 * The request an accessor was called for.
 *
 * These functions are installed as ordinary instance methods, so they are
 * reached two ways: the engine calls them with the options bag it builds (which
 * carries the context behind `getGraphQLArgs`), and userland calls them off a
 * row it is holding, with whatever it likes — including nothing. A row-level
 * scope has to be resolved either way, and the second case is why this returns
 * the bag itself rather than giving up: a predicate handed a context with no
 * principal on it fails closed, which is the answer an accessor called with no
 * request deserves.
 */
export function requestFrom(options: AdapterQueryOptions | undefined): RequestContext {
  const bag = options as { getGraphQLArgs?: () => { context: RequestContext } } | undefined;
  if (typeof bag?.getGraphQLArgs === "function") {
    return bag.getGraphQLArgs().context;
  }
  return options as RequestContext;
}

/**
 * May this principal write a row it is already holding?
 *
 * The cross-adapter write accessors re-point a foreign key on an *instance*
 * (`adapter.update(row, …)`), so unlike every other write path there is no
 * filter for a scope to narrow. The scope is therefore checked and the write
 * refused: an outright deny short-circuits, and a filter-shaped one is settled
 * by asking the target's own adapter whether the row is still reachable under
 * it — one query, and only when a scope is actually configured.
 *
 * Reaching a row is a read whatever happens next, so the read scope is ANDed on
 * top of the operation's own.
 */
export async function writable(
  host: AdapterRoutingHost, defName: string, adapter: OrmAdapter, row: AdapterRow,
  operation: ScopeOperation, options: AdapterQueryOptions | undefined,
): Promise<boolean> {
  const request = requestFrom(options);
  let where = await host.scopedWhere(defName, "read", request, undefined, options);
  if (where !== false) {
    where = await host.scopedWhere(defName, operation, request, where, options);
  }
  if (where === false) {
    host.scopeMiss(defName, operation);
    return false;
  }
  if (where === undefined) {
    return true;
  }
  const [pk] = adapter.getPrimaryKeyNameForModel(defName);
  const value = adapter.getValueFromInstance(row, pk);
  // Marked: this query *is* the scope check, so the adapter-side hooks must
  // stand aside rather than run it again on the way in.
  const [found] = await adapter.findAll(defName, markSystemQuery({
    ...(options?.transaction !== undefined ? {transaction: options.transaction} : {}),
    where: filterMerger(host, defName)(pk, value, true, where),
    limit: 1,
  }));
  if (!found) {
    host.scopeMiss(defName, operation);
    return false;
  }
  return true;
}

/** `mergeFilterStatement` on an adapter, with the error the missing case deserves. */
export function filterMerger(host: AdapterRoutingHost, defName: string) {
  const adapter = host.getModelAdapter(defName);
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
export async function btmKeys(host: AdapterRoutingHost, association: Association, source: AdapterRow, options?: AdapterQueryOptions): Promise<unknown[]> {
  const throughName = association.through as string;
  const sourceValue = host.getModelAdapter(association.source).getValueFromInstance(source, association.sourceKey);
  if (sourceValue === undefined || sourceValue === null) {
    return [];
  }
  const throughAdapter = host.getModelAdapter(throughName);
  const opts = await host.optionsForAdapter(association.source, throughName, options);
  // F5. The join model is a model like any other, and a scope on it is what says
  // which *edges* a principal may see. Left unscoped, the pair of keys leaks the
  // existence of a link even when both ends of it are scoped out.
  const where = await host.scopedWhere(
    throughName, "read", requestFrom(options),
    filterMerger(host, throughName)(association.foreignKey, sourceValue, true, undefined),
    opts,
  );
  if (where === false) {
    return [];
  }
  const edges = await throughAdapter.findAll(throughName, {
    where,
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
export function btmGetter(host: AdapterRoutingHost, association: Association) {
  const targetAdapter = host.getModelAdapter(association.target);
  return async function(this: InstanceRow, options?: AdapterQueryOptions) {
    const keys = await btmKeys(host, association, this, options);
    if (keys.length === 0) {
      return [];
    }
    const opts = (await host.optionsForAdapter(association.source, association.target, options)) || {};
    // F5. This accessor is installed on the source model and runs the target's
    // `findAll` directly, so nothing upstream has scoped it — anything holding a
    // row can call it.
    const where = await host.scopedWhere(
      association.target, "read", requestFrom(options),
      filterMerger(host, association.target)(association.targetKey, keys, true, opts.where),
      opts,
    );
    if (where === false) {
      return [];
    }
    return targetAdapter.findAll(association.target, {...opts, where});
  };
}

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
export async function joinScope(host: AdapterRoutingHost, association: Association, source: AdapterRow, options?: AdapterQueryOptions) {
  if (association.associationType === "belongsToMany") {
    return {field: association.targetKey, value: await btmKeys(host, association, source, options)};
  }
  const sourceAdapter = host.getModelAdapter(association.source);
  const belongsTo = association.associationType === "belongsTo";
  const onSource = belongsTo ? association.foreignKey : association.sourceKey;
  const onTarget = belongsTo ? association.targetKey : association.foreignKey;
  return {field: onTarget, value: sourceAdapter.getValueFromInstance(source, onSource)};
}

/** Drop the nulls out of what an accessor was handed, one record or many. */
const list = (targets: AdapterRow | AdapterRow[]) =>
  (Array.isArray(targets) ? targets : [targets]).filter((t) => t !== undefined && t !== null);

/**
 * The write half of a cross-adapter relationship. Linking and unlinking is done
 * by writing the foreign key directly — on the target for `hasMany`, on the
 * source for `belongsTo` — and by creating and deleting join rows for
 * `belongsToMany`.
 *
 * Note that each write is an independent statement against its own adapter: they
 * are only atomic when the whole mutation runs inside `orm.transaction()`, which
 * coordinates a transaction per adapter.
 */
export function writeAccessors(host: AdapterRoutingHost, association: Association, sourceAdapter: OrmAdapter, targetAdapter: OrmAdapter) {
  const {foreignKey, sourceKey, targetKey, accessors} = association;
  // Callers build one options object for the source's adapter; writes aimed at
  // the target's adapter need its own transaction handle instead.
  const forTarget = (options: AdapterQueryOptions | undefined) => host.optionsForAdapter(association.source, association.target, options);
  if (association.associationType === "belongsTo") {
    // The key lives on the source: pointing it elsewhere is a write to `this`.
    const set = async function(this: InstanceRow, target: AdapterRow, options?: AdapterQueryOptions) {
      // The row being written is `this`, so it is the *source's* update scope
      // that decides — pointing a key elsewhere is a write to the source row.
      if (!await writable(host, association.source, sourceAdapter, this, "update", options)) {
        return undefined;
      }
      const value = target ? targetAdapter.getValueFromInstance(target, targetKey) : null;
      return sourceAdapter.update(this, {[foreignKey]: value}, options as AdapterQueryOptions);
    };
    const clear = async function(this: InstanceRow, _target?: AdapterRow, options?: AdapterQueryOptions) {
      if (!await writable(host, association.source, sourceAdapter, this, "update", options)) {
        return undefined;
      }
      return sourceAdapter.update(this, {[foreignKey]: null}, options as AdapterQueryOptions);
    };
    return {
      [accessors.set]: set,
      [accessors.add]: set,
      [accessors.remove]: clear,
      // Synchronous by nature (no adapter call to await); callers of this
      // accessor `await` it regardless, which resolves a plain value just fine.
      [accessors.count]: function(this: InstanceRow) {
        return sourceAdapter.getValueFromInstance(this, foreignKey) === null ? 0 : 1;
      },
    };
  }
  if (association.associationType === "belongsToMany") {
    return btmWriteAccessors(host, association, sourceAdapter, targetAdapter);
  }
  // hasMany/hasOne: the key lives on each target, so (un)linking writes there.
  const relink = (value: (self: InstanceRow) => unknown) => async function(this: InstanceRow, targets: AdapterRow | AdapterRow[], options?: AdapterQueryOptions) {
    const fk = value(this);
    const opts = await forTarget(options);
    for (const target of list(targets)) {
      // Each target row is written in its own right, so each is checked in its
      // own right: one out-of-scope member of a batch is skipped rather than
      // taking the rest of the batch down with it.
      if (!await writable(host, association.target, targetAdapter, target, "update", opts)) {
        continue;
      }
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
        if (nextKeys.has(targetAdapter.getValueFromInstance(existing, targetKey))) {
          continue;
        }
        if (!await writable(host, association.target, targetAdapter, existing, "update", opts)) {
          continue;
        }
        await targetAdapter.update(existing, {[foreignKey]: null}, opts as AdapterQueryOptions);
      }
      return link.call(this, next, options);
    },
    [accessors.count]: async function(this: InstanceRow, options?: AdapterQueryOptions) {
      return list(await this[accessors.get](options)).length;
    },
  };
}

/**
 * `belongsToMany`: the link is a row of its own, so (un)linking creates and
 * deletes join rows on whichever adapter hosts the through model — a third hop,
 * independent of both the source's and the target's.
 */
function btmWriteAccessors(host: AdapterRoutingHost, association: Association, sourceAdapter: OrmAdapter, targetAdapter: OrmAdapter) {
  const {foreignKey, sourceKey, targetKey, accessors} = association;
  const throughName = association.through as string;
  const otherKey = association.otherKey as string;
  // Resolved on use, not on wiring: a join model ormize generates itself is
  // only defined once every relationship has been read.
  const edgeWhere = (sourceValue: unknown, targetValues?: unknown) => {
    const merge = filterMerger(host, throughName);
    const where = merge(foreignKey, sourceValue, true, undefined);
    return targetValues === undefined ? where : merge(otherKey, targetValues, true, where);
  };
  // Only the transaction crosses over: the rest of the caller's options describe
  // the source's or the target's query, not the join model's.
  const forThrough = async(options: AdapterQueryOptions | undefined) => {
    const opts = await host.optionsForAdapter(association.source, throughName, options);
    return opts?.transaction !== undefined ? {transaction: opts.transaction} : {};
  };
  const link = async function(this: InstanceRow, targets: AdapterRow | AdapterRow[], options?: AdapterQueryOptions) {
    // A join row is created, so it is the *through* model's create scope that
    // decides whether this principal may make the link at all. The existence
    // probe below stays unscoped deliberately: it is an internal uniqueness
    // check, and scoping it would turn a link the principal cannot see into a
    // duplicate-key error.
    if (await host.resolveScope(throughName, "create", requestFrom(options)) === false) {
      host.scopeMiss(throughName, "create");
      return;
    }
    const sourceValue = sourceAdapter.getValueFromInstance(this, sourceKey);
    // `through` carries attribute values for the join row itself (the columns a
    // join table has beyond its two keys).
    const attributes: MutationInput = (options || {}).through || {};
    const opts = await forThrough(options);
    const throughAdapter = host.getModelAdapter(throughName);
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
    // Unlinking deletes join rows by filter, so unlike the instance writes above
    // the scope merges straight in and the delete simply matches fewer rows.
    const request = requestFrom(options);
    let scoped = await host.scopedWhere(throughName, "read", request, where, opts);
    if (scoped !== false) {
      scoped = await host.scopedWhere(throughName, "delete", request, scoped, opts);
    }
    if (scoped === false) {
      host.scopeMiss(throughName, "delete");
      return;
    }
    await host.getModelAdapter(throughName).getDeleteFunction(throughName, undefined)(scoped as AdapterWhere, opts, (r) => r, (r) => r);
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
      return (await btmKeys(host, association, this, options)).length;
    },
  };
}

/**
 * Install a cross-adapter accessor (`getFiles()`, `getItem()`, …) on the source
 * model. Class-based adapters (Sequelize) take it on the prototype; adapters
 * whose "model" is a plain descriptor rather than a constructor get it via
 * `addInstanceFunction`, and those with neither simply go without — the GraphQL
 * and `resolveXRelationship` paths do not depend on it.
 */
export function addProxyAccessor(
  sourceAdapter: OrmAdapter, defName: string, modelClass: Model | undefined, funcName: string,
  // Matches `OrmAdapter.addInstanceFunction`'s own `(...args: any[]) => any`
  // (utilize's published signature, not ours to narrow) — installed functions
  // are called reflectively, by name, with call-site-specific arity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must match addInstanceFunction's external signature
  func: (...args: any[]) => any,
) {
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

/**
 * The `get` accessor of a cross-adapter `belongsTo`/`hasOne`/`hasMany`: read the
 * join value off the source instance, then run the target adapter's find on it.
 */
export function createProxyFunction(
  adapter: OrmAdapter,
  sourceKey: string,
  filterKey: string,
  singular: boolean,
  findFunc: (keyValue: string, filterKey: string, singular: boolean) => ((options: AdapterQueryOptions) => Promise<AdapterRow>),
  adaptOptions?: (options: AdapterQueryOptions | undefined) => Promise<AdapterQueryOptions | undefined>,
  scopedWhere?: (options: AdapterQueryOptions | undefined) => Promise<AdapterWhere | undefined | false>,
) {
  return async function(this: InstanceRow, options?: AdapterQueryOptions) {
    // The join key — whatever column `sourceKey` names, so its type belongs to
    // the definition, not to this layer. `getValueFromInstance` returns
    // `unknown` for that reason; the find function takes it as given.
    const keyValue = adapter.getValueFromInstance(this, sourceKey) as string;
    // The find runs on the *target's* adapter while `options` were built for the
    // source's, so any transaction handle in them has to be swapped first.
    let opts = adaptOptions ? await adaptOptions(options) : options;
    if (scopedWhere) {
      // F5. `findFunc` merges the join key into `options.where` itself, so the
      // target's scope goes in the same place and comes out ANDed with it.
      const where = await scopedWhere(opts);
      if (where === false) {
        return singular ? null : [];
      }
      if (where !== undefined) {
        opts = {...(opts || {}), where};
      }
    }
    return findFunc(keyValue, filterKey, singular)
      .call(this, opts as AdapterQueryOptions);
  };
}
