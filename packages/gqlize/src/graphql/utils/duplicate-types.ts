import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLNamedType,
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

export function findDuplicateTypes(
  config: any,
  origins: Map<string, string> = new Map(),
): Map<string, DuplicateOccurrence[]> {
  /** name -> distinct instances, in discovery order */
  const seen = new Map<string, {instance: GraphQLNamedType; path: string}[]>();
  const visited = new Set<GraphQLNamedType>();

  function visit(value: unknown, path: string) {
    if (!value) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => visit(entry, `${path}[${i}]`));
      return;
    }
    let named: GraphQLNamedType | undefined;
    try {
      named = getNamedType(value as any) as unknown as GraphQLNamedType | undefined;
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
    descend(named, path);
  }

  function descend(type: GraphQLNamedType, path: string) {
    try {
      if (isObjectType(type) || isInterfaceType(type)) {
        for (const iface of type.getInterfaces()) {
          visit(iface, `${path}/${type.name}`);
        }
        for (const [key, field] of Object.entries(type.getFields())) {
          visit(field.type, `${path}/${type.name}.${key}`);
          for (const arg of field.args || []) {
            visit(arg.type, `${path}/${type.name}.${key}(${arg.name}:)`);
          }
        }
      } else if (isUnionType(type)) {
        for (const member of type.getTypes()) {
          visit(member, `${path}/${type.name}`);
        }
      } else if (isInputObjectType(type)) {
        for (const [key, field] of Object.entries(type.getFields())) {
          visit(field.type, `${path}/${type.name}.${key}`);
        }
      } else if (isEnumType(type) || isScalarType(type)) {
        // leaf
      }
    } catch {
      // a thunk that cannot be forced yet — the paths found so far still stand
    }
  }

  visit(config?.query, "query");
  visit(config?.mutation, "mutation");
  visit(config?.subscription, "subscription");
  visit(config?.types, "types");

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
  config: any,
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
