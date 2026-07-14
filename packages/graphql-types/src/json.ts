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
} from "graphql";


const astToJson: { [kind: string]: (ast: any, variables?: any) => any } = {
  [Kind.INT](ast: ValueNode, variables?: any) {
    return GraphQLInt.parseLiteral(ast, variables);
  },
  [Kind.FLOAT](ast: ValueNode, variables?: any) {
    return GraphQLFloat.parseLiteral(ast, variables);
  },
  [Kind.BOOLEAN](ast: ValueNode, variables?: any) {
    return GraphQLBoolean.parseLiteral(ast, variables);
  },
  [Kind.STRING](ast: ValueNode, variables?: any) {
    return GraphQLString.parseLiteral(ast, variables);
  },
  [Kind.ENUM](ast: { value: any; }) {
    return String(ast.value);
  },
  [Kind.LIST](ast: { values: any[]; }, variables?: any): any {
    return ast.values.map((astItem: ValueNode) => {
      return JSONType.parseLiteral(astItem, variables);
    });
  },
  [Kind.OBJECT](ast: { fields: any[]; }, variables?: any) {
    let obj: any = {};
    ast.fields.forEach((field: { name: { value: any; }; value: ValueNode; }) => {
      obj[field.name.value] = JSONType.parseLiteral(field.value, variables);
    });
    return obj;
  },
  [Kind.VARIABLE](ast: { name: { value: any; }; }, variables?: any) {
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
