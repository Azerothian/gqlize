// Read-cache tagging and cache-through wrappers for findAll and count.
//
// The read cache needs to know which models a read touches (so it can
// invalidate on a write to any of them) and which models a mutation may have
// written (so it invalidates the right set). Both answers come from the
// relationship graph the class already holds, so the helpers live here rather
// than in read-cache/ itself.

import type { OrmAdapter, AdapterRow, AdapterQueryOptions, IncludeMap, RequestContext } from "@azerothian/utilize/types/index";
import type { Definitions } from "../types";
import type ReadCache from "../read-cache";
import type { CachedRead } from "../read-cache";
import { encode as encodeCached, decode as decodeCached } from "../read-cache/codec";
import type { Association } from "@azerothian/utilize/types/index";

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

/** The narrow slice of the class the read-cache helpers need. */
export interface ReadCacheHost {
  defs: Definitions;
  readCache: ReadCache | undefined;
  getAssociations(defName: string): { [relName: string]: Association };
  getModelAdapter(modelName: string): OrmAdapter;
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

/**
 * Add a relationship's target and join model to `tags`, and return the target.
 *
 * Looked up through `getAssociations`, not the adapter's. Only the engine's
 * view includes cross-adapter relationships, which no single adapter knows
 * about, so footprints and tags cover relationships that cross adapters too.
 * A name that isn't a definition (an implicit join table reached through a
 * native include) has no associations of its own.
 */
export function tagRelation(self: ReadCacheHost, tags: Set<string>, defName: string, relName: string): string | undefined {
  const association = self.defs[defName] ? self.getAssociations(defName)[relName] : undefined;
  if (association) {
    tags.add(association.target);
    if (association.through) {
      tags.add(association.through);
    }
  }
  return association?.target;
}

/**
 * The models a mutation on `defName` may have written: the model itself, plus
 * every relationship target and join model, because nested verbs write
 * those. Over-invalidating is cheap with generations. Under-invalidating
 * serves stale rows.
 */
export function writeFootprint(self: ReadCacheHost, defName: string): string[] {
  const tags = new Set([defName]);
  for (const relName of Object.keys(self.getAssociations(defName))) {
    tagRelation(self, tags, defName, relName);
  }
  return [...tags];
}

/**
 * Every model a read touches: the root, each eager-loaded target and its join
 * model from the portable plan, and any model class in the native options'
 * `include`. The native walk covers includes a `before` hook added after the
 * plan was built.
 */
export function readTags(self: ReadCacheHost, defName: string, plan: IncludeMap[] | undefined, nativeOptions: AdapterQueryOptions): string[] {
  const tags = new Set([defName]);
  const walkPlan = (parent: string, maps: IncludeMap[] | undefined) => {
    for (const map of maps || []) {
      for (const [relName, descriptor] of Object.entries(map)) {
        tags.add(descriptor.target);
        tagRelation(self, tags, parent, relName);
        walkPlan(descriptor.target, descriptor.include);
      }
    }
  };
  walkPlan(defName, plan);
  const walkNative = (parent: string, include: unknown) => {
    for (const entry of Array.isArray(include) ? include : []) {
      const {model, through, association, include: nested} = (entry || {}) as
        {model?: unknown, through?: {model?: unknown}, association?: unknown, include?: unknown};
      let target: string | undefined;
      for (const m of [model, through?.model]) {
        if (typeof m === "function" && m.name) {
          tags.add(m.name);
          target = target ?? m.name;
        }
      }
      // `{association: "reviews"}` is the other legal Sequelize include form,
      // and it names no model class. Resolve it through the parent's associations.
      if (typeof association === "string") {
        target = target ?? tagRelation(self, tags, parent, association);
      }
      walkNative(target ?? parent, nested);
    }
  };
  walkNative(defName, nativeOptions.include);
  return [...tags];
}

// ---------------------------------------------------------------------------
// Cache-through wrappers
// ---------------------------------------------------------------------------

function cachedReadDescriptor(self: ReadCacheHost, defName: string, operation: CachedRead["operation"], context: RequestContext, plan: IncludeMap[] | undefined, options: AdapterQueryOptions): CachedRead {
  const own = self.defs[defName]?.cache;
  return {defName, operation, context, options, tags: readTags(self, defName, plan, options), ttl: own ? own.ttl : undefined};
}

/**
 * `adapter.count`, through the read cache when there is one. `plan` is the
 * portable include plan the options were built from, which gives the read its
 * tags.
 */
export function cachedCount(self: ReadCacheHost, defName: string, adapter: OrmAdapter, context: RequestContext, plan: IncludeMap[] | undefined, options: AdapterQueryOptions): Promise<number> {
  if (!self.readCache) {
    return adapter.count(defName, options);
  }
  return self.readCache.read(
    cachedReadDescriptor(self, defName, "count", context, plan, options),
    () => adapter.count(defName, options),
    {encode: (total) => String(total), decode: (text) => Number(text)},
  );
}

/**
 * `adapter.findAll`, through the read cache when there is one and the adapter
 * can snapshot its rows. One that can't still has its counts cached.
 */
export function cachedFindAll(self: ReadCacheHost, defName: string, adapter: OrmAdapter, context: RequestContext, plan: IncludeMap[] | undefined, options: AdapterQueryOptions): Promise<AdapterRow[]> {
  if (!self.readCache || !adapter.snapshotRows || !adapter.restoreRows) {
    return adapter.findAll(defName, options);
  }
  // Both were just checked, and nothing replaces an adapter's methods mid-read.
  const snapshotRows = (rows: AdapterRow[]) => adapter.snapshotRows!(defName, rows, options);
  const restoreRows = (snapshot: unknown[]) => adapter.restoreRows!(defName, snapshot, options);
  return self.readCache.read(
    cachedReadDescriptor(self, defName, "findAll", context, plan, options),
    () => adapter.findAll(defName, options),
    {
      encode: (rows) => encodeCached(snapshotRows(rows)),
      decode: (text) => restoreRows(decodeCached(text) as unknown[]),
    },
  );
}
