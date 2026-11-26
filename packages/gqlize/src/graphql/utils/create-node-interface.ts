/*

The MIT License (MIT)

Copyright (c) 2015 Mick Hansen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import {
  nodeDefinitions,
} from "graphql-relay";

import NodeTypeMapper from "./node-type-mapper";
import idFetcher from "./id-fetcher";
import typeResolver from "./type-resolver";
import type GQLManager from "../../manager";
import type { GqlizeOptions } from "../../types";

export default function createNodeInterface(dbInstance: GQLManager, options?: GqlizeOptions) {
  const nodeTypeMapper = new NodeTypeMapper();
  const fetcher = idFetcher(dbInstance, nodeTypeMapper, options);
  const nodeObjects = nodeDefinitions(
    // graphql-relay's nodeDefinitions calls `idFetcher(id, context, info)`.
    // We wrap it so the `deleted` field argument is extracted from the
    // resolver args and forwarded (RFC §5.4).
    (id, context, info) => {
      // The node field's arguments are on info.fieldNodes[0]; extract `deleted`
      // from the resolved argument values. graphql-relay resolves `id` for us
      // but not any args we added. Walk variableValues + literal args.
      let deleted: string | undefined;
      const fieldNode = info.fieldNodes?.[0];
      if (fieldNode?.arguments) {
        const arg = fieldNode.arguments.find((a) => a.name.value === "deleted");
        if (arg) {
          if (arg.value.kind === "EnumValue") {
            deleted = arg.value.value;
          } else if (arg.value.kind === "Variable") {
            deleted = (info.variableValues as unknown as Record<string, unknown> | undefined)?.[arg.value.name.value] as string | undefined;
          }
        }
      }
      return fetcher(String(id), context, info, deleted);
    },
    typeResolver(nodeTypeMapper)
  );

  return {
    nodeTypeMapper,
    ...nodeObjects,
  };
}
