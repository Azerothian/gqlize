// Readers for the declarative half of `expose.instanceMethods` — the keys that
// say what a method *needs loaded* and how it *shapes the query*, as opposed to
// the schema shape (`type`/`args`) every layer already reads.
//
// They live here, next to `gate.ts`, for the same reason the permission helpers
// do: gqlize (projection, resolvers), ormize (option hooks, order expansion) and
// both adapters (orderBy enum, where input) each need a subset of them and must
// not disagree about what a declaration means. GraphQL-free.

import { isQueryInstanceMethodAllowed, type Permission } from "./gate";
import type {
  DeclaredIncludeMap,
  Definition,
  ExposedMethodContext,
  ExposedMethods,
  OptionHook,
  OrderEntry,
  WhereOperators,
} from "./types/index";

/** The exposed query instance methods of a definition, never undefined. */
export function queryInstanceMethods(definition: Definition | undefined): ExposedMethods {
  return definition?.expose?.instanceMethods?.query || {};
}

/** The exposed mutation instance methods (pre-commit transforms) of a definition. */
export function mutationInstanceMethods(definition: Definition | undefined): ExposedMethods {
  return definition?.expose?.instanceMethods?.mutations || {};
}

/**
 * The widening one selection implies: the columns and relations the selected
 * exposed methods declared they read off `this`.
 *
 * `fields` comes back as `"*"` when any selected method opted out of narrowing,
 * which the caller turns into "load everything" by dropping the projection.
 * Both halves are additive — a caller merges them on top of what the selection
 * set already asked for rather than replacing it.
 */
export function methodProjection(
  definition: Definition | undefined,
  selectedFieldNames: string[] | undefined,
): { fields?: string[] | "*"; include?: DeclaredIncludeMap } {
  if (!selectedFieldNames?.length) {
    return {};
  }
  const methods = queryInstanceMethods(definition);
  let fields: string[] | undefined = undefined;
  let include: DeclaredIncludeMap | undefined = undefined;
  for (const name of selectedFieldNames) {
    const method = methods[name];
    if (!method) {
      continue;
    }
    if (method.fields === "*") {
      // One opt-out is enough: there is a single projection per query.
      return { fields: "*", include: mergeMethodIncludes(include, includesOf(methods, selectedFieldNames)) };
    }
    if (method.fields?.length) {
      fields = [...(fields || []), ...method.fields];
    }
    if (method.include) {
      include = mergeMethodIncludes(include, method.include);
    }
  }
  return { fields, include };
}

/** Every selected method's declared `include`, folded together. */
function includesOf(methods: ExposedMethods, selectedFieldNames: string[]): DeclaredIncludeMap | undefined {
  let include: DeclaredIncludeMap | undefined = undefined;
  for (const name of selectedFieldNames) {
    const declared = methods[name]?.include;
    if (declared) {
      include = mergeMethodIncludes(include, declared);
    }
  }
  return include;
}

/**
 * Shallow-merge two declared include maps. Later relations win per key, and a
 * key present on only one side survives — a method's declaration adds to the
 * plan rather than replacing it.
 */
function mergeMethodIncludes(a: DeclaredIncludeMap | undefined, b: DeclaredIncludeMap | undefined): DeclaredIncludeMap | undefined {
  if (!a) {
    // A copy even with nothing to merge. Returning `b` handed the definition's
    // own declared map out to the resolution path, which is how a per-request
    // rewrite used to reach config. The descriptors *inside* are still shared —
    // copying them here would fork one per selected method per request, and the
    // engine's `expandComputedIncludeOrder` is copy-on-write, so it never
    // writes on them.
    return b ? { ...b } : undefined;
  }
  if (!b) {
    return { ...a };
  }
  return { ...a, ...b };
}

/** One occurrence of a selected exposed method, with the args it was selected with. */
export type MethodSelection = {
  name: string;
  args?: unknown;
};

