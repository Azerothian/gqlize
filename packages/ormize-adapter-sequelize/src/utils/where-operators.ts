import waterfall from "@azerothian/utilize/utils/waterfall";
import {Op} from "sequelize";
import type { AdapterWhere, AdapterQueryOptions, WhereOperators } from "@azerothian/utilize/types/index";

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

function getProperties(obj: AdapterWhere): (string | symbol)[] {
  return [...Object.keys(obj), ...Object.getOwnPropertySymbols(obj)];
}

function hasUserPrototype(obj: unknown): boolean {
  if (!obj) {
    return false;
  }
  return Object.getPrototypeOf(obj) !== Object.prototype;
}

async function checkObjectForWhereOps(value: unknown, keyMap: WhereOperators, params: AdapterQueryOptions): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((val) => {
      return checkObjectForWhereOps(val, keyMap, params);
    }));
  } else if (hasUserPrototype(value)) {
    return value;
  } else if (Object.prototype.toString.call(value) === "[object Object]") {
    return replaceDefWhereOperators(value as AdapterWhere, keyMap, params);
  } else {
    return value;
  }
}

export async function replaceDefWhereOperators(obj: AdapterWhere, keyMap: WhereOperators, options: AdapterQueryOptions): Promise<AdapterWhere> {
  return waterfall(getProperties(obj), async(key: string | symbol, memo: AdapterWhere): Promise<AdapterWhere> => {
    const op = typeof key === "string" ? keyMap[key] : undefined;
    if (op) {
      const newWhereObj: AdapterWhere = await op(memo, options, obj[key]);
      delete memo[key];
      memo = getProperties(newWhereObj).reduce((m: AdapterWhere, newKey: string | symbol) => {
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
      memo = await checkObjectForWhereOps(memo, keyMap, options) as AdapterWhere;
    } else {
      memo[key] = await checkObjectForWhereOps(memo[key], keyMap, options);
    }
    // return the modified object
    return memo;

  }, Object.assign({}, obj));
}
