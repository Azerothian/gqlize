/**
 * Run `func` over `arr` one element at a time, threading each call's result into
 * the next as `prevVal` and resolving to the last one.
 *
 * The signature is `any` on purpose, and it is worth saying why rather than
 * leaving it to look like an oversight. A generic form —
 * `waterfall<TValue, TResult>(arr: TValue[], func: (val: TValue, prevVal:
 * TResult) => TResult | Promise<TResult>, start?: TResult): Promise<TResult>` —
 * type-checks here but changes inference at the call sites that already exist,
 * in both directions:
 *
 *  - `TResult` is inferred from the accumulator parameter the caller *declared*,
 *    so it becomes the function's return type. `createClassMethodFields` annotates
 *    that parameter as a partial field map and returns the finished fields, so the
 *    result stops having `resolve` on it.
 *  - `TValue` is inferred from the array argument. Where that argument is `any`
 *    (`replaceDefWhereOperators`) the element lands as `unknown` and can no longer
 *    index anything; where it is a real array of definitions
 *    (the sequelize adapter's relationship setup) the element gains the
 *    definition's optional `name`, which then fails a `string` parameter.
 *
 * All three are in other packages. Typing this properly means fixing those call
 * sites too — a cross-package change, not a local one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the docblock above: `arr`, the step function and the seed are the caller's, and a generic signature breaks three existing call sites in other packages.
export default function waterfall(arr: any [] = [], func = ((val: any, prevVal: any): any => {}), start?: any) {
  if (!Array.isArray(arr)) {
    arr = [arr];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the accumulator is whatever the caller's `func` returns; the enclosing signature is `any` for the reason above, and this is the same value.
  return arr.reduce(function(promise: Promise<any>, val: any) {
    return promise.then(function(prevVal) {
      return func(val, prevVal);
    });
  }, Promise.resolve(start));
}

/** The synchronous {@link waterfall}: same threading, no promises. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as {@link waterfall} above — the sync form shares its callers and its constraints.
export function waterfallSync(arr: any[] = [], func = ((val: any, prevVal: any): any => {}), start?: any) {
  if (!Array.isArray(arr)) {
    arr = [arr];
  }
  return arr.reduce(function(prevVal, val) {
    return func(val, prevVal);
  }, start);
}
