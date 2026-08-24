const INFINITY = 1 / 0;
const toString = Object.prototype.toString;
const reIsDeepProp = /\.|\[(?:[^[\]]*|([""])(?:(?!\1)[^\\]|\\.)*?\1)\]/;
const reIsPlainProp = /^\w*$/;
const charCodeOfDot = ".".charCodeAt(0);
const reEscapeChar = /\\(\\)?/g;
const rePropName = RegExp(`[^.[\\]]+|\\[(?:([^"'].*)|(["'])((?:(?!\\2)[^\\\\]|\\\\.)*?)\\2)\\]|(?=(?:\\.|\\[\\])(?:\\.|\\[\\]|$))`, "g");
const MAX_MEMOIZE_SIZE = 500;

/** One segment of a property path. Named to avoid the global `PropertyKey`. */
type PathKey = string | number | symbol;

/** A dotted/bracketed path string, a single key, or an already-split key list. */
export type PropertyPath = PathKey | readonly PathKey[];


/** `...args: any[]` on the pass-through: a memoizer cannot constrain what it wraps. */
function memoize(func: (...args: any[]) => any, resolver: ((...args: any[]) => unknown) | null) {
  if (typeof func !== "function" || (resolver !== null && typeof resolver !== "function")) {
    throw new TypeError("Expected a function");
  }
  const memoized = function(this: any, ...args: any[]) {
    const key = resolver ? resolver.apply(this, args) : args[0];
    const cache = memoized.cache;

    if (cache.has(key)) {
      return cache.get(key);
    }
    const result = func.apply(this, args);
    memoized.cache = cache.set(key, result) || cache;
    return result;
  };
  memoized.cache = new (memoize.Cache || Map)();
  return memoized;
}
memoize.Cache = Map;

function memoizeCapped(func: (value: string) => string[]) {
  const result = memoize(func, (key: unknown) => {
    const { cache } = result;
    if (cache.size === MAX_MEMOIZE_SIZE) {
      cache.clear();
    }
    return key;
  });

  return result;
}


const stringToPath = memoizeCapped((string: string) => {
  const result: string[] = [];
  if (string.charCodeAt(0) === charCodeOfDot) {
    result.push("");
  }
  string.replace(rePropName, (match: string, expression: string, quote: string, subString: string) => {
    let key = match;
    if (quote) {
      key = subString.replace(reEscapeChar, "$1");
    }
    else if (expression) {
      key = expression.trim();
    }
    result.push(key);
    // `replace` is used here only for its callback; the returned string is
    // discarded, so handing back the match leaves the input untouched.
    return match;
  });
  return result;
});

function baseGetTag(value: unknown) {
  if (value === null) {
    return value === undefined ? "[object Undefined]" : "[object Null]";
  }
  return toString.call(value);
}
function isSymbol(value: unknown): value is symbol {
  const type = typeof value;
  return type === "symbol" || (type === "object" && value !== null && baseGetTag(value) === "[object Symbol]");
}

function toKey(value: unknown): PathKey {
  if (typeof value === "string" || isSymbol(value)) {
    return value;
  }
  const result = `${value}`;
  return (result === "0" && (1 / (value as number)) === -INFINITY) ? "-0" : result;
}
function baseProperty(key: PathKey) {
  return (object: unknown) => object === null || object === undefined
    ? undefined
    : (object as Record<PathKey, unknown>)[key];
}

function castPath(value: PropertyPath, object: unknown): readonly PathKey[] {
  if (Array.isArray(value)) {
    return value;
  }
  return isKey(value, object) ? [value as PathKey] : stringToPath(value as string);
}

function baseGet(object: unknown, path: PropertyPath) {
  const keys = castPath(path, object);

  let index = 0;
  const length = keys.length;

  while (object !== null && object !== undefined && index < length) {
    object = (object as Record<PathKey, unknown>)[toKey(keys[index++])];
  }
  return (index && index === length) ? object : undefined;
}

function basePropertyDeep(path: PropertyPath) {
  return (object: unknown) => baseGet(object, path);
}

function isKey(value: unknown, object?: unknown) {
  if (Array.isArray(value)) {
    return false;
  }
  const type = typeof value;
  if (type === "number" || type === "boolean" || value === null || isSymbol(value)) {
    return true;
  }
  return reIsPlainProp.test(value as string) || !reIsDeepProp.test(value as string) ||
    (object !== null && (value as PathKey) in Object(object));
}

/**
 * Lodash's `_.property`, ported. Returns a getter that reads `path` off whatever
 * it is handed — hence `unknown` in and out: the path is a runtime string, so no
 * static type can say what comes back.
 */
export default function property(path: PropertyPath): (object: unknown) => unknown {
  return isKey(path) ? baseProperty(toKey(path)) : basePropertyDeep(path);
}
