// Reads of a `belongsToMany` in through mode (`Association.throughModel`): the
// join model is a definition the author registered, so each link is a row with
// data of its own, and the join model's read scope decides which links exist.
//
// One path for every adapter, alongside `resolveManyRelationship` in
// `resolution.ts`: the join rows are loaded first (scoped, filtered by
// `throughWhere`), and the targets are then fetched through `resolveFindAll`
// restricted to the keys those rows point at, so the target keeps its own scope,
// hooks and read cache. `applyThroughRequired` is the `required` half: it turns
// a planned through-mode include into a key filter on the parent.

import { whereOperatorsFor } from "@azerothian/utilize/exposed-methods";
import { clampPageSize, MAX_PAGE_SIZE } from "@azerothian/utilize/utils/page-size";
import { isThroughMode, mergeScopeWhere } from "@azerothian/utilize/gate";
import type { PortableWhere } from "@azerothian/utilize/gate";
import type {
  AdapterQueryOptions, AdapterRow, AdapterRelationshipPage, AdapterWhere, Association, FindAllArgs,
  IncludeDescriptor, IncludeMap, OrderEntry, RequestContext, Selection,
} from "@azerothian/utilize/types/index";
import { filterMerger } from "../cross-adapter";
import { ThroughInputError } from "../through-input-error";
import type { ResolutionHost } from "./resolution";
import { runHook } from "./hooks";

/** `resolveFindAll`, passed in rather than imported: `resolution.ts` imports this module. */
export type FindAll = (
  self: ResolutionHost, defName: string, source: AdapterRow, args: FindAllArgs,
  context: RequestContext, selection?: Selection, scope?: {field: string, value: unknown},
) => Promise<{total: number; models: AdapterRow[]}>;

/** The connection arguments that only a through-mode relationship takes. */
const THROUGH_ARGS = ["throughWhere", "throughOrderBy"] as const;

const hasThroughArgs = (args: FindAllArgs) => THROUGH_ARGS.some((k) => args[k] !== undefined && args[k] !== null);

/** Whether a relationship is read through the join model. */
export const isThroughRead = (association: Association) =>
  association.associationType === "belongsToMany" && association.throughModel === true;

/**
 * Refuse join-row arguments on a relationship that does not offer them: one that
 * is not read through its join model at all, or — under the caller's permission
 * bag — one whose join model the caller may not see.
 */
export function assertThroughArgs(association: Association, args: FindAllArgs, selection?: Selection) {
  if (!hasThroughArgs(args)) {
    return;
  }
  const offered = isThroughRead(association)
    && (selection?.permission === undefined || isThroughMode(selection.permission, association));
  if (!offered) {
    throw new ThroughInputError(association.source, association.name,
      "this relationship carries no join-row data, so it takes no throughWhere or throughOrderBy.");
  }
}

/**
 * Join rows: the caller's join-row filter, ANDed with the association's foreign
 * key (when `sourceValues` is given) and other key (when `otherKeys` is), and
 * with the join model's read scope. Empty when that scope denies outright.
 */
async function loadJoinRows(
  self: ResolutionHost, association: Association,
  filter: {sourceValues?: unknown; otherKeys?: unknown[]; where?: unknown},
  context: RequestContext, selection?: Selection,
): Promise<AdapterRow[]> {
  const host = self.host;
  const joinName = association.through as string;
  const joinAdapter = self.getModelAdapter(joinName);
  const opts = await self.optionsForAdapter(association.source, joinName, context) as AdapterQueryOptions | undefined;
  // A caller's filter carries global ids, and on the join model's own keys.
  const where = filter.where as AdapterWhere | undefined;
  const translated = where && selection?.translateFilter
    ? selection.translateFilter(where, host.getGlobalKeys(joinName), host.getGlobalKeyTargets(joinName))
    : where;
  let native = translated
    ? await joinAdapter.processFilterArgument(translated, whereOperatorsFor(self.getDefinition(joinName)), opts || {})
    : undefined;
  const merge = filterMerger(host, joinName);
  if (filter.sourceValues !== undefined) {
    native = merge(association.foreignKey, filter.sourceValues, true, native);
  }
  if (filter.otherKeys) {
    native = merge(association.otherKey as string, filter.otherKeys, true, native);
  }
  // F5, as for a cross-adapter link: a scope on the join model is what says
  // which links a principal may see, so a row it hides is no link at all.
  const scoped = await host.scopedWhere(joinName, "read", context, native, opts);
  if (scoped === false) {
    return [];
  }
  return joinAdapter.findAll(joinName, {
    where: scoped,
    ...(opts?.transaction !== undefined ? {transaction: opts.transaction} : {}),
  });
}

/**
 * A key value as a Map key. Join keys come back from two adapters (and, cross-
 * adapter, two datastores) that need not agree on number vs string, so they are
 * compared as text. A non-scalar key (a Buffer, a Date) compares by its JSON.
 */
function keyOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return value.toString();
  }
  return JSON.stringify(value);
}