/**
 * The `input` hooks of the selected methods, in selection order, bound to the
 * context each should see — so the engine can run them without knowing what a
 * method is.
 *
 * Takes occurrences rather than names because the same method may be selected
 * twice under different aliases with different args: its `input` runs once per
 * occurrence, each seeing its own args.
 */
export function methodOptionHooks(
  definition: Definition | undefined,
  occurrences: MethodSelection[] | undefined,
  ctx: ExposedMethodContext,
): OptionHook[] | undefined {
  if (!occurrences?.length) {
    return undefined;
  }
  const methods = queryInstanceMethods(definition);
  const hooks: OptionHook[] = [];
  for (const occurrence of occurrences) {
    const input = methods[occurrence.name]?.input;
    if (input) {
      // `context` is only known when the query actually runs, so it is a
      // parameter of the bound hook rather than part of the captured ctx.
      hooks.push((params, context) => input(params, { ...ctx, args: occurrence.args, context }));
    }
  }
  return hooks.length > 0 ? hooks : undefined;
}

/**
 * The exposed query instance methods that contribute to the model's `orderBy`
 * enum, after permission filtering. This is what an adapter returns from
 * `computedOrderableFields`.
 */
export function computedOrderableFields(
  definition: Definition | undefined,
  defName: string,
  permission?: Permission,
): string[] {
  const methods = queryInstanceMethods(definition);
  return Object.keys(methods).filter((name) =>
    methods[name].orderBy !== undefined && isQueryInstanceMethodAllowed(permission, defName, name));
}

/**
 * Expand any computed entry in an `orderBy` list into the real column ordering
 * it stands for, leaving plain column entries untouched.
 *
 * A computed entry arrives as `[methodName, direction]` because the generated
 * enum member carries the method's own name — the expansion is deliberately a
 * runtime name lookup rather than something baked into the enum value, so a
 * materialized schema snapshot picks up a changed declaration for free.
 */
export function expandOrderBy(
  definition: Definition | undefined,
  orderBy: OrderEntry[] | undefined,
  ctx: ExposedMethodContext = {},
): OrderEntry[] | undefined {
  if (!orderBy?.length) {
    return orderBy;
  }
  const methods = queryInstanceMethods(definition);
  if (Object.keys(methods).length === 0) {
    return orderBy;
  }
  const out: OrderEntry[] = [];
  for (const entry of orderBy) {
    // An `orderBy` value may be a raw backend construct (a literal, a nested
    // association path) rather than the `[column, direction]` pair the generated
    // enum produces. Only the pair form can name a method.
    const declared = Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
      ? methods[entry[0]]?.orderBy
      : undefined;
    if (!declared) {
      out.push(entry);
      continue;
    }
    const [, direction] = entry;
    if (typeof declared === "function") {
      out.push(...declared(direction, ctx));
    } else {
      out.push(...declared.map((column) => [column, direction] as OrderEntry));
    }
  }
  return out;
}

/** The value type and operator list one method's `where` declaration asks for. */
export type ComputedWhereField = {
  methodName: string;
  /** For the portable `where: "column"` form, the column to borrow the type of. */
  column?: string;
  /** See {@link DefinitionField.type}. Author-declared value type, for the object form. */
  type?: unknown;
  /** Restrict the generated operators, when declared. */
  operators?: string[];
};

/**
 * The exposed query instance methods that contribute a field to the model's
 * `where` input, after permission filtering — the filter counterpart of
 * {@link computedOrderableFields}.
 */
export function computedWhereFields(
  definition: Definition | undefined,
  defName: string,
  permission?: Permission,
): ComputedWhereField[] {
  const methods = queryInstanceMethods(definition);
  const out: ComputedWhereField[] = [];
  for (const methodName of Object.keys(methods)) {
    const declared = methods[methodName].where;
    if (declared === undefined || !isQueryInstanceMethodAllowed(permission, defName, methodName)) {
      continue;
    }
    if (typeof declared === "string") {
      out.push({ methodName, column: declared });
    } else {
      out.push({ methodName, type: declared.type, operators: declared.operators });
    }
  }
  return out;
}

