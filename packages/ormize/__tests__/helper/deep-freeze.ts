/**
 * Recursively freeze a config tree, so any write to it throws instead of
 * silently succeeding.
 *
 * A test helper, deliberately not shipped in `utilize`: freezing is itself a
 * change to the caller's object (observable through `Object.isFrozen`), and it
 * would break a caller who legitimately assembles a definition incrementally.
 * Here it is exactly what we want — the test sources compile to strict mode, so
 * a polluting write throws a `TypeError` naming the property, which beats a
 * structural diff for locating the culprit.
 *
 * Skips functions and class instances for the same reason `copyDefinition` does
 * not copy them: freezing a Sequelize `DataType` or a `GraphQLObjectType` would
 * break the object rather than protect it.
 */
export default function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    // A class instance — a Sequelize type, a GraphQL type. Not ours to freeze.
    return value;
  }
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}
