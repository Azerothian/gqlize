/**
 * Resolve an untrusted name to one of a known set, case-insensitively.
 *
 * This is a security control, not a convenience: the input is attacker-supplied
 * — a `:resource` URL segment in nestize, a model name in temporalize's workflow
 * input — and the whole job is that an unknown one comes back `undefined` so the
 * caller can refuse it.
 *
 * Two properties carry that, and both are easy to lose in a re-implementation,
 * which is why this exists once rather than twice:
 *
 *  - **The map has a null prototype.** A plain object would let `constructor`,
 *    `__proto__` or `hasOwnProperty` resolve to an inherited member instead of
 *    `undefined`, walking straight past the unknown-name check.
 *  - **A non-string fails closed.** `resolve` takes `unknown` deliberately. An
 *    object reaching a lookup that coerces it is the same class of bug one step
 *    later.
 */
export interface NameResolver {
  /** The matching known name, or `undefined` if there is none. */
  resolve(name: unknown): string | undefined;
  /** Every known name, in the order given. */
  names(): string[];
}

export function createNameResolver(knownNames: string[]): NameResolver {
  const map: { [key: string]: string } = Object.create(null);
  for (const name of knownNames) {
    map[name] = name;
    map[name.toLowerCase()] = name;
  }
  const ordered = [...knownNames];
  return {
    resolve(name: unknown): string | undefined {
      if (typeof name !== "string" || name === "") {
        return undefined;
      }
      return map[name] || map[name.toLowerCase()];
    },
    names(): string[] {
      return [...ordered];
    },
  };
}
