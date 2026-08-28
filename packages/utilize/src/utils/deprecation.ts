import type { Definition, DefinitionDeprecations } from "../types/index";

/**
 * Resolve the `@deprecated` reason for one generated field.
 *
 * Two places can name it: the central {@link Definition.deprecations} map and
 * the `deprecated` written on the field or exposed method itself. The map wins,
 * which is the same precedence `comments.fields[key] || fieldDef.description`
 * already uses for descriptions — a definition can deprecate something it did
 * not author the declaration for (a relationship, an inherited column) only
 * through the map, so the map has to be the one with the last word.
 *
 * An empty string is not a reason. GraphQL prints `@deprecated(reason: "")`
 * happily, which tells a client nothing while still marking the field, so it is
 * treated as "not deprecated" here rather than being passed on.
 */
export function deprecationFor(
  definition: Definition | undefined,
  group: keyof DefinitionDeprecations,
  key: string,
  declared?: string,
): string | undefined {
  const reason = (definition?.deprecations?.[group] || {})[key] || declared;
  return reason ? reason : undefined;
}

/**
 * The reason a model's *root* fields carry, from `definition.deprecated`.
 *
 * GraphQL has no way to deprecate an object type, so deprecating a model means
 * deprecating the fields that lead to it: its root query list field and its root
 * mutation field. Relationship fields pointing at the model are left alone —
 * they belong to the other model's definition, which names them in its own
 * `deprecations.fields` if it wants them marked.
 */
export function modelDeprecation(definition: Definition | undefined): string | undefined {
  const reason = definition?.deprecated;
  return reason ? reason : undefined;
}
