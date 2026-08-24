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
  AdapterQueryOptions, AdapterRow, AdapterWhere, Association, Model, OrmAdapter,
} from "@azerothian/utilize/types/index";
import type { AdapterRoutingHost, InstanceRow, MutationInput } from "./types/engine";

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
  const edges = await throughAdapter.findAll(throughName, {
    where: filterMerger(host, throughName)(association.foreignKey, sourceValue, true, undefined),
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
    return targetAdapter.findAll(association.target, {
      ...opts,
      where: filterMerger(host, association.target)(association.targetKey, keys, true, opts.where),
    });
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
    return btmWriteAccessors(host, association, sourceAdapter, targetAdapter);
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
    await host.getModelAdapter(throughName).getDeleteFunction(throughName, undefined)(where, opts, (r) => r, (r) => r);
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
export function addProxyAccessor(sourceAdapter: OrmAdapter, defName: string, modelClass: Model | undefined, funcName: string, func: (...args: any[]) => any) {
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
) {
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
