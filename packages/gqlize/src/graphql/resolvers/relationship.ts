import type { GraphQLResolveInfo } from "graphql";
import { processAfter } from "../utils/after";
import Events from "../../events";
import type { AdapterRow, FindAllArgs, RequestContext } from "../../types";
import type { BindingContext, FieldBinding } from "./types";

export function buildSingleRelationshipResolver(
  binding: Extract<FieldBinding, { kind: "singleRelationship" }>,
  ctx: BindingContext,
) {
  const { instance } = ctx;
  // NOTE: `processAfter` deliberately runs against the *parent* definition here,
  // not the target's — matching the original inline resolver. `create-list-object`
  // uses the target definition instead. Preserved as-is; changing it is a
  // behaviour change for user `after` hooks.
  const definition = instance.getDefinition(binding.defName);
  const associations = instance.getAssociations(binding.defName);
  const association = associations?.[binding.relName];
  if (!association) {
    throw new Error(
      `gqlize: relationship "${binding.relName}" not found on "${binding.defName}"`,
    );
  }
  const targetDef = instance.getDefinition(binding.targetDefName);

  return async function resolve(source: AdapterRow, args: FindAllArgs, context: RequestContext, info: GraphQLResolveInfo) {
    const node = await instance.resolveSingleRelationship(
      targetDef?.name || "",
      association,
      source,
      args,
      context,
      info,
    );

    return processAfter(node, args, context, info, definition, Events.QUERY);
  };
}
