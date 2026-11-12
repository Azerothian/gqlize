// `required` for the relations no adapter JOIN can apply, turned into a key
// filter on the parent before the adapter sees the include plan.
//
// An include descriptor marked `required` means "only parents with a visible
// matching related row". A SQL adapter does that with an INNER JOIN, but three
// kinds of relation never reach one:
//
// - a through-mode `belongsToMany` (`Association.throughModel`), whose join
//   model's read scope decides which links exist (`through-reads.ts`);
// - a cross-adapter relation (`Association.crossAdapter`): no JOIN spans two
//   datastores;
// - any relation of a model whose adapter has no joins (`supportsJoins: false`,
//   Valkey), which never reads `include` at all.
//
// For each of those this fetches the keys that qualify (the target's rows
// matching the descriptor's `where`, which `scopeIncludePlan` has already
// narrowed by the target's read scope, and any `required` relations nested under
// it, recursively) and filters the parent on them: at the root on `where`,
// deeper on the `where` of the descriptor above. The descriptor itself is then
// taken out of the plan, `required` or not, since the adapter cannot apply it;
// the relation's rows are read by its own resolver.

import { whereOperatorsFor } from "@azerothian/utilize/exposed-methods";
import { mergeScopeWhere } from "@azerothian/utilize/gate";
import type { PortableWhere } from "@azerothian/utilize/gate";
import type {
  AdapterQueryOptions, Association, FindAllArgs, IncludeDescriptor, IncludeMap, RequestContext, Selection,
} from "@azerothian/utilize/types/index";
import type { ResolutionHost } from "./resolution";
import { runHook } from "./hooks";
import { isThroughRead, linkedSourceKeys } from "./through-reads";

/** Why the engine, not the adapter, has to apply a relation; `undefined` when the adapter can. */
function engineApplied(self: ResolutionHost, parentName: string, association: Association): "through" | "keys" | undefined {
  if (isThroughRead(association)) {
    return "through";
  }
  if (association.crossAdapter || self.getModelAdapter(parentName).supportsJoins === false) {
    return "keys";
  }
  return undefined;
}

/** A key compared by value: a scalar, or a Buffer/Date some drivers hand back. */
function keyOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return `${typeof value}:${value}`;
  }
  return `object:${JSON.stringify(value)}`;
}

function distinct(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const key = keyOf(value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

/**
 * The `column` values of the target rows `descriptor` asks for: its (scoped)
 * `where`, narrowed further by the `required` relations nested under it.
 * Unpaged on purpose: the parent filter needs every qualifying key.
 */
async function targetValues(
  self: ResolutionHost, association: Association, descriptor: IncludeDescriptor, column: string,
  context: RequestContext, selection?: Selection,
): Promise<unknown[]> {
  const target = association.target;
  let where = descriptor.where;
  if (descriptor.include) {
    const nested = await applyEngineRequired(self, target, {where, include: descriptor.include}, context, selection);
    if (nested === false) {
      return [];
    }
    where = nested.where as PortableWhere | undefined;
  }
  const targetAdapter = self.getModelAdapter(target);
  const opts = await self.optionsForAdapter(association.source, target, context) as AdapterQueryOptions | undefined;
  const native = where && Object.keys(where).length > 0
    ? await targetAdapter.processFilterArgument(where, whereOperatorsFor(self.getDefinition(target)), opts || {})
    : undefined;
  // The target's read scope, applied here as well as by `scopeIncludePlan`:
  // a nested connection's own `include` reaches this pass unscoped, and a row
  // the scope hides must not count as a match. Applying it twice is harmless.
  const scoped = await self.host.scopedWhere(target, "read", context, native, opts);
  if (scoped === false) {
    return [];
  }
  const hooked = await runHook(self, target, "beforeFind", {where: scoped});
  const rows = await targetAdapter.findAll(target, {
    where: hooked?.where,
    ...(opts?.transaction !== undefined ? {transaction: opts.transaction} : {}),
  });
  return distinct(rows.map((row) => targetAdapter.getValueFromInstance(row, column)));
}

/** The filter on the parent that keeps only rows with a qualifying related row, or `undefined` if none can be built. */
async function parentFilter(
  self: ResolutionHost, how: "through" | "keys", association: Association, descriptor: IncludeDescriptor,
  context: RequestContext, selection?: Selection,
): Promise<PortableWhere | undefined> {
  if (how === "through") {
    return {[association.sourceKey]: {in: await linkedSourceKeys(self, association, descriptor, context, selection)}};
  }
  switch (association.associationType) {
    case "belongsTo":
      return {[association.foreignKey]: {in: await targetValues(self, association, descriptor, association.targetKey, context, selection)}};
    case "hasOne":
    case "hasMany":
      return {[association.sourceKey]: {in: await targetValues(self, association, descriptor, association.foreignKey, context, selection)}};
    case "belongsToMany":
      // A plain many-to-many off a join model ormize registered (the generated
      // one of a cross-adapter or Valkey pair): its links are rows of that model.
      return association.through
        ? {[association.sourceKey]: {in: await linkedSourceKeys(self, association, descriptor, context, selection)}}
        : undefined;
    default:
      return undefined;
  }
}

const matchesNothing = (where: PortableWhere) =>
  Object.values(where).some((clause) => Array.isArray((clause as {in?: unknown[]})?.in) && (clause as {in: unknown[]}).in.length === 0);

/**
 * Take every engine-applied relation out of an include plan, turning the
 * `required` ones into key filters on the model they hang off. `false` when the
 * root is left matching nothing, so the caller answers an empty page without
 * asking the backend.
 */
export async function applyEngineRequired(
  self: ResolutionHost, defName: string, args: FindAllArgs, context: RequestContext, selection?: Selection,
): Promise<FindAllArgs | false> {
  const plan = args.include as IncludeMap[] | undefined;
  if (!plan || plan.length === 0) {
    return args;
  }
  let rootNone = false;
  let changed = false;
  const walk = async(parentName: string, levels: IncludeMap[], root: boolean): Promise<{include: IncludeMap[]; filter?: PortableWhere}> => {
    let filter: PortableWhere | undefined;
    const out: IncludeMap[] = [];
    for (const level of levels) {
      const mapped: IncludeMap = {};
      for (const relName of Object.keys(level)) {
        const descriptor = level[relName];
        const association = self.getAssociations(parentName)?.[relName] as Association | undefined;
        const how = association ? engineApplied(self, parentName, association) : undefined;
        if (association && how) {
          if (descriptor.required) {
            const keyFilter = await parentFilter(self, how, association, descriptor, context, selection);
            if (keyFilter) {
              if (root && matchesNothing(keyFilter)) {
                rootNone = true;
              }
              filter = mergeScopeWhere(filter, keyFilter);
            }
          }
          changed = true;
          continue;
        }
        if (descriptor.include && association) {
          // `association.target`, not `descriptor.target`: a descriptor from an
          // explicit `include` argument may not carry one.
          const nested = await walk(association.target, descriptor.include, false);
          mapped[relName] = {
            ...descriptor,
            include: nested.include.length > 0 ? nested.include : undefined,
            ...(nested.filter ? {where: mergeScopeWhere(descriptor.where, nested.filter)} : {}),
          };
          if (mapped[relName].include === undefined) {
            delete mapped[relName].include;
          }
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
  if (!changed) {
    return args;
  }
  const next: FindAllArgs = {...args, include: include.length > 0 ? include : undefined};
  if (filter) {
    next.where = mergeScopeWhere(args.where as PortableWhere | undefined, filter);
  }
  return next;
}
