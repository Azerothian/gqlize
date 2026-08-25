import { GraphQLScalarType, GraphQLError, Kind } from "graphql";


// @ts-ignore
BigInt.prototype.toJSON = function() { return this.toString(); };

export default new GraphQLScalarType({
  name: "GQLTBigInt",
  description: "BigInt",
  serialize(value) {
    // Mirror `parseValue`'s accepted runtime shapes. These stringify to
    // something meaningful directly, so take them without a round-trip.
    if (
      typeof value === "bigint" ||
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return `${value}`;
    }
    // Anything else is only acceptable if it *carries* a big integer. Driver
    // wrappers do — mysql's `Long`, a `BigNumber`, a `Buffer` of digits all
    // define `toString`/`valueOf` and round-trip cleanly — so the test is the
    // same one `parseValue` applies rather than a blanket "not a primitive"
    // rejection, which would break those callers. A plain object fails it and
    // would otherwise have serialized as the useless "[object Object]", which
    // is the failure this scalar exists to avoid.
    try {
      return BigInt(value as string).toString();
    } catch {
      throw new GraphQLError(`BigInt cannot represent value: ${typeof value}`);
    }
  },

  parseValue(value) {
    // graphql hands coercion inputs over as `unknown`; `BigInt` throws on
    // anything it cannot convert, which is the error we want to surface.
    return BigInt(value as string | number | bigint | boolean);
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
    return BigInt(ast.value);
  },
});