/**
 * The custom where-operators a definition's computed filters amount to, keyed by
 * method name.
 *
 * A computed filter needs no new runtime: `where: {fullName: {like: "%smith%"}}`
 * is exactly the shape an author-supplied `whereOperators` entry already
 * receives, and the expander that applies them matches its key map at every
 * depth of the where tree — so nested includes come free.
 *
 * No permission filtering: a denied method contributes no `where` field, so its
 * name cannot survive GraphQL's own validation of the argument.
 */
export function computedWhereOperators(definition: Definition | undefined): WhereOperators | undefined {
  const methods = queryInstanceMethods(definition);
  let out: WhereOperators | undefined = undefined;
  for (const methodName of Object.keys(methods)) {
    const declared = methods[methodName].where;
    if (declared === undefined) {
      continue;
    }
    out = out || {};
    if (typeof declared === "string") {
      // Portable form: apply the operator object to the named column instead.
      const column = declared;
      out[methodName] = (_whereObject, _options, value) => ({ [column]: value });
    } else {
      out[methodName] = declared.resolve;
    }
  }
  return out;
}

/**
 * A definition's own `whereOperators` plus the ones its computed filters imply.
 *
 * Every read of `definition.whereOperators` on a query path goes through this,
 * so a computed filter is expanded wherever an author-supplied operator would
 * be. The definition's own operators win a name clash — they are the older
 * surface, and `assertNoExposedMethodCollisions` reports the clash anyway.
 */
export function whereOperatorsFor(definition: Definition | undefined): WhereOperators | undefined {
  const computed = computedWhereOperators(definition);
  if (!computed) {
    return definition?.whereOperators;
  }
  if (!definition?.whereOperators) {
    return computed;
  }
  return { ...computed, ...definition.whereOperators };
}

/**
 * Fail a schema build when an exposed instance method's name is already taken.
 *
 * A query method sharing a name with a column was always an invalid schema — the
 * generated output type cannot hold two fields of that name — but it used to
 * fail obscurely, at whichever builder happened to overwrite the other first.
 * The declarative keys make the collision reachable from two more inputs
 * (`orderBy`, `where`), each of which would silently shadow the column rather
 * than error, so it is worth catching at the one point that sees both.
 *
 * The two instance-method targets are checked against each other as well: they
 * share one `definition.instanceMethods` implementation namespace, so a name in
 * both is a single function asked to be a read-only field *and* a pre-commit
 * transform. Class methods are deliberately out of scope — they live in their own
 * `${defName}QueryClassMethods` object and share a namespace with nothing.
 */
export function assertNoExposedMethodCollisions(
  defName: string,
  definition: Definition | undefined,
  columnNames: string[],
): void {
  const columns = new Set(columnNames);
  const query = queryInstanceMethods(definition);
  const mutations = mutationInstanceMethods(definition);
  for (const [target, methods] of [["query", query], ["mutations", mutations]] as Array<[string, ExposedMethods]>) {
    for (const methodName of Object.keys(methods)) {
      if (columns.has(methodName)) {
        throw new Error(
          `gqlize: "${defName}.${methodName}" is declared in expose.instanceMethods.${target} but "${methodName}" is already a field on the model. `
          + "An exposed instance method and a column cannot share a name — the generated type, orderBy enum and where input each have one slot for it.",
        );
      }
    }
  }
  for (const methodName of Object.keys(query)) {
    if (mutations[methodName]) {
      throw new Error(
        `gqlize: "${defName}.${methodName}" is declared in both expose.instanceMethods.query and expose.instanceMethods.mutations. `
        + "Both targets resolve to the same definition.instanceMethods implementation, so one function cannot serve as a read-only field and a pre-commit transform.",
      );
    }
  }
}

