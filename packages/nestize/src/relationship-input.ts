// Checking a nested relationship input that arrives over REST, before the
// engine runs it.
//
// gqlize never needs this: a nested input there is held to the input types
// the permissions shaped, so a verb, a relationship or a field the caller may
// not use is simply not in the schema. REST takes plain JSON. The routes that
// forward a nested input (`POST /:resource/:id/:relation`,
// `DELETE /:resource/:id/:relation/:relId`, and `POST /:resource/select` with an
// `input`) used to pass the body straight through, checking only that the
// caller could update the *source*. A caller could then:
//
// - delete, restore, update or re-link rows of a model whose permissions deny
//   it;
// - write fields its create input leaves out;
// - filter those rows on hidden fields or with ORM operators.
//
// This walks the input the way GraphQL's types would constrain it and refuses
// anything they would not have, returning a copy whose columns are the parsed
// zod output.

import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { isInputFieldAllowed, isModelAllowed, isRelationshipAllowed, isRelationshipVerbAllowed } from "@azerothian/utilize";
import type { Association, Permission, RelationshipVerb } from "@azerothian/utilize";
import type { Ormize } from "@azerothian/ormize";
import type { z } from "zod";

export type RelationshipInputHost = {
  orm: Ormize;
  permission?: Permission;
  /** The zod schema a model's create or update input is held to, if it has one. */
  schema: (name: string, kind: "create" | "update") => z.ZodObject<z.ZodRawShape> | undefined;
  /** Refuse a filter on a field or with an operator the caller may not use (throws). */
  assertFilterAllowed: (name: string, where: unknown) => void;
};

type Plain = { [key: string]: unknown };

const VERBS: readonly RelationshipVerb[] = ["create", "update", "add", "set", "remove", "delete", "restore", "select"];

function isPlain(value: unknown): value is Plain {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function bad(message: string): never {
  throw new BadRequestException(message);
}

/** Every entry of a verb's value, which is one entry on a to-one relationship and a list on a to-many. */
function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Map a verb's entries, keeping the value's shape (one entry or a list). */
function mapEntries(value: unknown, fn: (entry: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(fn) : fn(value);
}

function onlyKeys(entry: Plain, allowed: string[], where: string) {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) {
      bad(`Unknown key '${key}' in ${where}`);
    }
  }
}

/**
 * Check one model's input: columns against its zod schema, strictly, so a
 * column the schema leaves out (denied, a primary key, a non-writable foreign
 * key) is refused rather than dropped; relationships recursively.
 */
export function checkInputTree(host: RelationshipInputHost, name: string, input: unknown, kind: "create" | "update"): Plain {
  if (!isPlain(input)) {
    return bad(`The ${name} input must be an object`);
  }
  const associations = host.orm.getAssociations(name) || {};
  const columns: Plain = {};
  const out: Plain = {};
  for (const key of Object.keys(input)) {
    if (Object.hasOwn(associations, key)) {
      out[key] = checkRelationship(host, name, key, associations[key], input[key], kind);
    } else {
      columns[key] = input[key];
    }
  }
  if (Object.keys(columns).length > 0) {
    const schema = host.schema(name, kind);
    if (!schema) {
      throw new ForbiddenException(`${kind === "create" ? "Create" : "Update"} not allowed for ${name}`);
    }
    const parsed = schema.strict().safeParse(columns);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      bad(`${name}: ${issue?.path.join(".") || "input"}: ${issue?.message || "invalid"}`);
    }
    Object.assign(out, parsed.data);
  } else if (kind === "create") {
    // A create still has to satisfy its required columns.
    const schema = host.schema(name, kind);
    if (!schema) {
      throw new ForbiddenException(`Create not allowed for ${name}`);
    }
    const parsed = schema.strict().safeParse({});
    if (!parsed.success) {
      bad(`${name}: ${parsed.error.issues[0]?.path.join(".") || "input"}: ${parsed.error.issues[0]?.message || "invalid"}`);
    }
  }
  return out;
}

function checkRelationship(
  host: RelationshipInputHost, name: string, relName: string, association: Association, value: unknown, kind: "create" | "update",
): Plain {
  const target = association.target;
  if (!isRelationshipAllowed(host.permission, name, relName, target) || !isModelAllowed(host.permission, target)) {
    bad(`Unknown relationship '${relName}' on ${name}`);
  }
  if (!isInputFieldAllowed(host.permission, name, relName, kind)) {
    throw new ForbiddenException(`'${relName}' cannot be written on a ${name} ${kind}`);
  }
  if (!isPlain(value)) {
    return bad(`'${relName}' takes an object of relationship operations`);
  }
  const out: Plain = {};
  for (const key of Object.keys(value)) {
    const verb = VERBS.find((v) => v === key);
    if (!verb) {
      bad(`Unknown relationship operation '${key}' on '${relName}'`);
    }
    if (!isRelationshipVerbAllowed(host.permission, association, verb)) {
      throw new ForbiddenException(`'${verb}' on '${relName}' is not allowed for ${target}`);
    }
    out[verb] = checkVerb(host, association, relName, verb, value[verb]);
  }
  return out;
}

function checkVerb(host: RelationshipInputHost, association: Association, relName: string, verb: RelationshipVerb, value: unknown): unknown {
  const target = association.target;
  const filter = (where: unknown) => {
    if (where !== undefined && !isPlain(where)) {
      bad(`A filter in '${relName}.${verb}' must be an object`);
    }
    host.assertFilterAllowed(target, where);
    return where;
  };
  switch (verb) {
    case "create":
      return mapEntries(value, (entry) => checkInputTree(host, target, entry, "create"));
    case "update":
    case "select":
      return mapEntries(value, (entry) => {
        if (!isPlain(entry)) {
          return bad(`'${relName}.${verb}' takes { where, input }`);
        }
        onlyKeys(entry, verb === "update" ? ["where", "input", "limit"] : ["where", "input"], `'${relName}.${verb}'`);
        const out: Plain = { ...entry };
        out.where = filter(entry.where);
        if (entry.input !== undefined) {
          out.input = checkInputTree(host, target, entry.input, "update");
        }
        return out;
      });
    case "remove":
      // A to-one `remove` is a flag.
      if (typeof value === "boolean") {
        return value;
      }
      return mapEntries(value, filter);
    case "add":
    case "set":
      if (association.associationType === "belongsToMany") {
        // Each entry is `{ where, through }`: the rows to link, and join-row data.
        return mapEntries(value, (entry) => {
          if (!isPlain(entry)) {
            return bad(`'${relName}.${verb}' takes { where, through }`);
          }
          onlyKeys(entry, ["where", "through"], `'${relName}.${verb}'`);
          return { ...entry, where: filter(entry.where) };
        });
      }
      return mapEntries(value, filter);
    case "delete":
    case "restore":
      entries(value).forEach(filter);
      return value;
  }
}
