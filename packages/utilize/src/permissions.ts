import deepmerge from "deepmerge";

import { PERMISSION_KEYS } from "./gate";
import type { Permission, PortableWhere, ScopeOperation, ScopePredicate } from "./gate";
import type { RequestContext } from "./types/index";

/** A leaf decision in a rules tree. Anything else is "no opinion". */
export type RuleDecision = "allow" | "deny";

/**
 * One node of a rules tree: a blanket decision, or a map one level deeper. The
 * depth that carries meaning varies by gate — one-arg gates read
 * `{[name]: decision}`, two-arg gates read `{[model]: {[name]: decision}}` —
 * so the node is recursive rather than depth-indexed.
 */
export type RuleNode = RuleDecision | { [key: string]: RuleNode };

/**
 * One role's rules as the engine reads them after merging: a node per gate key
 * (see `KNOWN_RULE_KEYS`).
 *
 * `scope` is the exception the index signature cannot describe — its leaves are
 * *values* (`{own: "ownerId"}`), not decisions — so it is typed as `unknown`
 * here and narrowed to {@link ScopeRules} by `buildScopeGate`, the one reader.
 * {@link RoleRuleInput} is the shape an author writes against.
 */
export type RoleRuleTree = { [gate: string]: RuleNode | unknown };

/**
 * One role's rules as an author writes them.
 *
 * Separate from {@link RoleRuleTree} so that `scope` can carry its own
 * sub-language while every other key keeps the narrow {@link RuleNode} type
 * that turns a typo into a compile error.
 */
export type RoleRuleInput = {
  /** Row-level scoping. Its own sub-language; see {@link ScopeRules}. */
  scope?: ScopeRules;
} & {
  [gate: string]: RuleNode | ScopeRules | undefined;
};

/**
 * The tree handed to `createRoleBasedPermissions`, keyed by role.
 *
 * A role's value is normally a {@link RoleRuleTree}, but a bare `"deny"` is an
 * accepted (and documented) shorthand for "this role gets nothing" — see
 * `docs/guide.md`. It carries no gate keys, so under the default `defaultDeny`
 * every gate denies. Note the corollary: a bare `"allow"` does **not** grant
 * anything, for the same reason.
 */
export type RoleRules = { [role: string]: RoleRuleInput | RuleDecision };

export type RoleBasedPermissionOptions = {
  /** Deny any surface no rule mentions. Defaults to `true`. */
  defaultDeny?: boolean;
  /** Rules merged *under* the selected role's own rules. */
  defaults?: RoleRuleInput;
  /**
   * How a compiled `scope` rule finds the principal in a request context.
   * Defaults to `context.user` / `context.principal` / `context.req.user`.
   * Ignored when no rule mentions `scope`.
   */
  principal?: PrincipalReader;
};

/**
 * `undefined` means "this rules node expressed no opinion", which is distinct
 * from an explicit `"deny"`. Keeping the two apart is what lets a gate consult
 * a fallback rules key (below) without a blanket `"allow"` on the fallback
 * overriding an explicit `"deny"` on the primary.
 */
type Decision = boolean | undefined;

function decideKey(value: RuleNode | undefined): Decision {
  if (value === "deny") {
    return false;
  }
  if (value === "allow") {
    return true;
  }
  return undefined;
}

