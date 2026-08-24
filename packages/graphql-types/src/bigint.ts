import { GraphQLScalarType, GraphQLError, Kind } from "graphql";


// @ts-ignore
BigInt.prototype.toJSON = function() { return this.toString(); }; //eslint-disable-line

export default new GraphQLScalarType({
  name: "GQLTBigInt",
  description: "BigInt",
  serialize(value) {
    return `${value}`;
  },

  parseValue(value) {
    // graphql hands coercion inputs over as `unknown`; `BigInt` throws on
    // anything it cannot convert, which is the error we want to surface.
    return BigInt(value as string | number | bigint | boolean); //eslint-disable-line
  },

  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(
        `Can only validate strings as big integers but got a: ${
          ast.kind
        }`,
      );
    }
    // Match parseValue: return a precise BigInt (the old parseFloat lost precision
    // and returned a different runtime type than the variable path).
    return BigInt(ast.value); //eslint-disable-line
  },
});
