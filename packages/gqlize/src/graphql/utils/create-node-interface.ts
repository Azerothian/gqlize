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
    (id, context, info) => fetcher(String(id), context, info),
    typeResolver(nodeTypeMapper)
  );
  // graphql-relay's `node` resolver hands the fetcher only `id`, so the
  // `deleted` argument (RFC §5.4, added in `graphql/index.ts` when a model
  // qualifies) is read here from the resolver's own coerced `args`. That covers
  // a literal and a variable alike; reading the AST by hand did not, because
  // graphql 17's `info.variableValues` is no longer a plain name → value map.
  // `plural` (`nodes`) is untouched and has no `deleted`.
  const nodeField: typeof nodeObjects.nodeField = {
    ...nodeObjects.nodeField,
    resolve: (_obj, args: { id: string; deleted?: string }, context, info) =>
      fetcher(String(args.id), context, info, args.deleted),
  };

  return {
    nodeTypeMapper,
    ...nodeObjects,
    nodeField,
  };
}
