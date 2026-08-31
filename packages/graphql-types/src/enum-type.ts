import { GraphQLEnumType } from "graphql";
import { capitalize } from "@azerothian/utilize/utils/word";

/**
 * Building a GraphQL enum from a definition's declared members.
 *
 * This lives here, in the one GraphQL-aware package both adapters already
 * depend on, because the two of them have to agree and previously did not.
 * `utilize` is the wrong home — it is deliberately GraphQL-free — and a copy
 * per adapter is how the divergence happened in the first place:
 *
 *  - the sequelize adapter sanitized member names and capitalized the type name;
 *  - the valkey adapter did neither, so the same model produced a differently
 *    named enum type on each backend, and any member carrying a space, hyphen or
 *    leading digit was rejected outright: GraphQL names must match
 *    `/^[_a-zA-Z][_a-zA-Z0-9]*$/`, and `assertEnumValueName` throws on the rest.
 *
 * Worth knowing where that throw lands, because it is not where you would look:
 * `new GraphQLEnumType(...)` builds its values lazily, so construction succeeds
 * and the error surfaces later, the first time anything materialises them — a
 * schema build, a print, a validate. The stack names `assertEnumValueName`, not
 * the definition that declared the member.
 *
 * One implementation, so a definition that builds on one backend builds on the
 * other and names the same type.
 */

/**
 * Characters with a conventional spelled-out name. Anything else non-alphanumeric
 * becomes a word break, which the camel-casing in {@link sanitizeEnumValue} then
 * closes up.
 */
const SPECIAL_CHARS = new Map([
  ["¼", "frac14"],
  ["½", "frac12"],
  ["¾", "frac34"],
]);

/**
 * A declared enum member, as a legal GraphQL enum value name.
 *
 * The member's *value* is unchanged — only the name it is reachable by in the
 * schema is rewritten, and the caller keeps the original as the resolved value.
 * A leading digit is prefixed rather than dropped: `2xl` becoming `xl` would
 * silently collide with a real `xl` member.
 */
export function sanitizeEnumValue(value: string): string {
  return value
    .trim()
    .replace(/([^_a-zA-Z0-9])/g, (_: string, p: string) => SPECIAL_CHARS.get(p) || " ")
    .split(" ")
    .map((v: string, i: number) => (i ? capitalize(v) : v))
    .join("")
    .replace(/(^\d)/, "_$1");
}

/** The generated type name for one model's enum field. */
export function enumTypeName(modelName?: string, fieldName?: string): string {
  return `${capitalize(modelName || "")}${capitalize(fieldName || "")}Enum`;
}

/**
 * The enum type for one field, named and sanitized identically on every backend.
 *
 * Members whose sanitized names collide are reported rather than silently
 * merged: two members that differ only in punctuation (`in-progress` and
 * `in progress`) would otherwise become one value, and the losing member would
 * be unqueryable with no indication why.
 */
export function createEnumType(
  modelName: string | undefined,
  fieldName: string | undefined,
  values: readonly string[],
): GraphQLEnumType {
  const seen: { [name: string]: string } = {};
  const members = (values || []).reduce((o: { [name: string]: { value: string } }, member: string) => {
    const name = sanitizeEnumValue(member);
    if (seen[name] !== undefined && seen[name] !== member) {
      throw new Error(
        `Enum ${enumTypeName(modelName, fieldName)}: members "${seen[name]}" and "${member}" both ` +
        `sanitize to "${name}". GraphQL enum names allow only [_a-zA-Z][_a-zA-Z0-9]*, so give one of ` +
        `them a name that differs by more than punctuation.`,
      );
    }
    seen[name] = member;
    o[name] = { value: member };
    return o;
  }, {});
  return new GraphQLEnumType({ name: enumTypeName(modelName, fieldName), values: members });
}
