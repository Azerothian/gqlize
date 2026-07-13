import { GraphQLScalarType, GraphQLError, Kind, StringValueNode } from "graphql";


// @ts-ignore
BigInt.prototype.toJSON = function() { return this.toString(); }; //eslint-disable-line

function isNumber(value: any) {
  return (value === null ||
    typeof value === "undefined" ||
    isNaN(value) ||
    Number.isNaN(value) ||
    value === Number.NaN);
}

function processValue(value: any) {
  if (!isNumber(value)) {
    throw new TypeError(`Value is not a number: ${value}`);
  }
  return parseFloat(value);
}

export default new GraphQLScalarType({
  name: "GQLTBigInt",
  description: "BigInt",
  serialize(value: any) {
    return `${value}`;
  },

  parseValue(value: any) {
    return BigInt(value); //eslint-disable-line
  },

  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(
        `Can only validate strings as big integers but got a: ${
          ast.kind
        }`,
      );
    }
    return processValue(ast.value) as any;
  },
});
