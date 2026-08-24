import waterfall from "@azerothian/utilize/utils/waterfall";
import {Op} from "sequelize";

/**
 * Apply a definition's author-supplied `whereOperators` to a where tree.
 *
 * Each key in `keyMap` is a custom operator whose handler returns a replacement
 * where-fragment; the fragment is merged back in place, ANDing rather than
 * overwriting when the target key is already present. Split out of
 * `replace-id-deep.ts` when global-id decoding moved to the shared
 * `@azerothian/gqlize/utils/replace-id-deep` — this half is Sequelize-specific
 * (it merges through `Op.and`) and stays here.
 */

function getProperties(obj: any): any {
  return [...Object.keys(obj), ...Object.getOwnPropertySymbols(obj)];
}

function hasUserPrototype(obj: any) {
  if (!obj) {
    return false;
  }
  return Object.getPrototypeOf(obj) !== Object.prototype;
}

async function checkObjectForWhereOps(value: any[], keyMap: any, params: any): Promise<any> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((val) => {
      return checkObjectForWhereOps(val, keyMap, params);
    }));
  } else if (hasUserPrototype(value)) {
    return value;
  } else if (Object.prototype.toString.call(value) === "[object Object]") {
    return replaceDefWhereOperators(value, keyMap, params);
  } else {
    return value;
  }
}

export async function replaceDefWhereOperators(obj: any, keyMap: any, options: any) {
  return waterfall(getProperties(obj), async(key, memo) => {
    if (keyMap[key]) {
      const newWhereObj = await keyMap[key](memo, options, obj[key]);
      delete memo[key];
      memo = getProperties(newWhereObj).reduce((m: any, newKey: any) => {
        if (m[newKey]) {
          const newValue = {
            [newKey]: newWhereObj[newKey],
          };
          if (Array.isArray(m[newKey])) {
            m[newKey] = m[newKey].concat(newValue);
          } else if (m[Op.and]) {
            m[Op.and] = m[Op.and].concat(newValue);
          } else if (m.and) { //Cover both before and after replaceWhereOps
            m.and = m.and.concat(newValue);
          } else {
            const prevValue = {
              [newKey]: m[newKey],
            };
            m[Op.and] = [prevValue, newValue];
          }
        } else {
          m[newKey] = newWhereObj[newKey];
        }
        return m;
      }, memo);
      memo = await checkObjectForWhereOps(memo, keyMap, options);
    } else {
      memo[key] = await checkObjectForWhereOps(memo[key], keyMap, options);
    }
    // return the modified object
    return memo;

  }, Object.assign({}, obj));
}
