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

import property from "./utils/property";


const astToJson = {
  [Kind.INT](ast: ValueNode) {
    return GraphQLInt.parseLiteral(ast);
  },
  [Kind.FLOAT](ast: ValueNode) {
    return GraphQLFloat.parseLiteral(ast);
  },
  [Kind.BOOLEAN](ast: ValueNode) {
    return GraphQLBoolean.parseLiteral(ast);
  },
  [Kind.STRING](ast: ValueNode) {
    return GraphQLString.parseLiteral(ast);
  },
  [Kind.ENUM](ast: { value: any; }) {
    return String(ast.value);
  },
  [Kind.LIST](ast: { values: any[]; }): any {
    return ast.values.map((astItem: ValueNode) => {
      return JSONType.parseLiteral(astItem);
    });
  },
  [Kind.OBJECT](ast: { fields: any[]; }) {
    let obj: any = {};
    ast.fields.forEach((field: { name: { value: any; }; value: ValueNode; }) => {
      obj[field.name.value] = JSONType.parseLiteral(field.value);
    });
    return obj;
  },
  [Kind.VARIABLE](ast: { name: { value: any; }; }) {
    /*
    this way converted query variables would be easily
    converted to actual values in the resolver.js by just
    passing the query variables object in to function below.
    We can`t convert them just in here because query variables
    are not accessible from GraphQLScalarType"s parseLiteral method
    */
    return property(ast.name.value);
  },
  [Kind.NULL](ast: { name: { value: any; }; }) {
    return null;
  }
};


const JSONType = new GraphQLScalarType({
  name: "GQLTJson",
  description: "The `JSON` scalar type represents raw JSON as values.",
  serialize: value => value,
  parseValue: value => typeof value === "string" ? JSON.parse(value) : value,
  parseLiteral: ast => {
    const parser = astToJson[ast.kind] as any;
    return parser ? parser.call(this, ast) : null;
  }
});


export default JSONType;
