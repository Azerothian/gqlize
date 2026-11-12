// The include plan in the one shape the engine reads: a list of levels, at the
// root and under every descriptor.
//
// An adapter chooses the shape of the GraphQL `include` argument
// (`includeIsList`, see graphql-types' `adapter-args.ts`). A SQL adapter makes
// it a list, because one model may be joined more than once; a key-value adapter
// makes it one object. The engine and gqlize only read lists (`IncludeMap[]`),
// so a client-supplied single object used to reach `scopeIncludePlan` as is and
// throw "include is not iterable" (#68). One object is exactly one level, so the
// conversion loses nothing.

import type { IncludeMap } from "../types/index";

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** One level, with every descriptor's nested `include` normalised. Returns `level` itself when nothing changed. */
function normaliseLevel(level: IncludeMap): IncludeMap {
  let out: IncludeMap | undefined;
  for (const relName of Object.keys(level)) {
    const descriptor = level[relName];
    if (!isPlainObject(descriptor) || descriptor.include === undefined) {
      continue;
    }
    const nested = toIncludePlan(descriptor.include);
    if (nested !== descriptor.include) {
      out ??= { ...level };
      out[relName] = { ...descriptor, include: nested };
    }
  }
  return out ?? level;
}

/**
 * `include` as a list of levels: a list is kept, one object becomes a list of
 * one, `null` / `undefined` become `undefined`. Nested `include`s are normalised
 * the same way.
 *
 * Copy-on-write: a plan that is already in shape comes back as the same object,
 * so callers can compare by identity, and nothing the caller holds is written.
 */
export function toIncludePlan(include: unknown): IncludeMap[] | undefined {
  if (include === undefined || include === null) {
    return undefined;
  }
  const levels = Array.isArray(include) ? include : [include];
  let changed = levels !== include;
  const out = levels.map((level: unknown) => {
    if (!isPlainObject(level)) {
      // Not an include level at all. Kept rather than dropped, so whatever
      // reads the plan next reports it instead of it silently vanishing.
      return level as IncludeMap;
    }
    const normalised = normaliseLevel(level as IncludeMap);
    changed ||= normalised !== level;
    return normalised;
  });
  return changed ? out : (include as IncludeMap[]);
}
