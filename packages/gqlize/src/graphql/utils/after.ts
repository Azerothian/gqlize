import type { GraphQLResolveInfo } from "graphql";
import Events from "../../events";
import type { AdapterRow, Definition, RequestContext } from "../../types";

export async function processAfter(
  node: AdapterRow,
  args: unknown,
  context: RequestContext,
  info: GraphQLResolveInfo,
  definition: Definition,
  e: Events,
) {
  let n = node;
  if (definition.after) {
    n = await definition.after({
      result: node, args, context, info, modelDefinition: definition,
      type: e || Events.OUTPUT,
    })
  }
  // A hook returns `{override}` to replace the value wholesale rather than to
  // hand back a reshaped row; a row is whatever the adapter returns, so reading
  // the key is a widening rather than a narrowing.
  const override = (n as {override?: AdapterRow} | null | undefined)?.override;
  if (override) {
    n = override;
  }
  return n;
}
