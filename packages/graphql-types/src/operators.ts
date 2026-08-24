/**
 * The `where` operator vocabulary, as named groups.
 *
 * Every adapter that builds a filter input feeds `QueryTypeConfig` one of these
 * lists. They were written out inline in each adapter, which meant a new
 * operator had to be added in two places to be reachable from both.
 *
 * **Order is part of the contract.** These arrays become GraphQL input fields in
 * iteration order, so the printed SDL — and the golden snapshots that pin it —
 * changes if they are reordered. The SQL lists below are therefore spelled out
 * in full rather than composed from the core lists: their extra operators are
 * interleaved with the core ones, not appended.
 */

/** Operators taking a single value of the field's own type. Every backend has these. */
export const CORE_VALUE_FUNCS = [
  "eq",
  "ne",
  "gte",
  "lte",
  "lt",
  "not",
  "is",
  "like",
  "notLike",
  "iLike",
  "notILike",
  "startsWith",
  "endsWith",
  "substring",
] as const;

/**
 * Pattern-matching operators, opt-in only. On dialects that evaluate
 * client-supplied patterns (e.g. Postgres `~`/`~*`), a catastrophic-backtracking
 * pattern is a ReDoS vector, so an adapter must ask for these explicitly.
 */
export const REGEX_VALUE_FUNCS = [
  "regexp",
  "notRegexp",
  "iRegexp",
  "notIRegexp",
] as const;

/** Boolean combinators taking a list of whole `where` objects. */
export const CORE_ARRAY_FUNCS = ["or", "and"] as const;

/** SQL adds the quantified forms, which a key-value store has no analogue for. */
export const SQL_ARRAY_FUNCS = ["or", "and", "any", "all"] as const;

/** Operators taking a list of the field's own type. */
export const CORE_ARRAY_VALUES = ["in", "notIn", "between", "notBetween"] as const;

/**
 * The SQL set: the core four plus Postgres' array and range operators, in the
 * order the SDL has always had them (`contains`/`contained` sit between `notIn`
 * and `between`), so this cannot be composed from `CORE_ARRAY_VALUES`.
 */
export const SQL_ARRAY_VALUES = [
  "in",
  "notIn",
  "contains",
  "contained",
  "between",
  "notBetween",
  "overlap",
  "adjacent",
  "strictLeft",
  "strictRight",
  "noExtendRight",
  "noExtendLeft",
] as const;
