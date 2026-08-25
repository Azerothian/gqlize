import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isIntrospectionType,
  isObjectType,
  isScalarType,
  isSpecifiedScalarType,
  isUnionType,
  type GraphQLNamedType,
  type GraphQLType,
} from "graphql";

import type { GqlFieldMap } from "../../types";

/** a live (user-authored) type instance and where it entered the schema */
export interface LiveType {
  type: GraphQLNamedType;
  /** e.g. `external:StatusPayload`, `extend:query.health`, `root:subscription` */
  origin: string;
}

export interface CollectOptions {
  /**
   * Names the walk must neither claim nor descend into — the types gqlize
   * builds itself. A user type may legitimately *reference* a model type; its
   * closure past that point belongs to the artifact, not to the user.
   */
  skip?: (name: string) => boolean;
}

/**
 * Every named type reachable from a live root.
 *
 * The snapshot's split between serialized and live types is name-based, and
 * before this walk it was also *non-transitive*: only the type sitting directly
 * in an `override` / `expose` slot (or on an `extend` field) counted as live,
 * while anything nested inside it was left to the IR. A user type in both
 * positions then existed twice at load — once as the user's instance, once as a
 * fresh clone — and `new GraphQLSchema` rejects the pair.
 *
 * Recording the whole closure lets the materializer seed the live instance for
 * every name it covers, so the IR clone is never constructed.
 *
 * First writer wins: two live roots sharing a nested type share one instance,
 * which is exactly the invariant the schema requires.
 */
export function collectLiveTypes(
  root: unknown,
  origin: string,
  out: Map<string, LiveType>,
  opts: CollectOptions = {},
): Map<string, LiveType> {
  walk(root, origin, out, opts);
  return out;
}

/**
 * The same walk over a field *config* map — `extend` fields are configs the user
 * hands to `createSchema` (`{type, args, resolve}`), not built `GraphQLField`s.
 */
export function collectLiveTypesFromFields(
  fields: GqlFieldMap | undefined,
  originPrefix: string,
  out: Map<string, LiveType>,
  opts: CollectOptions = {},
): Map<string, LiveType> {
  for (const [key, config] of Object.entries(fields || {})) {
    const origin = `${originPrefix}.${key}`;
    walk(config?.type, origin, out, opts);
    for (const arg of Object.values(config?.args ?? {})) {
      walk(arg?.type, origin, out, opts);
    }
  }
  return out;
}

/**
 * One closure, walked off an explicit stack.
 *
 * Recursion here used to overflow on a schema whose models chain a few hundred
 * deep — a shape `createSchema` builds without complaint, so the artifact path
 * failed where the live path did not. Children are pushed in reverse so popping
 * walks them left to right, preserving the order the recursive form claimed
 * names in (which is what decides the recorded `origin` under first-writer-wins).
 */
function walk(root: unknown, origin: string, out: Map<string, LiveType>, opts: CollectOptions) {
  const pending: LiveType[] = [];
  const claimed: LiveType[] = [];
  visit(root, origin, out, opts, claimed);
  push(claimed, pending);
  while (pending.length > 0) {
    const next = pending.pop() as LiveType;
    const children: LiveType[] = [];
    try {
      descend(next.type, next.origin, out, opts, children);
    } catch {
      // `getFields()` forces the type's thunk, and a user thunk may not be ready
      // this early (that is what `extendFactory` is for). Claiming the type itself
      // is still correct; the closure below it just falls back to the old
      // behaviour rather than failing the load here.
    }
    push(children, pending);
  }
}

function push(claimed: LiveType[], pending: LiveType[]) {
  for (let i = claimed.length - 1; i >= 0; i--) {
    pending.push(claimed[i]);
  }
}

function visit(
  value: unknown,
  origin: string,
  out: Map<string, LiveType>,
  opts: CollectOptions,
  claimed: LiveType[],
) {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => visit(entry, `${origin}[${i}]`, out, opts, claimed));
    return;
  }
  let named: GraphQLNamedType | undefined;
  try {
    named = getNamedType(value as GraphQLType);
  } catch {
    // not a GraphQL type instance (a bare config object, a thunk) — nothing to
    // claim: the builder that consumes it records the type it produces.
    return;
  }
  if (!named?.name || out.has(named.name)) {
    return;
  }
  if (
    isIntrospectionType(named) ||
    (isScalarType(named) && isSpecifiedScalarType(named)) ||
    opts.skip?.(named.name)
  ) {
    return;
  }
  out.set(named.name, {type: named, origin});
  claimed.push({type: named, origin});
}

function descend(
  type: GraphQLNamedType,
  origin: string,
  out: Map<string, LiveType>,
  opts: CollectOptions,
  claimed: LiveType[],
) {
  if (isObjectType(type) || isInterfaceType(type)) {
    for (const iface of type.getInterfaces()) {
      visit(iface, origin, out, opts, claimed);
    }
    for (const field of Object.values(type.getFields())) {
      visit(field.type, origin, out, opts, claimed);
      for (const arg of field.args || []) {
        visit(arg.type, origin, out, opts, claimed);
      }
    }
  } else if (isUnionType(type)) {
    for (const member of type.getTypes()) {
      visit(member, origin, out, opts, claimed);
    }
  } else if (isInputObjectType(type)) {
    for (const field of Object.values(type.getFields())) {
      visit(field.type, origin, out, opts, claimed);
    }
  } else if (isEnumType(type) || isScalarType(type)) {
    // leaf
  }
}
