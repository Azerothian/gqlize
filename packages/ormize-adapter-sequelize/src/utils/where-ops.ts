

import {Op} from 'sequelize';
import type { AdapterWhere } from "@azerothian/utilize/types/index";

/**
 * A key/value map keyed by both string and symbol property names. Used here for
 * the reflected `Op` lookup table (string operator name -> its `Op` symbol) and
 * for the where-tree nodes `replaceKeyDeep` walks (which may already carry `Op`
 * symbol keys from an earlier pass).
 */
type PropertyKeyMap<V> = { [key: string | symbol]: V };

// `Op` is declared as a closed interface of `unique symbol` members — there is
// no index signature, because every member is meant to be reached by its own
// name. Reflect.ownKeys walks it dynamically instead (so a Sequelize version
// that adds an operator is picked up without a matching edit here), which is
// exactly the shape a closed interface cannot describe; the cast reflects that
// this loop, not the interface, is where the openness lives.
const ops: PropertyKeyMap<symbol> = Reflect.ownKeys(Op).reduce((acc: PropertyKeyMap<symbol>, k) => {
  const v = (Op as unknown as PropertyKeyMap<symbol>)[k];
  acc[k] = v;
  return acc;
}, {});

/**
 * String names reserved as Sequelize where-operators (e.g. `in`, `between`,
 * `match`, `and`). `replaceWhereOperators` rewrites any key matching one of
 * these into its `Op` symbol at every depth, so a model column literally named
 * one of them would have its filter silently reinterpreted as an operator.
 * Adapters use this to warn about such collisions at model-definition time.
 */
export const reservedOperatorNames: ReadonlySet<string> = new Set(
  Reflect.ownKeys(Op).filter((k) => typeof k === "string"),
);



/**
 * Replace a key deeply in an object
 * @param obj
 * @param keyMap
 * @returns {Object}
 */
function replaceKeyDeep(obj: PropertyKeyMap<unknown>, keyMap: PropertyKeyMap<symbol>): PropertyKeyMap<unknown> {
  return ([] as (string | symbol)[]).concat(Object.getOwnPropertySymbols(obj), Object.keys(obj)).reduce((memo: PropertyKeyMap<unknown>, key) => {

    // determine which key we are going to use
    const targetKey = keyMap[key] ? keyMap[key] : key;
    const value = obj[key];

    if (Array.isArray(value)) {
      // recurse if an array
      memo[targetKey] = value.map((val: unknown) => {
        if (Object.prototype.toString.call(val) === '[object Object]') {
          return replaceKeyDeep(val as PropertyKeyMap<unknown>, keyMap);
        }
        return val;
      });
    } else if (Object.prototype.toString.call(value) === '[object Object]') {
      // recurse if Object
      memo[targetKey] = replaceKeyDeep(value as PropertyKeyMap<unknown>, keyMap);
    } else {
      // assign the new value
      memo[targetKey] = value;
    }

    // return the modified object
    return memo;
  }, {});
}

/**
 * Replace the where arguments object and return the sequelize compatible version.
 * @param where arguments object in GraphQL Safe format meaning no leading "$" chars.
 * @returns {Object}
 */
export function replaceWhereOperators(where: AdapterWhere): AdapterWhere {
  return replaceKeyDeep(where, ops);
}