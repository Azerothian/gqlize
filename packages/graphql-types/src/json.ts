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
  GraphQLScalarType,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLString,
  Kind,
  ValueNode,
  EnumValueNode,
  ListValueNode,
  ObjectValueNode,
  VariableNode,
} from "graphql";


/** What graphql passes as `parseLiteral`'s second argument. */
type VariableValues = { readonly [name: string]: unknown } | null | undefined;

/**
 * The map's `ast` parameter stays `any` on purpose: dispatch is by `ast.kind` at
 * runtime, so no single node type describes every entry. Each handler names the
 * node it actually accepts, which is where the checking that matters happens.
 */
const astToJson: { [kind: string]: (ast: any, variables?: VariableValues) => unknown } = {
  [Kind.INT](ast: ValueNode, variables?: VariableValues) {
    return GraphQLInt.parseLiteral(ast, variables);
  },
  [Kind.FLOAT](ast: ValueNode, variables?: VariableValues) {
    return GraphQLFloat.parseLiteral(ast, variables);
  },
  [Kind.BOOLEAN](ast: ValueNode, variables?: VariableValues) {
    return GraphQLBoolean.parseLiteral(ast, variables);
  },
  [Kind.STRING](ast: ValueNode, variables?: VariableValues) {
    return GraphQLString.parseLiteral(ast, variables);
  },
  [Kind.ENUM](ast: EnumValueNode) {
    return String(ast.value);
  },
  [Kind.LIST](ast: ListValueNode, variables?: VariableValues): unknown[] {
    return ast.values.map((astItem) => {
      return JSONType.parseLiteral(astItem, variables);
    });
  },
  [Kind.OBJECT](ast: ObjectValueNode, variables?: VariableValues) {
    const obj: { [name: string]: unknown } = {};
    ast.fields.forEach((field) => {
      obj[field.name.value] = JSONType.parseLiteral(field.value, variables);
    });
    return obj;
  },
  [Kind.VARIABLE](ast: VariableNode, variables?: VariableValues) {
    // graphql-js passes the query variables as parseLiteral's second argument,
    // so a variable nested inside a JSON literal is resolved to its value here.
    return variables ? variables[ast.name.value] : undefined;
  },
  [Kind.NULL]() {
    return null;
  }
};


const JSONType = new GraphQLScalarType({
  name: "GQLTJson",
  description: "The `JSON` scalar type represents raw JSON as values.",
  serialize: value => value,
  parseValue: value => typeof value === "string" ? JSON.parse(value) : value,
  parseLiteral: (ast, variables) => {
    const parser = astToJson[ast.kind];
    return parser ? parser(ast, variables) : null;
  }
});


export default JSONType;
