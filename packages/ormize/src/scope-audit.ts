// Row-level scoping, the surfaces the engine cannot reach (§12).
//
// Every enforcement point so far — the engine's chokepoints, the adapter's model
// hooks — works by owning the query. Four surfaces run userland code holding the
// orm or the model directly, so there is no query to own and nothing underneath
// that knows a request is happening:
//
//   - class methods            (`definition.classMethods`, nestize `_actions`,
//                               the temporalize registry)
//   - instance methods         (`definition.instanceMethods`)
//   - raw-SQL class methods    (a `SqlClassMethod` descriptor)
//   - `options.extend.query` / `.mutation`  (audited in gqlize, same vocabulary)
//
// A scope simply does not apply there. That is defensible; being *quiet* about
// it is not. So this is the same answer the codebase already gives to the same
// shape of problem — `_NoDrift`, `unknownPermissionKeys`, `isStructurallyWritable`
// — which is to fail at build time and make the deployment say what it meant.
//
// Three ways out, in order of preference: route the work back through the engine
// (needs nothing here), claim the filter with `scopeAware` and apply it, or
// admit the surface is unscoped with `unscoped`. The last two are the same one
// line, so the cheap answer is not the silent one.

import { scopeDispositionOf } from "@azerothian/utilize/gate";
import type { Definition, OrmAdapter } from "@azerothian/utilize/types/index";

/** The named parameter a scope-aware raw query binds the resolved scope through. */
export const SCOPE_PLACEHOLDER = /:scope[A-Za-z0-9_]*/;

export type ScopeSurfaceKind = "classMethod" | "instanceMethod" | "sqlClassMethod" | "extendField";

/** One thing the audit has to say about one surface. */
export type ScopeSurfaceFinding = {
  defName: string;
  kind: ScopeSurfaceKind;
  name: string;
  /**
   * `unannotated` follows the backend (decisions 7 and 9); the other two are
   * always errors, because neither is a judgement about enforcement depth — one
   * is a definition that says both things at once, the other a query whose text
   * contradicts the claim written above it.
   */
  problem: "unannotated" | "conflict" | "sqlMissingPlaceholder";
};

const SURFACE_LABEL: {[kind in ScopeSurfaceKind]: string} = {
  classMethod: "class method",
  instanceMethod: "instance method",
  sqlClassMethod: "raw-SQL class method",
  extendField: "extend field",
};

/** A `SqlClassMethod` descriptor, through the members the audit reads. */
type SqlDescriptor = { type?: string; query?: string; args?: string[] };

/**
 * Whether a raw query wires the scope in at all.
 *
 * Two spellings, because `generateSQLFunction` has two: a literal `query`, whose
 * text is searched, and the generated `SELECT * FROM fn(:a,:b)` form, where the
 * argument list *is* the text.
 */
function referencesScope(descriptor: SqlDescriptor): boolean {
  if (typeof descriptor.query === "string" && SCOPE_PLACEHOLDER.test(descriptor.query)) {
    return true;
  }
  return (descriptor.args || []).some((arg) => /^scope/.test(arg));
}

function auditEntry(defName: string, kind: ScopeSurfaceKind, name: string, value: unknown): ScopeSurfaceFinding | undefined {
  const disposition = scopeDispositionOf(value);
  if (disposition === "conflict") {
    return { defName, kind, name, problem: "conflict" };
  }
  if (disposition === "unscoped") {
    return undefined;
  }
  if (kind !== "sqlClassMethod") {
    return disposition === "aware" ? undefined : { defName, kind, name, problem: "unannotated" };
  }
  // Raw SQL is the sharpest case and gets the sharpest rule: the placeholder is
  // the only lever a descriptor has, so its presence *is* the opt-in and its
  // absence under an explicit `scopeAware` is a claim the text disproves.
  const wired = referencesScope(value as SqlDescriptor);
  if (wired) {
    return undefined;
  }
  return {
    defName, kind, name,
    problem: disposition === "aware" ? "sqlMissingPlaceholder" : "unannotated",
  };
}

