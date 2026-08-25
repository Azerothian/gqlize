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

// https://github.com/mickhansen/graphql-sequelize/blob/master/src/relay.js

import type { GraphQLResolveInfo, GraphQLType } from "graphql";
import type { RequestContext } from "../../types";

/**
 * What `node(id:)` resolves a type name to: the type itself, or its name for the
 * artifact path that has not built it yet, plus the optional custom fetcher a
 * caller can register in place of the default global-id lookup.
 */
export type NodeTypeEntry = {
  type: GraphQLType | string;
  resolve?: (globalId: string, context: RequestContext, info: GraphQLResolveInfo) => unknown;
};

export default class NodeTypeMapper {
  map: {[key: string]: NodeTypeEntry}
  constructor() {
    this.map = { };
  }

  /**
   * `undefined` is in the parameter type because the artifact path's type map
   * carries it — not because a hole is acceptable. Its callers throw on one
   * first, and reading `.type` off it here is the documented second line of
   * defence.
   */
  mapTypes(types: {[key: string]: NodeTypeEntry | GraphQLType | undefined}) {
    Object.keys(types).forEach((k) => {
      const v = types[k];
      // A bare type is wrapped, an entry that already carries one is kept. The
      // truthiness test rather than an `in` check is the original behaviour, and
      // an entry whose `type` is undefined is not one worth keeping.
      this.map[k] = (v as Partial<NodeTypeEntry>).type
        ? v as NodeTypeEntry
        : {type: v as GraphQLType};
    });
  }

  item(type: string) {
    return this.map[type];
  }
}
