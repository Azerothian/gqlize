import deepmerge from "deepmerge";

import type { Permission } from "./gate";

/** A leaf decision in a rules tree. Anything else is "no opinion". */
export type RuleDecision = "allow" | "deny";

/**
 * One node of a rules tree: a blanket decision, or a map one level deeper. The
 * depth that carries meaning varies by gate — one-arg gates read
 * `{[name]: decision}`, two-arg gates read `{[model]: {[name]: decision}}` —
 * so the node is recursive rather than depth-indexed.
 */
export type RuleNode = RuleDecision | { [key: string]: RuleNode };

/** One role's rules: a node per gate key (see `KNOWN_RULE_KEYS`). */
export type RoleRuleTree = { [gate: string]: RuleNode };

/**
 * The tree handed to `createRoleBasedPermissions`, keyed by role.
 *
 * A role's value is normally a {@link RoleRuleTree}, but a bare `"deny"` is an
 * accepted (and documented) shorthand for "this role gets nothing" — see
 * `docs/guide.md`. It carries no gate keys, so under the default `defaultDeny`
 * every gate denies. Note the corollary: a bare `"allow"` does **not** grant
 * anything, for the same reason.
 */
export type RoleRules = { [role: string]: RoleRuleTree | RuleDecision };

export type RoleBasedPermissionOptions = {
  /** Deny any surface no rule mentions. Defaults to `true`. */
  defaultDeny?: boolean;
  /** Rules merged *under* the selected role's own rules. */
  defaults?: RoleRuleTree;
};

/**
 * `undefined` means "this rules node expressed no opinion", which is distinct
 * from an explicit `"deny"`. Keeping the two apart is what lets a gate consult
 * a fallback rules key (below) without a blanket `"allow"` on the fallback
 * overriding an explicit `"deny"` on the primary.
 */
type Decision = boolean | undefined;

function decideKey(value: any): Decision {
  if (value === "deny") {
    return false;
  }
  if (value === "allow") {
    return true;
  }
  return undefined;
}

/** One-arg gates: `model`, `query`, `mutation*`, `*Extension`. */
function decideOne(node: any, name: string | number): Decision {
  const blanket = decideKey(node);
  if (blanket !== undefined) {
    return blanket;
  }
  if (!node || typeof node !== "object") {
    return undefined;
  }
  return decideKey(node[name]);
}

/** Two-arg gates: `field`, `relationship`, `*Methods`, `mutation*Input`. */
function decideTwo(node: any, model: string | number, name: string | number): Decision {
  const blanket = decideKey(node);
  if (blanket !== undefined) {
    return blanket;
  }
  if (!node || typeof node !== "object") {
    return undefined;
  }
  const modelNode = node[model];
  const perModel = decideKey(modelNode);
  if (perModel !== undefined) {
    return perModel;
  }
  if (!modelNode || typeof modelNode !== "object") {
    return undefined;
  }
  return decideKey(modelNode[name]);
}

/**
 * Which rules keys each emitted predicate consults, in order — first key with
 * an opinion wins.
 *
 * Only two gates have a fallback, and both are deliberate:
 *
 *  - `queryExtension`/`mutationExtension` accept `extensions`, the key older
 *    rules trees were written against back when it was emitted (and read by
 *    nobody).
 *  - `mutationCreateInput`/`mutationUpdateInput` fall back to `field`, so a
 *    role that granted a field for reading can still write it. Without this a
 *    `defaultDeny` role would deny every input field and its create/update
 *    mutations would vanish entirely — the same "if it should be writable it
 *    must be readable" rule 7.0 already applies to `where`/`orderBy`.
 *
 * Deliberately absent: any chain from `mutationCreate`/`Update`/`Delete` to
 * `mutation`, and any convenience alias for the method gates. Each would
 * *loosen* a key that denies today.
 */
const ONE_ARG_GATES: { [gate: string]: string[] } = {
  model: ["model"],
  query: ["query"],
  mutation: ["mutation"],
  mutationCreate: ["mutationCreate"],
  mutationUpdate: ["mutationUpdate"],
  mutationDelete: ["mutationDelete"],
  queryExtension: ["queryExtension", "extensions"],
  mutationExtension: ["mutationExtension", "extensions"],
};

const TWO_ARG_GATES: { [gate: string]: string[] } = {
  field: ["field"],
  relationship: ["relationship"],
  queryClassMethods: ["queryClassMethods"],
  mutationClassMethods: ["mutationClassMethods"],
  queryInstanceMethods: ["queryInstanceMethods"],
  mutationCreateInput: ["mutationCreateInput", "field"],
  mutationUpdateInput: ["mutationUpdateInput", "field"],
};

/** Every rules key that means something. Anything else is a silent no-op. */
const KNOWN_RULE_KEYS = new Set(
  Object.keys(ONE_ARG_GATES)
    .concat(Object.keys(TWO_ARG_GATES))
    .reduce((keys: string[], gate: string) => {
      return keys.concat(ONE_ARG_GATES[gate] || TWO_ARG_GATES[gate]);
    }, []),
);

// Same channel, and the same reasoning, as gqlize's schema-build warning: the
// `debug`-backed logger is silent unless DEBUG is set, which would make a rule
// that gates nothing an invisible event.
const log = {
  warn: (message: string) => console.warn(message), // eslint-disable-line no-console
};

