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
export function bindField<T extends Record<string, any>>(
  config: T,
  binding: FieldBinding,
  ctx: BindingContext,
): T {
  const resolve = buildResolver(binding, ctx);
  return {
    ...config,
    ...(resolve ? { resolve } : {}),
    extensions: {
      ...(config.extensions as any),
      [GQLIZE_EXT]: binding,
    },
  };
}

/** Reads back a descriptor stamped by `bindField`. */
export function readBinding(field: { extensions?: any }): FieldBinding | undefined {
  return field?.extensions?.[GQLIZE_EXT];
}
