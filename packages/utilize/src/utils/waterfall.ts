/**
 * Run `func` over `arr` one element at a time, threading each call's result into
 * the next as `prevVal` and resolving to the last one.
 *
 * `TItem` is the element type; `TAcc` is whatever the step returns, which is
 * also what the whole call resolves to. Neither usually needs writing out — both
 * infer from the arguments.
 *
 * Most callers use this purely as "do these in sequence" and pass a one-argument
 * step and no seed. That still works: a one-argument function is assignable to
 * the two-argument parameter, `TAcc` lands on `void`, and the result is a
 * `Promise<void>` nobody has to look at.
 *
 * `arr` accepts a bare value as well as an array and wraps it, because several
 * callers hand through a value-or-list they have not normalised.
 */
export default function waterfall<TItem, TAcc>(
  arr: TItem[] | TItem = [],
  func: (val: TItem, prevVal: TAcc) => TAcc | Promise<TAcc> = ((_val, prevVal) => prevVal),
  start?: TAcc,
): Promise<TAcc> {
  const items = Array.isArray(arr) ? arr : [arr];
  return items.reduce(
    (promise: Promise<TAcc>, val: TItem) => promise.then((prevVal) => func(val, prevVal)),
    // `undefined` is the seed when the caller gives none, which is what `TAcc`
    // infers to for the no-accumulator callers.
    Promise.resolve(start as TAcc),
  );
}

/** The synchronous {@link waterfall}: same threading, same inference, no promises. */
export function waterfallSync<TItem, TAcc>(
  arr: TItem[] | TItem = [],
  func: (val: TItem, prevVal: TAcc) => TAcc = ((_val, prevVal) => prevVal),
  start?: TAcc,
): TAcc {
  const items = Array.isArray(arr) ? arr : [arr];
  return items.reduce((prevVal, val) => func(val, prevVal), start as TAcc);
}
