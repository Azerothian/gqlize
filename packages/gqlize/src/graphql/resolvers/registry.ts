import type { GraphQLFieldResolver } from "graphql";
import type { AdapterRow, RequestContext } from "../../types";
import { buildConnectionResolver } from "./connection";
import { buildSingleRelationshipResolver } from "./relationship";
import {
  buildGlobalIdResolver,
  buildModelFieldResolver,
  buildOverrideOutputResolver,
} from "./model-field";
import { buildClassMethodResolver, buildInstanceMethodResolver } from "./methods";
import { buildMutationModelResolver } from "./mutation";
import { buildContainerResolver } from "./misc";
import type { BindingContext, FieldBinding } from "./types";

/**
 * The one place a gqlize resolver is constructed. Both `createSchemaObjects`
 * (live build) and the snapshot materializer come through here, so there is no
 * second implementation for a serialized schema to drift away from.
 *
 * Returns undefined for bindings whose resolver is not gqlize's to build:
 * `nodeField` is rebuilt live by `createNodeInterface`, and `extend` fields
 * carry the user's own config verbatim.
 */
export function buildResolver(
  binding: FieldBinding,
  ctx: BindingContext,
): GraphQLFieldResolver<AdapterRow, RequestContext> | undefined {
  switch (binding.kind) {
    case "connection":
      return buildConnectionResolver(binding, ctx);
    case "singleRelationship":
      return buildSingleRelationshipResolver(binding, ctx);
    case "globalId":
      return buildGlobalIdResolver(binding, ctx);
    case "modelField":
      return buildModelFieldResolver(binding, ctx);
    case "overrideOutput":
      return buildOverrideOutputResolver(binding, ctx);
    case "instanceMethod":
      return buildInstanceMethodResolver(binding, ctx);
    case "classMethod":
      return buildClassMethodResolver(binding, ctx);
    case "mutationModel":
      return buildMutationModelResolver(binding, ctx);
    case "container":
      return buildContainerResolver();
    case "nodeField":
    case "extend":
      return undefined;
    default:
      throw new Error(
        `gqlize: unknown field binding kind "${(binding as {kind: string}).kind}"`,
      );
  }
}
