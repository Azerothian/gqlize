
  
import {Op} from 'sequelize';

const ops = Reflect.ownKeys(Op).reduce((ops, k) => {
  const v = (Op as any)[k];
  ops[k] = v;
  return ops;
}, {} as any);

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
function replaceKeyDeep(obj: any, keyMap: any) {
  return ([] as any[]).concat(Object.getOwnPropertySymbols(obj), Object.keys(obj)).reduce((memo, key)=> {

    // determine which key we are going to use
    const targetKey = keyMap[key] ? keyMap[key] : key;

    if (Array.isArray(obj[key])) {
      // recurse if an array
      memo[targetKey] = obj[key].map((val: any) => {
        if (Object.prototype.toString.call(val) === '[object Object]') {
          return replaceKeyDeep(val, keyMap);
        }
        return val;
      });
    } else if (Object.prototype.toString.call(obj[key]) === '[object Object]') {
      // recurse if Object
      memo[targetKey] = replaceKeyDeep(obj[key], keyMap);
    } else {
      // assign the new value
      memo[targetKey] = obj[key];
    }

    // return the modified object
    return memo;
  }, {} as any);
}

/**
 * Replace the where arguments object and return the sequelize compatible version.
 * @param where arguments object in GraphQL Safe format meaning no leading "$" chars.
 * @returns {Object}
 */
export function replaceWhereOperators(where: any) {
  return replaceKeyDeep(where, ops);
}