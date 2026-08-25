import { buildResolver } from "./registry";
import { GQLIZE_EXT, type BindingContext, type FieldBinding } from "./types";

/**
 * The single attachment point for every gqlize resolver.
 *
 * Builds the resolver from `binding` and stamps the descriptor onto the field's
 * `extensions`, so a schema can always be asked what each of its resolvers was
 * built from. The snapshotter refuses to serialize a field that has a `resolve`
 * but no descriptor — which is what keeps a newly added resolver from silently
 * vanishing out of a materialized schema.
 */
export function bindField<T extends object>(
  config: T,
  binding: FieldBinding,
  ctx: BindingContext,
): T {
  const resolve = buildResolver(binding, ctx);
  return {
    ...config,
    ...(resolve ? { resolve } : {}),
    extensions: {
      ...((config as {extensions?: object}).extensions),
      [GQLIZE_EXT]: binding,
    },
  };
}

/**
 * Reads back a descriptor stamped by `bindField`.
 *
 * The parameter is the structural minimum rather than `GraphQLField` so both a
 * built field and a still-unbuilt `GraphQLFieldConfig` can be passed; graphql's
 * own `GraphQLFieldExtensions` carries an index signature, so both satisfy it
 * without a cast at the call site.
 */
export function readBinding(
  field: { extensions?: Readonly<Record<string, unknown>> | null } | null | undefined,
): FieldBinding | undefined {
  return field?.extensions?.[GQLIZE_EXT] as FieldBinding | undefined;
}
