
import {
  GraphQLScalarType,
} from "graphql";

/**
 * A special custom Scalar type for Dates that converts to a ISO formatted string
 * @param {String} options.name:
 * @param {String} options.description:
 * @param {Date} options.serialize(d)
 * @param {String} parseValue(value)
 * @param {Object} parseLiteral(ast)
 */
export default new GraphQLScalarType({
  name: "GQLTDate",
  description: "A special custom Scalar type for Dates that converts to a ISO formatted string ",
  /**
   * serialize
   * @param  {Date} d Date obj
   * @return {String} Serialised date object
   */
  serialize(d) {
    if (!d) {
      return null;
    }

    if (d instanceof Date) {
      return d.toISOString();
    }
    return d;
  },
  /**
   * parseValue
   * @param  {String} value date string
   * @return {Date}   Date object
   */
  parseValue(value) {
    try {
      if (!value) {
        return null;
      }
      return new Date(value as string | number | Date);
    } catch (e) {
      return null;
    }
  },
  parseLiteral(ast) {
    // Kinds that carry no `value` — lists, objects, null — yield an Invalid
    // Date, which is what this did before the parameter was typed.
    const value = "value" in ast ? ast.value : undefined;
    return new Date(value as string);
  }
});
