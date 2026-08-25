import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLNamedType,
  type GraphQLSchemaConfig,
  type GraphQLType,
} from "graphql";

/**
 * graphql reports a duplicated type name and nothing else:
 *
 *     Schema must contain uniquely named types but contains multiple types named "Foo".
 *
 * Which is the one fact you already have. What you need is *where each instance
 * came from* — the artifact rebuilt one and something live supplied the other,
 * and the two answers ("rebuild the artifact" vs "use `extendFactory`") are
 * different. This walks the assembled schema config and reports both.
 *
 * Only ever runs on the failure path.
 */
export interface DuplicateOccurrence {
  path: string;
  origin?: string;
}

interface Claim {
  instance: GraphQLNamedType;
  path: string;
}

export function findDuplicateTypes(
  config: Partial<GraphQLSchemaConfig> | undefined,
  origins: Map<string, string> = new Map(),
): Map<string, DuplicateOccurrence[]> {
  /** name -> distinct instances, in discovery order */
  const seen = new Map<string, Claim[]>();
  const visited = new Set<GraphQLNamedType>();
  /** types claimed but not yet descended into */
  const pending: Claim[] = [];

  function visit(value: unknown, path: string, claimed: Claim[]) {
    if (!value) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => visit(entry, `${path}[${i}]`, claimed));
      return;
    }
    let named: GraphQLNamedType | undefined;
    try {
      named = getNamedType(value as GraphQLType);
    } catch {
      return;
    }
    if (!named?.name) {
      return;
    }
    const instances = seen.get(named.name) || [];
    if (!instances.some((entry) => entry.instance === named)) {
      instances.push({instance: named, path});
      seen.set(named.name, instances);
    }
    if (visited.has(named)) {
      return;
    }
    visited.add(named);
    claimed.push({instance: named, path});
  }

  function descend(type: GraphQLNamedType, path: string, claimed: Claim[]) {
    try {
      if (isObjectType(type) || isInterfaceType(type)) {
        for (const iface of type.getInterfaces()) {
          visit(iface, `${path}/${type.name}`, claimed);
        }
        for (const [key, field] of Object.entries(type.getFields())) {
          visit(field.type, `${path}/${type.name}.${key}`, claimed);
          for (const arg of field.args || []) {
            visit(arg.type, `${path}/${type.name}.${key}(${arg.name}:)`, claimed);
          }
        }
      } else if (isUnionType(type)) {
        for (const member of type.getTypes()) {
          visit(member, `${path}/${type.name}`, claimed);
        }
      } else if (isInputObjectType(type)) {
        for (const [key, field] of Object.entries(type.getFields())) {
          visit(field.type, `${path}/${type.name}.${key}`, claimed);
        }
      } else if (isEnumType(type) || isScalarType(type)) {
        // leaf
      }
    } catch {
      // a thunk that cannot be forced yet — the paths found so far still stand
    }
  }

  /** reverse, so popping the stack walks children left to right */
  function schedule(claimed: Claim[]) {
    for (let i = claimed.length - 1; i >= 0; i--) {
      pending.push(claimed[i]);
    }
  }

  const roots: Claim[] = [];
  visit(config?.query, "query", roots);
  visit(config?.mutation, "mutation", roots);
  visit(config?.subscription, "subscription", roots);
  visit(config?.types, "types", roots);
  schedule(roots);
  // An explicit stack, not recursion: the one moment this diagnostic exists for
  // is a failed `new GraphQLSchema`, and on a deeply chained schema the
  // recursive form reported a stack overflow instead of the duplicate.
  while (pending.length > 0) {
    const next = pending.pop() as Claim;
    const claimed: Claim[] = [];
    descend(next.instance, next.path, claimed);
    schedule(claimed);
  }

  const duplicates = new Map<string, DuplicateOccurrence[]>();
  for (const [name, instances] of seen) {
    if (instances.length > 1) {
      duplicates.set(name, instances.map((entry) => ({
        path: entry.path,
        origin: origins.get(name),
      })));
    }
  }
  return duplicates;
}

/**
 * Replace a `GraphQLSchema` duplicate-name failure with one that names the
 * origins. Any other error is returned untouched — this must never swallow a
 * different failure.
 */
export function enrichDuplicateTypeError(
  err: unknown,
  config: Partial<GraphQLSchemaConfig> | undefined,
  origins: Map<string, string> = new Map(),
  hint = "",
): unknown {
  const message = (err as Error)?.message || "";
  if (!/uniquely named types/.test(message)) {
    return err;
  }
  let duplicates: Map<string, DuplicateOccurrence[]>;
  try {
    duplicates = findDuplicateTypes(config, origins);
  } catch {
    return err;
  }
  if (duplicates.size === 0) {
    return err;
  }
  const detail = [...duplicates].map(([name, occurrences]) => {
    const origin = occurrences.find((o) => o.origin)?.origin;
    const where = occurrences.map((o) => `    - ${o.path}`).join("\n");
    return (
      `  "${name}" exists as ${occurrences.length} distinct instances:\n${where}\n` +
      `    one of them is live${origin ? ` (supplied via ${origin})` : ""}; the rest are rebuilt ` +
      "from the artifact"
    );
  }).join("\n");
  return new Error(
    `gqlize: the schema contains more than one type per name, so it cannot be built.\n${detail}\n` +
      (hint || "") +
      "\nEvery type name must map to exactly one instance: a type the artifact defines cannot also " +
      "be supplied live.",
  );
}