function warnUnknownRuleKeys(compiledRules: RoleRuleTree) {
  const unknown = Object.keys(compiledRules).filter((key) => !KNOWN_RULE_KEYS.has(key));
  if (unknown.length === 0) {
    return;
  }
  log.warn(
    `createRoleBasedPermissions: rules contain ${unknown.length === 1 ? "a key" : "keys"} nothing reads — ` +
      `${unknown.join(", ")}. ${unknown.length === 1 ? "It gates" : "They gate"} nothing. ` +
      `Accepted rule keys: ${Array.from(KNOWN_RULE_KEYS).sort().join(", ")}.`,
  );
}

function buildGate(
  compiledRules: RoleRuleTree,
  chain: string[],
  defaultDeny: boolean,
  decide: (node: RuleNode | undefined, ...args: any[]) => Decision,
) {
  const present = chain.filter((ruleKey) => compiledRules[ruleKey] !== undefined);
  if (present.length === 0) {
    // No rule mentions this gate: deny everything, or leave the predicate off
    // entirely so `isAllowed` falls through to its permissive default.
    return defaultDeny ? () => false : undefined;
  }
  return (...args: any[]) => {
    for (const ruleKey of present) {
      const decision = decide(compiledRules[ruleKey], ...args);
      if (decision !== undefined) {
        return decision;
      }
    }
    return !defaultDeny;
  };
}

/**
 * @function createRoleBasedPermissions
 * @param {string} role
 * @param {Object} rules
 * @param {Object} options
 * @return {Object} a permission bag suitable for `options.permission`
 *
 * Compiles an allow/deny rules tree into the predicate bag that
 * `options.permission` expects. Leaves are the strings `"allow"` / `"deny"`;
 * anything else is "no opinion" and falls through to `!defaultDeny`.
 *
 * Every emitted key is one a consumer actually reads (`PERMISSION_KEYS` in
 * `./gate`) — emitting anything else is worse than useless, because
 * `isAllowed` treats an unread predicate as ALLOW. Under `defaultDeny` a key
 * nobody consults would leave that surface wide open while looking gated.
 *
 * Two-arg rules — `{[model]: "allow" | "deny" | {[name]: "allow" | "deny"}}`:
 * `field`, `relationship`, `queryClassMethods`, `mutationClassMethods`,
 * `queryInstanceMethods`, `mutationCreateInput`, `mutationUpdateInput`.
 *
 * One-arg rules — `{[model]: "allow" | "deny"}`: `model`, `query`, `mutation`,
 * `mutationCreate`, `mutationUpdate`, `mutationDelete`, plus `queryExtension`
 * and `mutationExtension`, whose "model" is the `options.extend.*` field key
 * rather than a definition name.
 *
 * There is no `subscription` rule: gqlize's subscription support is
 * unimplemented, so such a predicate could never be called.
 */

/*
  options = {
    defaultDeny: true
  }

  defaults = {
    "field": {
      "User": {
        "password": "deny",
      },
    },
    "queryClassMethods": {
      "User": {
        "login": "allow",
        "logout": "allow",
      },
    },
  };

  rules = {
    "admin": {
      "field": {
        "User": "allow",
      },
      "model": "allow",
      "queryClassMethods": {
        "User": {
          "login": "deny",
        },
      },
    },
    "user": {
      "mutation": "deny",
    },
  };

*/

export default function createRoleBasedPermissions(
  role: string | number,
  rules: RoleRules,
  options: RoleBasedPermissionOptions = {},
): Permission {
  const {defaultDeny = true, defaults: defaultPerms = {}} = options;
  // Only the selected role's rules are needed — merge just that entry rather than
  // deep-merging every role's rules and discarding all but one.
  // A role may be a bare `"allow"`/`"deny"` string rather than a tree. There are
  // no gate keys to merge in that case; the empty tree lets `defaultDeny` decide,
  // which is what the string form already resolved to before it was typed.
  const roleRules = rules[role];
  const compiledRules: RoleRuleTree = roleRules && typeof roleRules === "object"
    ? deepmerge<RoleRuleTree>(defaultPerms, roleRules)
    : {};
  warnUnknownRuleKeys(compiledRules);

  // Built through a string-keyed bag because the loops below are driven by the
  // runtime gate maps. `ROLE_BASED_GATES` is asserted against `PERMISSION_KEYS`
  // in the tests, so the cast at the return is backed by a check rather than a
  // hope.
  const permission: Record<string, unknown> = {};
  Object.keys(ONE_ARG_GATES).forEach((gate) => {
    const predicate = buildGate(compiledRules, ONE_ARG_GATES[gate], defaultDeny,
      (node, name: string | number) => decideOne(node, name));
    if (predicate) {
      permission[gate] = predicate;
    }
  });
  Object.keys(TWO_ARG_GATES).forEach((gate) => {
    const predicate = buildGate(compiledRules, TWO_ARG_GATES[gate], defaultDeny,
      (node, model: string | number, name: string | number) => decideTwo(node, model, name));
    if (predicate) {
      permission[gate] = predicate;
    }
  });
  return permission as Permission;
}

/** Every gate this helper can emit — the keys it is responsible for covering. */
export const ROLE_BASED_GATES = Object.keys(ONE_ARG_GATES).concat(Object.keys(TWO_ARG_GATES));
