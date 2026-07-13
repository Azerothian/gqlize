
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
  parseValue(value: any) {
    try {
      if (!value) {
        return null;
      }
      return new Date(value);
    } catch (e) {
      return null;
    }
  },
  parseLiteral(ast: any) {
    return new Date(ast.value);
  }
});
