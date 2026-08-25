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

import type { GraphQLTypeResolver } from "graphql";
import NodeTypeMapper from "./node-type-mapper";
import type { AdapterRow, RequestContext } from "../../types";

// https://github.com/mickhansen/graphql-sequelize/blob/master/src/relay.js

/**
 * The four places a row can carry the name of the type it belongs to, in the
 * order `node(id:)` reads them. `__graphqlType__` is the one gqlize stamps
 * itself; the other three are the shapes graphql-sequelize supported, and every
 * one of them is optional on any given row.
 */
type TypeCarrier = {
  __graphqlType__?: string;
  Model?: { options: { name: { singular: string } } };
  _modelOptions?: { name: { singular: string } };
  name?: string;
};

export default function typeResolver(
  nodeTypeMapper: NodeTypeMapper,
): GraphQLTypeResolver<AdapterRow, RequestContext> {
  return (obj, context, info) => {
    const carrier = (obj ?? {}) as TypeCarrier;
    const type =
      carrier.__graphqlType__ ||
      (carrier.Model
        ? carrier.Model.options.name.singular
        : carrier._modelOptions
        ? carrier._modelOptions.name.singular
        : carrier.name);

    if (!type) {
      throw new Error(
        `Unable to determine type of ${typeof obj}. ` +
          `Either specify a resolve function in 'NodeTypeMapper' object, or specify '__graphqlType__' property on object.`
      );
    }

    const nodeType = nodeTypeMapper.item(type);
    if (nodeType) {
      const resolved = typeof nodeType.type === "string"
        ? info.schema.getType(nodeType.type)
        : nodeType.type;
      // `name` only exists on a named type; a list or non-null wrapper cannot be
      // a `node` result, and neither can a name the schema does not know.
      return (resolved as {name?: string} | null | undefined)?.name;
    }

    return undefined;
  };
}