/** One-arg gates: `model`, `query`, `mutation*`, `*Extension`. */
function decideOne(node: RuleNode | undefined, name: string | number): Decision {
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
function decideTwo(node: RuleNode | undefined, model: string | number, name: string | number): Decision {
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
/**
 * Every `PERMISSION_KEYS` entry this helper is responsible for emitting.
 * Two keys are excluded, for different reasons. `options` is the shared context
 * value, not a predicate at all. `scope` *is* a predicate, but its leaves are
 * values (`{own: "ownerId"}`) rather than allow/deny decisions, so it is compiled
 * by `buildScopeGate` below instead of from a gate map — see the block after the
 * drift check. Excluding it here narrows this check to the boolean gates; that
 * `scope` is still emitted is proved at runtime instead, by `ROLE_BASED_GATES`
 * and the "covers every gate a consumer reads" test in `__tests__/permissions`.
 */
type GateKey = Exclude<typeof PERMISSION_KEYS[number], "options" | "scope">;

/** A gate map may name only real gates, and each maps to the rules keys feeding it. */
type GateMap = { [gate in GateKey]?: string[] };

const ONE_ARG_GATES = {
  model: ["model"],
  query: ["query"],
  mutation: ["mutation"],
  mutationCreate: ["mutationCreate"],
  mutationUpdate: ["mutationUpdate"],
  mutationDelete: ["mutationDelete"],
  queryDeleted: ["queryDeleted"],
  mutationRestore: ["mutationRestore"],
  queryExtension: ["queryExtension", "extensions"],
  mutationExtension: ["mutationExtension", "extensions"],
} satisfies GateMap;

const TWO_ARG_GATES = {
  field: ["field"],
  relationship: ["relationship"],
  queryClassMethods: ["queryClassMethods"],
  mutationClassMethods: ["mutationClassMethods"],
  queryInstanceMethods: ["queryInstanceMethods"],
  mutationInstanceMethods: ["mutationInstanceMethods"],
  mutationCreateInput: ["mutationCreateInput", "field"],
  mutationUpdateInput: ["mutationUpdateInput", "field"],
} satisfies GateMap;

/**
 * Compile-time proof that the two gate maps together cover every gate a consumer
 * reads. The `satisfies` above stops a typo'd gate name; this stops the opposite
 * and more dangerous mistake — a real gate no map mentions, which emits no
 * predicate at all. `isAllowed` reads an absent predicate as ALLOW, so under
 * `defaultDeny` that surface is wide open while the bag looks gated.
 * `mutationInstanceMethods` shipped in exactly that state.
 *
 * It bites: adding `scope` to `PERMISSION_KEYS` failed this line until `scope`
 * was named as compiled elsewhere, which is the conversation it exists to force.
 */
type _GatesCoverEveryKey =
  [Exclude<GateKey, keyof typeof ONE_ARG_GATES | keyof typeof TWO_ARG_GATES>] extends [never]
    ? true
    : never;
const _gatesCoverEveryKey: _GatesCoverEveryKey = true;
void _gatesCoverEveryKey;

// --- `scope`: the one gate with a value, not a decision ----------------------
//
// Everything above compiles `"allow"` / `"deny"` leaves through `decideKey`,
// which reads anything else as "no opinion". That is right for boolean gates and
// wrong for this one: `{own: "ownerId"}` is a *value*, and "no opinion" on a
// scope means unscoped. So `scope` gets its own compiler and `decideKey`,
// `decideOne` and `decideTwo` are left exactly as they were. Its second level is
// an *operation* rather than a field name, which is the other reason it does not
// fit the two-arg gate machinery.

/** The operations a scope rule may be written against; `write` covers the last three. */
const SCOPE_OPERATION_KEYS = ["read", "write", "create", "update", "delete"];

const SCOPE_OPERATION_SET = new Set(SCOPE_OPERATION_KEYS);

/**
 * How a sugar leaf names the principal's side of a comparison. The short form
 * is the model's field name and the principal key is defaulted; the long form
 * spells both out for the cases where they differ.
 */
type ScopeSugarRef = string | { field: string; from?: string };

/**
 * One compiled scope condition.
 *
 * `own` matches a field against the principal's id; `group` matches a field
 * against a *list* on the principal; `tenant` is `own` with a different default
 * principal key, kept separate because it reads better in a rules tree and
 * because it is the case that most often wants `set` on a create.
 */
type ScopeSugarLeaf =
  | RuleDecision
  | "none"
  | { own: ScopeSugarRef }
  | { tenant: ScopeSugarRef }
  | { group: ScopeSugarRef }
  | { any: ScopeSugarLeaf[] }
  | { all: ScopeSugarLeaf[] };

/** A model's scope rules: one leaf for everything, or a leaf per operation. */
type ScopeRuleNode =
  | ScopeSugarLeaf
  | { read?: ScopeSugarLeaf; write?: ScopeSugarLeaf; create?: ScopeSugarLeaf; update?: ScopeSugarLeaf; delete?: ScopeSugarLeaf };

/** The `scope` key of a rules tree: blanket, or keyed by model. */
export type ScopeRules = RuleDecision | "none" | { [model: string]: ScopeRuleNode };

/**
 * Whoever the request is acting as, read by field name. Deliberately open — a
 * deployment's principal is its own, and the sugar only ever indexes it with
 * the key a rule names (`id`, `tenantId`, `groupIds`, ...).
 */
export type Principal = { [key: string]: unknown };

/**
 * How a compiled scope finds the principal in a request context.
 *
 * Defaulted rather than required because every host puts it somewhere slightly
 * different — gqlize passes the GraphQL context, nestize passes `{req}` — but a
 * deployment whose principal lives anywhere else supplies its own reader. A
 * reader that finds nothing is a **deny**, not an unscoped query: that is the
 * whole asymmetry of this key.
 */
export type PrincipalReader = (context: RequestContext) => Principal | undefined;

const defaultPrincipal: PrincipalReader = (context) => {
  if (!context || typeof context !== "object") {
    return undefined;
  }
  const bag = context as {
    user?: Principal; principal?: Principal;
    req?: { user?: Principal }; request?: { user?: Principal };
  };
  return bag.user || bag.principal || bag.req?.user || bag.request?.user;
};

function refOf(ref: ScopeSugarRef, defaultFrom: string): { field: string; from: string } {
  if (typeof ref === "string") {
    return { field: ref, from: defaultFrom };
  }
  return { field: ref.field, from: ref.from || defaultFrom };
}

/**
 * A compiled leaf's contribution. `false` denies; `undefined` imposes nothing;
 * otherwise it is a portable filter plus, for creates, the value to force.
 */
type LeafResult = false | undefined | { where?: PortableWhere; set?: { [field: string]: unknown } };

function compareLeaf(
  ref: { field: string; from: string }, principal: Principal | undefined, operation: ScopeOperation,
): LeafResult {
  const value = principal?.[ref.from];
  if (value === undefined || value === null) {
    // The principal exists but carries nothing to compare against. Allowing the
    // query would be "everyone's rows"; this is the fail-closed direction.
    return false;
  }
  if (operation === "create") {
    // A create has no `where` to narrow — the scope *supplies* the value the
    // row is created with instead. The complementary half is structural:
    // `ownerId` is a foreign key, so `isStructurallyWritable` already keeps the
    // client from sending one.
    return { set: { [ref.field]: value } };
  }
  return { where: { [ref.field]: { eq: value } } };
}

function compileLeaf(leaf: ScopeSugarLeaf, principal: Principal | undefined, operation: ScopeOperation): LeafResult {
  if (leaf === "deny") {
    return false;
  }
  if (leaf === "none" || leaf === "allow") {
    // `"none"` has to exist as a spelling even though it imposes nothing:
    // an *absent* scope key already means unscoped, so without it "this role
    // sees everything" and "nobody has configured this yet" would be the same
    // rules tree. `"allow"` is accepted as its synonym because a rules tree
    // full of `"allow"`/`"deny"` invites it.
    return undefined;
  }
  if (!leaf || typeof leaf !== "object") {
    return undefined;
  }
  if ("own" in leaf) {
    return compareLeaf(refOf(leaf.own, "id"), principal, operation);
  }
  if ("tenant" in leaf) {
    return compareLeaf(refOf(leaf.tenant, "tenantId"), principal, operation);
  }
  if ("group" in leaf) {
    const ref = refOf(leaf.group, "groupIds");
    const value = principal?.[ref.from];
    const members = Array.isArray(value) ? value : undefined;
    if (!members || members.length === 0) {
      // §9.4's empty-membership case, normalised. `{groupId: {in: []}}` is
      // "match nothing" spelled as a filter — inside an `any` it is merely
      // wasteful, and returned alone it is a deny that reads like a bug (and
      // that some adapters cannot express at all). Say deny.
      return false;
    }
    // Note this is the same on a create as on a read, where `own` and `tenant`
    // switch to `set`. "One of your groups" does not name a single value, so
    // there is nothing to force — the row is constrained to land in a group the
    // principal is in, and choosing which one stays with the caller.
    return { where: { [ref.field]: { in: members } } };
  }
  if ("any" in leaf) {
    const branches = leaf.any.map((entry) => compileLeaf(entry, principal, operation));
    // A denied branch contributes nothing to an OR; every branch denied is a deny.
    const live = branches.filter((branch) => branch !== false);
    if (live.length === 0) {
      return false;
    }
    // An unscoped branch makes the whole alternation unscoped — "or anything".
    if (live.some((branch) => branch === undefined)) {
      return undefined;
    }
    const kept = live as { where?: PortableWhere; set?: { [field: string]: unknown } }[];
    const wheres = kept.map((branch) => branch.where).filter(Boolean) as PortableWhere[];
    if (wheres.length === 0) {
      return undefined;
    }
    return { where: wheres.length === 1 ? wheres[0] : { or: wheres } };
  }
  if ("all" in leaf) {
    const branches = leaf.all.map((entry) => compileLeaf(entry, principal, operation));
    if (branches.some((branch) => branch === false)) {
      return false;
    }
    const kept = branches.filter(Boolean) as { where?: PortableWhere; set?: { [field: string]: unknown } }[];
    const wheres = kept.map((branch) => branch.where).filter(Boolean) as PortableWhere[];
    const set = kept.reduce((o: { [field: string]: unknown }, branch) => Object.assign(o, branch.set), {});
    const out: { where?: PortableWhere; set?: { [field: string]: unknown } } = {};
    if (wheres.length === 1) {
      out.where = wheres[0];
    } else if (wheres.length > 1) {
      out.where = { and: wheres };
    }
    if (Object.keys(set).length > 0) {
      out.set = set;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

function leafForOperation(node: ScopeRuleNode, operation: ScopeOperation): ScopeSugarLeaf | undefined {
  if (!node || typeof node !== "object") {
    return node;
  }
  const keys = Object.keys(node);
  const isOperationMap = keys.some((key) => SCOPE_OPERATION_SET.has(key));
  if (!isOperationMap) {
    return node as ScopeSugarLeaf;
  }
  const map = node as { [op: string]: ScopeSugarLeaf | undefined };
  // Most specific first: an explicit `update` beats the `write` it falls under.
  if (map[operation] !== undefined) {
    return map[operation];
  }
  if (operation !== "read" && map.write !== undefined) {
    return map.write;
  }
  return undefined;
}

/**
 * Compile a rules tree's `scope` key into a {@link ScopePredicate}.
 *
 * Note what is deliberately missing: `defaultDeny` does **not** apply. Every
 * other gate denies a surface no rule mentions, because an unmentioned surface
 * is one nobody thought about. Scope inverts that — an absent scope means
 * "unscoped", which is what every deployment that predates this key already
 * relies on, and what `model`/`query` are there to restrict instead. So a role
 * with no `scope` rules gets no predicate at all rather than one that denies
 * every row.
 */
function buildScopeGate(compiledRules: RoleRuleTree, principalOf: PrincipalReader): ScopePredicate | undefined {
  const rules = compiledRules.scope as ScopeRules | undefined;
  if (rules === undefined) {
    return undefined;
  }
  return (defName: string, operation: ScopeOperation, _options, context) => {
    if (rules === "none" || rules === "allow") {
      return undefined;
    }
    if (rules === "deny") {
      return false;
    }
    const node = rules[defName];
    if (node === undefined) {
      return undefined;
    }
    const leaf = leafForOperation(node, operation);
    if (leaf === undefined) {
      return undefined;
    }
    const principal = principalOf(context);
    if (!principal && leaf !== "none" && leaf !== "allow") {
      // No principal and a rule that needs one. Denying is the only safe
      // reading: "everything" is what the absent-key case already means.
      return false;
    }
    return compileLeaf(leaf, principal, operation);
  };
}

/** Every rules key that means something. Anything else is a silent no-op. */
const KNOWN_RULE_KEYS = new Set(
  [...Object.values(ONE_ARG_GATES), ...Object.values(TWO_ARG_GATES)].flat()
    // `scope` is compiled by `buildScopeGate` rather than the gate maps, so it
    // has to be added by hand — otherwise a rules tree that scopes correctly
    // would be reported as containing a key nothing reads.
    .concat(["scope"]),
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

function buildGate<TArgs extends (string | number)[]>(
  compiledRules: RoleRuleTree,
  chain: string[],
  defaultDeny: boolean,
  decide: (node: RuleNode | undefined, ...args: TArgs) => Decision,
) {
  const present = chain.filter((ruleKey) => compiledRules[ruleKey] !== undefined);
  if (present.length === 0) {
    // No rule mentions this gate: deny everything, or leave the predicate off
    // entirely so `isAllowed` falls through to its permissive default.
    return defaultDeny ? () => false : undefined;
  }
  return (...args: TArgs): boolean => {
    for (const ruleKey of present) {
      // `chain` only ever comes from the two gate maps, neither of which
      // names `scope` — the one key whose node is not a `RuleNode`.
      const decision = decide(compiledRules[ruleKey] as RuleNode | undefined, ...args);
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
 * `queryInstanceMethods`, `mutationInstanceMethods`, `mutationCreateInput`,
 * `mutationUpdateInput`.
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
  const {defaultDeny = true, defaults: defaultPerms = {}, principal = defaultPrincipal} = options;
  // Only the selected role's rules are needed — merge just that entry rather than
  // deep-merging every role's rules and discarding all but one.
  // A role may be a bare `"allow"`/`"deny"` string rather than a tree. There are
  // no gate keys to merge in that case; the empty tree lets `defaultDeny` decide,
  // which is what the string form already resolved to before it was typed.
  const roleRules = rules[role];
  const compiledRules: RoleRuleTree = roleRules && typeof roleRules === "object"
    ? deepmerge<RoleRuleInput>(defaultPerms, roleRules)
    : {};
  warnUnknownRuleKeys(compiledRules);

  // Built through a string-keyed bag because the loops below are driven by the
  // runtime gate maps. `ROLE_BASED_GATES` is asserted against `PERMISSION_KEYS`
  // in the tests, so the cast at the return is backed by a check rather than a
  // hope.
  const permission: Record<string, unknown> = {};
  (Object.keys(ONE_ARG_GATES) as (keyof typeof ONE_ARG_GATES)[]).forEach((gate) => {
    const predicate = buildGate(compiledRules, ONE_ARG_GATES[gate], defaultDeny,
      (node, name: string | number) => decideOne(node, name));
    if (predicate) {
      permission[gate] = predicate;
    }
  });
  (Object.keys(TWO_ARG_GATES) as (keyof typeof TWO_ARG_GATES)[]).forEach((gate) => {
    const predicate = buildGate(compiledRules, TWO_ARG_GATES[gate], defaultDeny,
      (node, model: string | number, name: string | number) => decideTwo(node, model, name));
    if (predicate) {
      permission[gate] = predicate;
    }
  });
  const scope = buildScopeGate(compiledRules, principal);
  if (scope) {
    permission.scope = scope;
  }
  return permission;
}

/** Every gate this helper can emit — the keys it is responsible for covering. */
export const ROLE_BASED_GATES = Object.keys(ONE_ARG_GATES)
  .concat(Object.keys(TWO_ARG_GATES))
  .concat(["scope"]);