/** Nulls last ascending and first descending, as Postgres orders them. */
function compareValues(a: unknown, b: unknown): number {
  const absent = (v: unknown) => v === undefined || v === null;
  if (absent(a) || absent(b)) {
    return absent(a) === absent(b) ? 0 : (absent(a) ? 1 : -1);
  }
  const x = a instanceof Date ? a.getTime() : a as number | string;
  const y = b instanceof Date ? b.getTime() : b as number | string;
  return x < y ? -1 : (x > y ? 1 : 0);
}

/**
 * The window of an in-memory-ordered list, computed exactly as the connection
 * resolver computes the offset it mints cursors from (`resolvers/connection.ts`
 * in gqlize), so the page and its cursors agree.
 */
function windowOf(args: FindAllArgs, total: number): [number, number] {
  const size = clampPageSize(args.first != null ? args.first : args.last);
  if (args.after) {
    const start = args.after.index + 1;
    return [start, start + size];
  }
  if (args.before) {
    const take = Math.min(size, args.before.index);
    return [args.before.index - take, args.before.index];
  }
  if (args.last != null) {
    const start = Math.max(0, total - clampPageSize(args.last));
    return [start, start + size];
  }
  return [0, size];
}

/** Every target row matching `args`, in its own order, fetched a full page at a time. */
async function allTargets(
  self: ResolutionHost, findAll: FindAll, defName: string, source: AdapterRow, args: FindAllArgs,
  context: RequestContext, selection: Selection | undefined, scope: {field: string, value: unknown},
): Promise<AdapterRow[]> {
  const {first: _f, last: _l, after: _a, before: _b, ...rest} = args;
  const rows: AdapterRow[] = [];
  for (;;) {
    const page = await findAll(self, defName, source, {
      ...rest, first: MAX_PAGE_SIZE, ...(rows.length > 0 ? {after: {index: rows.length - 1}} : {}),
    }, context, selection, scope);
    rows.push(...page.models);
    if (page.models.length < MAX_PAGE_SIZE || rows.length >= page.total) {
      return rows;
    }
  }
}

/**
 * One page of a through-mode `belongsToMany`, with the join row behind each
 * target in `through`.
 *
 * `throughWhere` filters the join rows; a target reached by no visible join row
 * is not an edge. `throughOrderBy` orders the edges by join columns, ties broken
 * by the target's own `orderBy` and primary key; the page is then cut in memory,
 * because the order spans two queries (and, potentially, two datastores).
 * Without it the target query pages itself. Where two join rows point at the
 * same target, the first one loaded is the edge's.
 */
export async function resolveThroughRelationship(
  self: ResolutionHost, findAll: FindAll, defName: string, association: Association,
  source: AdapterRow, args: FindAllArgs, context: RequestContext, selection?: Selection,
): Promise<AdapterRelationshipPage> {
  const empty = {total: 0, models: [], through: []};
  // The association names the target authoritatively. Callers pass it as
  // `defName` too, but the adapter path this replaced never read that argument,
  // so a caller passing the parent's name there went unnoticed.
  defName = association.target;
  const sourceValue = self.getModelAdapter(association.source).getValueFromInstance(source, association.sourceKey);
  if (sourceValue === undefined || sourceValue === null) {
    return empty;
  }
  const joinName = association.through as string;
  const joinAdapter = self.getModelAdapter(joinName);
  const joinRows = await loadJoinRows(self, association, {sourceValues: sourceValue, where: args.throughWhere}, context, selection);
  const byKey = new Map<string, {key: unknown; row: AdapterRow}>();
  for (const row of joinRows) {
    const key = joinAdapter.getValueFromInstance(row, association.otherKey as string);
    if (key !== undefined && key !== null && !byKey.has(keyOf(key))) {
      byKey.set(keyOf(key), {key, row});
    }
  }
  if (byKey.size === 0) {
    return empty;
  }
  const scope = {field: association.targetKey, value: [...byKey.values()].map((e) => e.key)};
  const targetAdapter = self.getModelAdapter(defName);
  const joinRowOf = (model: AdapterRow) =>
    byKey.get(keyOf(targetAdapter.getValueFromInstance(model, association.targetKey)))?.row;
  // The target query runs on the target's adapter.
  const targetContext = await self.optionsForAdapter(association.source, defName, context);
  const {throughWhere: _w, throughOrderBy, ...targetArgs} = args;
  const order = (throughOrderBy || []) as OrderEntry[];
  if (order.length === 0 || selection?.countOnly) {
    const page = await findAll(self, defName, source, targetArgs, targetContext, selection, scope);
    return {...page, through: page.models.map(joinRowOf)};
  }
  const targets = await allTargets(self, findAll, defName, source, targetArgs, targetContext, selection, scope);
  const ranked = targets.map((model, rank) => ({model, rank, row: joinRowOf(model)}));
  ranked.sort((a, b) => {
    for (const [column, direction] of order) {
      const c = compareValues(
        a.row && joinAdapter.getValueFromInstance(a.row, column),
        b.row && joinAdapter.getValueFromInstance(b.row, column),
      );
      if (c !== 0) {
        return String(direction).toUpperCase().startsWith("DESC") ? -c : c;
      }
    }
    return a.rank - b.rank;
  });
  const [start, end] = windowOf(args, ranked.length);
  const page = ranked.slice(start, end);
  return {total: ranked.length, models: page.map((e) => e.model), through: page.map((e) => e.row)};
}

