import fs from "fs";
import path from "path";
import Sequelize from "sequelize";
import { GraphQLString } from "graphql";
import { Ormize as Database } from "@azerothian/ormize";
import { RESOLUTION_TIME_PERMISSION_KEYS, scopeAware, unscoped } from "@azerothian/utilize/gate";
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

import { createSchema } from "../src";
import { createAdapterForDialect, registerTeardown } from "./helper/dialect";

const doc = {
  name: "Doc",
  options: { timestamps: false },
  define: {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: Sequelize.STRING },
    ownerId: { type: Sequelize.INTEGER },
  },
};

async function instanceWith(permission?: unknown) {
  const db = new Database(permission ? { permission } : undefined);
  const { adapter, name, teardown } = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
  await db.addDefinition(doc);
  await db.initialise();
  await db.sync();
  return db;
}

const scopedInstance = () =>
  instanceWith({ scope: () => ({ where: { ownerId: { eq: 1 } } }) });

describe("gqlize - row-level scope, the extend surface (§12)", () => {
  // Sequelize enforces below the engine, so an unannotated extend field is a gap
  // in the documentation of intent and warns (decision 7). The three outcomes
  // here are the whole contract; the ormize suite covers the backend with no
  // hook layer, where the same field throws.
  const warnings: string[] = [];
  let restore = () => undefined as void;
  beforeEach(() => {
    warnings.length = 0;
    const spy = jest.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(String(args[0]));
    });
    restore = () => spy.mockRestore();
  });
  afterEach(() => restore());

  const scopeWarnings = () => warnings.filter((m) => m.includes("extend field"));

  it("warns about an unannotated extend query field", async() => {
    const instance = await scopedInstance();
    await createSchema(instance, {
      extend: { query: { recentDocs: { type: GraphQLString, resolve: () => "x" } } },
    });
    expect(scopeWarnings()).toEqual([expect.stringContaining("query.recentDocs (extend field)")]);
  });

  it("warns about an unannotated extend mutation field", async() => {
    const instance = await scopedInstance();
    await createSchema(instance, {
      extend: { mutation: { touchDoc: { type: GraphQLString, resolve: () => "x" } } },
    });
    expect(scopeWarnings()).toEqual([expect.stringContaining("mutation.touchDoc (extend field)")]);
  });

  it("says nothing about a field that admits it is unscoped", async() => {
    const instance = await scopedInstance();
    await createSchema(instance, {
      extend: { query: { health: unscoped({ type: GraphQLString, resolve: () => "ok" }) } },
    });
    expect(scopeWarnings()).toEqual([]);
  });

  it("says nothing about a field that claims to apply the scope itself", async() => {
    const instance = await scopedInstance();
    await createSchema(instance, {
      extend: { query: { mine: scopeAware({ type: GraphQLString, resolve: () => "ok" }) } },
    });
    expect(scopeWarnings()).toEqual([]);
  });

  it("refuses a field marked both ways, on any backend", async() => {
    const instance = await scopedInstance();
    await expect(createSchema(instance, {
      extend: { query: { both: unscoped(scopeAware({ type: GraphQLString, resolve: () => "ok" })) } },
    })).rejects.toThrow(/marked both scopeAware and unscoped/);
  });

  it("says nothing at all when no row-level scope is configured", async() => {
    const instance = await instanceWith();
    await createSchema(instance, {
      extend: { query: { recentDocs: { type: GraphQLString, resolve: () => "x" } } },
    });
    expect(scopeWarnings()).toEqual([]);
  });
});

describe("gqlize - the schema builder never reads a resolution-time permission key", () => {
  // Decision 2, made structural. `scope` may be async only because it is
  // consulted per request and never at schema build; a builder that read one
  // would have to await it, and the shape of the whole feature would quietly
  // change. This replaces stating that in a comment — the audit above is asked
  // *of ormize* precisely so it stays true.
  const dir = path.join(__dirname, "..", "src", "graphql");

  function sources(from: string): string[] {
    return fs.readdirSync(from, { withFileTypes: true }).reduce((all: string[], entry) => {
      const full = path.join(from, entry.name);
      if (entry.isDirectory()) {
        return all.concat(sources(full));
      }
      return entry.name.endsWith(".ts") ? all.concat(full) : all;
    }, []);
  }

  it.each(RESOLUTION_TIME_PERMISSION_KEYS.map((key) => [key]))(
    "no file under src/graphql reads permission.%s",
    (key) => {
      // Every spelling of a member read off a bag named `permission`, plus the
      // destructuring form. Code that first aliased the bag to some other name
      // would slip through, and that is an acceptable floor: the point is to
      // catch the reading someone would actually write.
      const patterns = [
        new RegExp(`permission\\s*(\\?\\.|\\.)\\s*${key}\\b`),
        new RegExp(`permission\\s*\\??\\.?\\s*\\[\\s*["'\`]${key}["'\`]\\s*\\]`),
        new RegExp(`\\{[^{}]*\\b${key}\\b[^{}]*\\}\\s*=\\s*[^;\\n]*permission`),
      ];
      const offenders = sources(dir).filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return patterns.some((pattern) => pattern.test(source));
      });
      expect(offenders).toEqual([]);
    },
  );

  it("looks at a non-trivial number of files", () => {
    // Without this the assertion above would pass just as happily against a
    // walk that had stopped matching anything.
    expect(sources(dir).length).toBeGreaterThan(10);
  });
});
