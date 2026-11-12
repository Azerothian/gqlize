import type { Association, IncludeDescriptor, IncludeMap } from "../types/index";

/**
 * Normalising an include plan into the one shape the engine reads.
 *
 * A plan reaches the engine in more than one shape. The GraphQL `include`
 * argument is a list on an adapter with `includeIsList` and a single object on
 * one without (Valkey), and a client-written descriptor carries only what the
 * client typed: no `target`, no `associationType`, at any depth. The engine is
 * written for `IncludeMap[]` of complete descriptors throughout — scoping
 * (`scopeIncludePlan`), through-mode filtering (`applyThroughRequired`) and
 * the adapters all read `target` — so a plan is normalised here once, where it
 * enters, rather than each reader coping (#68).
 *
 * The shape an adapter is handed is always `IncludeMap[]`. `includeIsList` only
 * decides how the GraphQL argument is typed; no adapter reads the single-object
 * form.
 */

/** A plan in either argument shape — a list of levels, or one level — as a list. */
export function toIncludeLevels(include: unknown): IncludeMap[] | undefined {
  if (include === undefined || include === null) {
    return undefined;
  }
  const levels = Array.isArray(include) ? include : [include];
  return levels.filter((level): level is IncludeMap => !!level && typeof level === "object" && !Array.isArray(level));
}

/**
 * Every descriptor in `levels` with `target` and `associationType` read off the
 * live association it names, recursively, and `through` set on a through-mode
 * `belongsToMany` (`Association.throughModel`) so the engine never hands one to
 * an adapter's JOIN. Copy-on-write: a descriptor may be a definition's own
 * object (a declared include). A name that is not a relationship is left as it
 * came, for whatever reads it next to reject.
 */
export function completeIncludePlan(
  levels: IncludeMap[] | undefined,
  defName: string,
  getAssociations: (defName: string) => {[relName: string]: Association},
): IncludeMap[] | undefined {
  if (!levels) {
    return levels;
  }
  const associations = getAssociations(defName) || {};
  return levels.map((level) => {
    const out: IncludeMap = {};
    for (const relName of Object.keys(level)) {
      const descriptor = level[relName] || ({} as IncludeDescriptor);
      const association = associations[relName];
      if (!association) {
        out[relName] = descriptor;
        continue;
      }
      const through = association.associationType === "belongsToMany" && association.throughModel
        ? {model: association.through as string, ...descriptor.through}
        : descriptor.through;
      out[relName] = {
        ...descriptor,
        target: association.target,
        associationType: association.associationType,
        ...(through ? {through} : {}),
        include: completeIncludePlan(toIncludeLevels(descriptor.include), association.target, getAssociations),
      };
      if (out[relName].include === undefined) {
        delete out[relName].include;
      }
    }
    return out;
  });
}

/**
 * A plan in either argument shape as a list of levels, at the root and under
 * every descriptor, without reading associations: for a caller that has none to
 * hand. Copy-on-write; a plan already in shape comes back as the same object.
 * The engine itself uses {@link completeIncludePlan}, which does this and more.
 */
export function toIncludePlan(include: unknown): IncludeMap[] | undefined {
  const levels = toIncludeLevels(include);
  if (!levels) {
    return levels;
  }
  let changed = levels.length !== (Array.isArray(include) ? include.length : -1);
  const out = levels.map((level) => {
    let copy: IncludeMap | undefined;
    for (const relName of Object.keys(level)) {
      const descriptor = level[relName];
      if (!descriptor || typeof descriptor !== "object" || descriptor.include === undefined) {
        continue;
      }
      const nested = toIncludePlan(descriptor.include);
      if (nested !== descriptor.include) {
        copy ??= {...level};
        copy[relName] = {...descriptor, include: nested};
      }
    }
    changed ||= copy !== undefined;
    return copy ?? level;
  });
  return changed ? out : (include as IncludeMap[]);
}
