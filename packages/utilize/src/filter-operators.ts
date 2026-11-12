// The filter operators a graphql-free front end (nestize, temporalize, CSV
// match columns) may hand an adapter: an allow-list for `assertFilterAllowed`.
//
// It has to be an allow-list. The sequelize adapter turns *any* key that names
// a Sequelize `Op` into that operator, at any depth, so a filter key passed
// through unchecked reaches ORM internals: `{name: {col: "secret"}}` becomes
// `name = secret`, a comparison against a column the caller may not read.
//
// These are the same names gqlize's filter types offer, from graphql-types'
// `operators.ts` (`CORE_VALUE_FUNCS`, `REGEX_VALUE_FUNCS`, `SQL_ARRAY_VALUES`).
// utilize cannot import that package, so the lists are restated and a gqlize
// test pins the two together.

/** Operators taking one value of the field's type. Every backend has these. */
export const FILTER_VALUE_OPERATORS: readonly string[] = [
  "eq", "ne", "gt", "gte", "lte", "lt", "not", "is",
  "like", "notLike", "iLike", "notILike", "startsWith", "endsWith", "substring",
];

/**
 * Pattern operators. Only allowed where the adapter offers them
 * (`enableRegexpOperators` on the sequelize adapter): a client-supplied pattern
 * evaluated by the database can be a ReDoS.
 */
export const FILTER_REGEX_OPERATORS: readonly string[] = ["regexp", "notRegexp", "iRegexp", "notIRegexp"];

/** Operators taking a list of values of the field's type. */
export const FILTER_LIST_OPERATORS: readonly string[] = [
  "in", "notIn", "contains", "contained", "between", "notBetween",
  "overlap", "adjacent", "strictLeft", "strictRight", "noExtendRight", "noExtendLeft",
];

/**
 * Whether a model's adapter offers the regex operators. Read off the adapter's
 * own options, because that is where the sequelize adapter keeps the switch the
 * GraphQL filter types are built from; an adapter without the option offers
 * none.
 */
export function regexOperatorsEnabled(adapter: unknown): boolean {
  return (adapter as { options?: { enableRegexpOperators?: unknown } } | undefined)?.options?.enableRegexpOperators === true;
}
