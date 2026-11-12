import type { Definition, HookMap } from "../types/index";

type HookEntry = HookMap[string];
type HookFunction = Exclude<HookEntry, unknown[]>;

function asList(entry: HookEntry | undefined): HookFunction[] {
  if (!entry) {
    return [];
  }
  return Array.isArray(entry) ? entry : [entry];
}

/**
 * A definition's hooks, both spellings merged: top-level `hooks` and the
 * nested `options.hooks`.
 *
 * Both are documented, and reading one *or* the other — `def.hooks ||
 * def.options?.hooks` — dropped every nested hook whenever the top-level map
 * existed at all, even as `{}` (the #72 pattern). Hooks are side effects
 * rather than values, so a name both spellings declare runs both, top-level
 * first, instead of one silently replacing the other. A name declared once
 * keeps the shape it was authored in.
 */
export function definitionHooks(definition: Definition | undefined): HookMap {
  const top = definition?.hooks || {};
  const nested = definition?.options?.hooks || {};
  const out: HookMap = {};
  for (const name of new Set([...Object.keys(top), ...Object.keys(nested)])) {
    if (top[name] && nested[name]) {
      out[name] = [...asList(top[name]), ...asList(nested[name])];
    } else {
      out[name] = top[name] || nested[name];
    }
  }
  return out;
}