/** The two spellings of a method bag; the nested one wins, as `createModel` has it. */
function methodsOf(def: Definition, key: "classMethods" | "instanceMethods"): {[name: string]: unknown} {
  const nested = def.options?.[key] as {[name: string]: unknown} | undefined;
  return nested || def[key] || {};
}

/**
 * Audit one definition's methods.
 *
 * Called for every model whenever `permission.scope` is a function, and that
 * coarseness is deliberate: whether a scope applies to a *particular* model is a
 * question only the predicate can answer, and only per request. A build cannot
 * ask it, so it asks the answerable question instead — is a row-level scope
 * configured at all — and makes every surface declare itself. A model the
 * predicate never scopes says so in one word, once.
 */
export function auditDefinitionScopeSurfaces(defName: string, def: Definition): ScopeSurfaceFinding[] {
  const findings: ScopeSurfaceFinding[] = [];
  const classMethods = methodsOf(def, "classMethods");
  for (const name of Object.keys(classMethods)) {
    const value = classMethods[name];
    // A descriptor rather than a function is the raw-SQL form — the same branch
    // `installClassMethods` takes, kept in step with it deliberately.
    const kind: ScopeSurfaceKind = typeof value === "function" ? "classMethod" : "sqlClassMethod";
    const finding = auditEntry(defName, kind, name, value);
    if (finding) {
      findings.push(finding);
    }
  }
  const instanceMethods = methodsOf(def, "instanceMethods");
  for (const name of Object.keys(instanceMethods)) {
    const finding = auditEntry(defName, "instanceMethod", name, instanceMethods[name]);
    if (finding) {
      findings.push(finding);
    }
  }
  return findings;
}

function describe(finding: ScopeSurfaceFinding): string {
  const where = `${finding.defName}.${finding.name} (${SURFACE_LABEL[finding.kind]})`;
  switch (finding.problem) {
    case "conflict":
      return `${where} is marked both scopeAware and unscoped. Those are opposite claims; pick one.`;
    case "sqlMissingPlaceholder":
      return `${where} is marked scopeAware but its query never references a ':scope…' parameter, `
        + "so the resolved scope has nowhere to bind. Reference one, or mark the method unscoped.";
    default:
      return `${where} runs with a row-level scope configured, and the engine cannot reach it to apply one. `
        + "Route it through the orm, mark it scopeAware and apply the scope yourself, or mark it unscoped.";
  }
}

/**
 * Report the audit, loudly enough for the backend underneath it.
 *
 * Decision 7 and decision 9 together. An adapter whose model hooks fire has
 * §13's enforcement under every one of these surfaces, so an unannotated method
 * there is a gap in the *documentation* of intent and warns for a minor. An
 * adapter without a hook layer has nothing under it — the engine merge is the
 * only enforcement it has ever had — so the same method is a hole, and holes
 * throw. The other two problems are contradictions rather than depth judgements
 * and throw on every backend.
 */
export function reportScopeSurfaces(findings: ScopeSurfaceFinding[], adapterFor: (defName: string) => OrmAdapter | undefined): void {
  const fatal: string[] = [];
  const warnings: string[] = [];
  for (const finding of findings) {
    const enforced = adapterFor(finding.defName)?.enforcesRowScope === true;
    const message = describe(finding);
    if (finding.problem !== "unannotated" || !enforced) {
      fatal.push(message);
    } else {
      warnings.push(message);
    }
  }
  warnings.forEach((message) => {
    // The channel `unknownPermissionKeys` and `warnUnknownRuleKeys` already use,
    // for the same reason: a build that is about to run anyway, saying what a
    // reviewer would otherwise have to notice.
    console.warn(`ormize: ${message}`); // eslint-disable-line no-console
  });
  if (fatal.length) {
    throw new Error(`ormize: row-level scope (§12) cannot be applied to:\n  - ${fatal.join("\n  - ")}`);
  }
}
