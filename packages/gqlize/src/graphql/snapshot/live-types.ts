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
} from "graphql";

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
  visit(root, origin, out, opts);
  return out;
}

/**
 * The same walk over a field *config* map — `extend` fields are configs the user
 * hands to `createSchema` (`{type, args, resolve}`), not built `GraphQLField`s.
 */
export function collectLiveTypesFromFields(
  fields: Record<string, any> | undefined,
  originPrefix: string,
  out: Map<string, LiveType>,
  opts: CollectOptions = {},
): Map<string, LiveType> {
  for (const [key, config] of Object.entries(fields || {})) {
    const origin = `${originPrefix}.${key}`;
    visit(config?.type, origin, out, opts);
    for (const arg of Object.values<any>(config?.args || {})) {
      visit(arg?.type, origin, out, opts);
    }
  }
  return out;
}

function visit(value: unknown, origin: string, out: Map<string, LiveType>, opts: CollectOptions) {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => visit(entry, `${origin}[${i}]`, out, opts));
    return;
  }
  let named: GraphQLNamedType | undefined;
  try {
    named = getNamedType(value as any) as unknown as GraphQLNamedType | undefined;
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
  try {
    descend(named, origin, out, opts);
  } catch {
    // `getFields()` forces the type's thunk, and a user thunk may not be ready
    // this early (that is what `extendFactory` is for). Claiming the type itself
    // is still correct; the closure below it just falls back to the old
    // behaviour rather than failing the load here.
  }
}

function descend(type: GraphQLNamedType, origin: string, out: Map<string, LiveType>, opts: CollectOptions) {
  if (isObjectType(type) || isInterfaceType(type)) {
    for (const iface of type.getInterfaces()) {
      visit(iface, origin, out, opts);
    }
    for (const field of Object.values(type.getFields())) {
      visit(field.type, origin, out, opts);
      for (const arg of field.args || []) {
        visit(arg.type, origin, out, opts);
      }
    }
  } else if (isUnionType(type)) {
    for (const member of type.getTypes()) {
      visit(member, origin, out, opts);
    }
  } else if (isInputObjectType(type)) {
    for (const field of Object.values(type.getFields())) {
      visit(field.type, origin, out, opts);
    }
  } else if (isEnumType(type) || isScalarType(type)) {
    // leaf
  }
}