/**
 * The parent keys that have at least one visible link through `descriptor`: a
 * join row matching its join filter and the join model's read scope, pointing
 * at a target matching its (already scoped) `where`.
 */
async function linkedSourceKeys(
  self: ResolutionHost, association: Association, descriptor: IncludeDescriptor,
  context: RequestContext, selection?: Selection,
): Promise<unknown[]> {
  const target = association.target;
  let otherKeys: unknown[] | undefined;
  if (descriptor.where && Object.keys(descriptor.where).length > 0) {
    const targetAdapter = self.getModelAdapter(target);
    const opts = await self.optionsForAdapter(association.source, target, context) as AdapterQueryOptions | undefined;
    const hooked = await runHook(self, target, "beforeFind", {
      where: await targetAdapter.processFilterArgument(descriptor.where, whereOperatorsFor(self.getDefinition(target)), opts || {}),
    });
    const rows = await targetAdapter.findAll(target, {
      where: hooked?.where,
      ...(opts?.transaction !== undefined ? {transaction: opts.transaction} : {}),
    });
    otherKeys = rows.map((r) => targetAdapter.getValueFromInstance(r, association.targetKey));
    if (otherKeys.length === 0) {
      return [];
    }
  }
  const joinAdapter = self.getModelAdapter(association.through as string);
  // No source restriction: this runs before the parent query, to filter it.
  const rows = await loadJoinRows(self, association, {otherKeys, where: descriptor.through?.where}, context, selection);
  const keys = new Set<string>();
  const out: unknown[] = [];
  for (const row of rows) {
    const key = joinAdapter.getValueFromInstance(row, association.foreignKey);
    if (key !== undefined && key !== null && !keys.has(keyOf(key))) {
      keys.add(keyOf(key));
      out.push(key);
    }
  }
  return out;
}

/**
 * Take the through-mode descriptors out of an include plan, turning each into a
 * key filter on the model it hangs off: "only parents with a visible matching
 * link". At the root that filter lands on `where`; deeper, on the `where` of the
 * descriptor above it. `false` when the root is left matching nothing.
 *
 * Adapter-independent on purpose: the join model's read scope has to decide
 * which links count, which an adapter's JOIN knows nothing about, and an adapter
 * that ignores `required` (Valkey) still filters correctly.
 */
export async function applyThroughRequired(
  self: ResolutionHost, defName: string, args: FindAllArgs, context: RequestContext, selection?: Selection,
): Promise<FindAllArgs | false> {
  const plan = args.include as IncludeMap[] | undefined;
  const hasThrough = (levels: IncludeMap[] | undefined): boolean => (levels || []).some((level) =>
    Object.values(level).some((d) => Boolean(d.through) || hasThrough(d.include)));
  if (!plan || !hasThrough(plan)) {
    return args;
  }
  // Set when a required link matches no parent at all. At the root that is an
  // empty page, answered without asking the backend; deeper it is `in: []` on
  // the descriptor above, as `scopeIncludePlan` writes "nothing" for an include.
  let rootNone = false;
  const walk = async(parentName: string, levels: IncludeMap[], root: boolean): Promise<{include: IncludeMap[]; filter?: PortableWhere}> => {
    let filter: PortableWhere | undefined;
    const out: IncludeMap[] = [];
    for (const level of levels) {
      const mapped: IncludeMap = {};
      for (const relName of Object.keys(level)) {
        const descriptor = level[relName];
        const association = self.getAssociations(parentName)[relName] as Association | undefined;
        if (descriptor.through && association && isThroughRead(association)) {
          // A through-mode relation is never JOINed: only `required` plans one.
          if (descriptor.required) {
            const keys = await linkedSourceKeys(self, association, descriptor, context, selection);
            if (root && keys.length === 0) {
              rootNone = true;
            }
            filter = mergeScopeWhere(filter, {[association.sourceKey]: {in: keys}});
          }
          continue;
        }
        if (descriptor.include && association) {
          // `association.target`, not `descriptor.target`: a descriptor from an
          // explicit `include` argument does not carry one.
          const nested = await walk(association.target, descriptor.include, false);
          mapped[relName] = {
            ...descriptor,
            include: nested.include.length > 0 ? nested.include : undefined,
            ...(nested.filter ? {where: mergeScopeWhere(descriptor.where, nested.filter)} : {}),
          };
          continue;
        }
        mapped[relName] = descriptor;
      }
      if (Object.keys(mapped).length > 0) {
        out.push(mapped);
      }
    }
    return {include: out, filter};
  };
  const {include, filter} = await walk(defName, plan, true);
  if (rootNone) {
    return false;
  }
  const next: FindAllArgs = {...args, include};
  if (filter) {
    next.where = mergeScopeWhere(args.where as PortableWhere | undefined, filter);
  }
  return next;
}
