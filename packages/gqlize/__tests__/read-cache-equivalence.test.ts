import {GraphQLBoolean, type GraphQLSchema} from "graphql";
import Sequelize, {Op} from "sequelize";
import {describe, it, expect, jest} from "@jest/globals";
import {Ormize, MemoryCacheStore} from "@azerothian/ormize";
import type {ScopePredicate} from "@azerothian/utilize/gate";

import {registerDialectAdapter} from "./helper/dialect";
import {ask} from "./helper";
import PersonModel, {PetModel} from "./helper/models/person";
import {createSchema} from "../src";
import type {Definition} from "../src/types/index";

// The read cache's one promise: a hit is indistinguishable from a miss, and two
// reads that differ in anything that changes the result never share an entry.
//
// So every argument that can change a result gets a variant here: sorting
// (column, multi-column, computed, literal), filters (operators, and/or,
// computed `where`, custom `whereOperators`), cursors in both directions,
// nested relation filters/sorts/windows, `required` joins, the `include`
// argument, exposed-method `input` hooks, count-only, soft-delete modes and a
// per-user row scope. Each variant runs against an engine with no cache to get
// the truth. Then on a cached engine it runs once (miss), once more in reverse
// order (hit, with no adapter calls at all), and again after the same writes
// are applied to both engines.

const NoteDef: Definition = {
  name: "Note",
  define: {
    body: {type: Sequelize.STRING, allowNull: false},
    ownerId: {type: Sequelize.STRING, allowNull: true, writable: true},
  },
  whereOperators: {
    startsWithA: () => ({body: {[Op.like]: "a%"}}),
  },
  whereOperatorTypes: {startsWithA: GraphQLBoolean},
  options: {paranoid: true},
};

/** Notes are per-user. Everything else is unscoped. */
const scope: ScopePredicate = (defName, _operation, _options, context) => {
  if (defName !== "Note") {
    return undefined;
  }
  const user = (context as {user?: string} | undefined)?.user;
  return {where: {ownerId: {eq: user ?? null}}, set: {ownerId: user ?? null}};
};

/**
 * `lazy` turns off root-level eager loading, so every relation resolves through
 * the cached root rows' own accessors (`person.getPets()`) instead of being part
 * of the cached fetch. A restored row has to work as a source just as well.
 */
const lazily = (def: Definition): Definition => ({...def, options: {...def.options, autoInclude: false}});

async function build(cached: boolean, lazy: boolean) {
  const db = new Ormize({
    permission: {scope},
    ...(cached ? {cache: {store: new MemoryCacheStore(), onError: (e: unknown) => { throw e; }}} : {}),
  });
  const adapter = await registerDialectAdapter(db);
  for (const def of lazy ? [lazily(PersonModel), lazily(PetModel), NoteDef] : [PersonModel, PetModel, NoteDef]) {
    await db.addDefinition(def);
  }
  await db.initialise();
  await db.sync();
  const calls = [jest.spyOn(adapter, "findAll"), jest.spyOn(adapter, "count")];
  const schema = await createSchema(db);
  await seed(schema);
  return {db, schema, adapterCalls: () => calls.reduce((n, spy) => n + spy.mock.calls.length, 0)};
}

const run = (schema: GraphQLSchema, source: string, user?: string) => ask(schema, source, user ? {user} : {});

const mutate = (schema: GraphQLSchema, models: string, user?: string) => run(schema, `mutation { models { ${models} } }`, user);

async function seed(schema: GraphQLSchema) {
  await mutate(schema, `Person(create: [
    {firstName: "Ada", lastName: "Lovelace", secret: "s1", pets: {create: [{name: "Tom", kind: "cat"}, {name: "Rex", kind: "dog"}]}},
    {firstName: "Grace", lastName: "Hopper", pets: {create: [{name: "Kit", kind: "cat"}]}},
    {firstName: "Alan", lastName: "Turing"},
    {firstName: "Ada", lastName: "Byron", pets: {create: [{name: "Bo", kind: "dog"}, {name: "Ax", kind: "cat"}, {name: "Zed", kind: "dog"}]}},
    {firstName: "Barbara", lastName: "Liskov", pets: {create: [{name: "Nemo", kind: "fish"}]}}
  ]) { id }`);
  await mutate(schema, `Note(create: [{body: "alpha"}, {body: "beta"}, {body: "apex"}]) { id }`, "u1");
  await mutate(schema, `Note(create: [{body: "acorn"}, {body: "gamma"}]) { id }`, "u2");
  await mutate(schema, `Note(delete: {body: {eq: "beta"}}) { id }`, "u1");
}

type Variant = {name: string, source: string, user?: string};

const people = (args: string, fields = "firstName lastName") =>
  `query { models { Person${args ? `(${args})` : ""} { total edges { cursor node { ${fields} } } } } }`;

function variants(cursors: {afterSecond: string, beforeFourth: string}): Variant[] {
  return [
    // Sorting
    {name: "default order", source: people("")},
    {name: "orderBy column asc", source: people("orderBy: firstNameASC")},
    {name: "orderBy column desc", source: people("orderBy: firstNameDESC")},
    {name: "orderBy multi-column", source: people("orderBy: [firstNameASC, lastNameDESC]")},
    {name: "orderBy multi-column, reversed", source: people("orderBy: [firstNameASC, lastNameASC]")},
    {name: "orderBy computed (fields)", source: people("orderBy: fullNameDESC", "fullName")},
    {name: "orderBy computed (literal)", source: people("orderBy: nameLengthASC", "firstName nameLength")},
    // Filters
    {name: "where eq", source: people(`where: {firstName: {eq: "Ada"}}`)},
    {name: "where ne", source: people(`where: {firstName: {ne: "Ada"}}`)},
    {name: "where in", source: people(`where: {lastName: {in: ["Hopper", "Turing"]}}`)},
    {name: "where notIn", source: people(`where: {lastName: {notIn: ["Hopper", "Turing"]}}`)},
    {name: "where like", source: people(`where: {lastName: {like: "%o%"}}`)},
    {name: "where null", source: people(`where: {secret: {eq: null}}`)},
    {name: "where not null", source: people(`where: {secret: {ne: null}}`)},
    {name: "where and", source: people(`where: {and: [{firstName: {eq: "Ada"}}, {lastName: {like: "B%"}}]}`)},
    {name: "where or", source: people(`where: {or: [{firstName: {eq: "Alan"}}, {lastName: {eq: "Liskov"}}]}`)},
    {name: "where computed (resolve)", source: people(`where: {fullName: {eq: "Ada Byron"}}`)},
    {name: "where computed (column)", source: people(`where: {surname: {eq: "Hopper"}}`)},
    // Paging
    {name: "first", source: people("first: 2, orderBy: lastNameASC")},
    {name: "first after", source: people(`first: 2, after: "${cursors.afterSecond}", orderBy: lastNameASC`)},
    {name: "last", source: people("last: 2, orderBy: lastNameASC")},
    {name: "last before", source: people(`last: 2, before: "${cursors.beforeFourth}", orderBy: lastNameASC`)},
    {name: "first + where + order", source: people(`first: 1, where: {firstName: {eq: "Ada"}}, orderBy: lastNameDESC`)},
    // Count-only
    {name: "count only", source: `query { models { Person { total } } }`},
    {name: "count only + where", source: `query { models { Person(where: {firstName: {eq: "Ada"}}) { total } } }`},
    // Relations
    {name: "nested hasMany", source: people("", "firstName pets { total edges { node { name kind } } }")},
    {name: "nested where", source: people("", `firstName pets(where: {kind: {eq: "cat"}}) { total edges { node { name } } }`)},
    {name: "nested where, other value", source: people("", `firstName pets(where: {kind: {eq: "dog"}}) { total edges { node { name } } }`)},
    {name: "nested orderBy", source: people("", "firstName pets(orderBy: nameDESC) { edges { node { name } } }")},
    {name: "nested window", source: people("", "firstName pets(first: 1, orderBy: nameASC) { total edges { node { name } } }")},
    {name: "nested window, other order", source: people("", "firstName pets(first: 1, orderBy: nameDESC) { total edges { node { name } } }")},
    {name: "nested required", source: people("", `firstName pets(required: true, where: {kind: {eq: "fish"}}) { edges { node { name } } }`)},
    {name: "nested computed where", source: people("", `firstName pets(where: {label: {eq: "dog:Rex"}}) { edges { node { name } } }`)},
    {name: "include argument", source: people(`include: {pets: {required: true, where: {kind: {eq: "dog"}}}}`, "firstName pets { edges { node { name } } }")},
    {name: "belongsTo", source: `query { models { Pet(orderBy: nameASC) { edges { node { name owner { firstName lastName } } } } } }`},
    {name: "belongsTo required + where", source: `query { models { Pet(where: {kind: {eq: "cat"}}) { edges { node { name owner(required: true) { lastName } } } } } }`},
    {name: "relation-backed method", source: people("orderBy: lastNameASC", "petNames")},
    // Exposed-method `input` hooks rewrite the options after the args are built
    {name: "input hook", source: people("", `limited(only: "Grace")`)},
    {name: "input hook, other arg", source: people("", `limited(only: "Alan")`)},
    // Instance methods run on the rows the cache hands back
    {name: "instance method", source: people("orderBy: firstNameASC", "greeting fullName")},
    {name: "instance method + relation", source: people("", "greeting pets { edges { node { label } } }")},
    // Soft delete
    {name: "deleted excluded", source: `query { models { Note(orderBy: bodyASC) { total edges { node { body } } } } }`, user: "u1"},
    {name: "deleted included", source: `query { models { Note(deleted: INCLUDE, orderBy: bodyASC) { total edges { node { body } } } } }`, user: "u1"},
    {name: "deleted only", source: `query { models { Note(deleted: ONLY) { total edges { node { body } } } } }`, user: "u1"},
    // Custom where operator
    {name: "custom operator", source: `query { models { Note(where: {startsWithA: true}, orderBy: bodyASC) { edges { node { body } } } } }`, user: "u1"},
    // Row scope: the same query, three callers
    {name: "scope u1", source: `query { models { Note(orderBy: bodyASC) { total edges { node { body ownerId } } } } }`, user: "u1"},
    {name: "scope u2", source: `query { models { Note(orderBy: bodyASC) { total edges { node { body ownerId } } } } }`, user: "u2"},
    {name: "scope anonymous", source: `query { models { Note(orderBy: bodyASC) { total edges { node { body ownerId } } } } }`},
    {name: "scope u2 custom operator", source: `query { models { Note(where: {startsWithA: true}) { edges { node { body } } } } }`, user: "u2"},
  ];
}

/** Writes that touch every model and relation the variants read. */
async function write(schema: GraphQLSchema) {
  await mutate(schema, `Person(update: {where: {lastName: {eq: "Hopper"}}, input: {lastName: "Hopper-Murray", secret: "s2"}}) { id }`);
  await mutate(schema, `Pet(delete: {name: {eq: "Rex"}}) { id }`);
  await mutate(schema, `Person(update: {where: {lastName: {eq: "Turing"}}, input: {pets: {create: [{name: "Ace", kind: "dog"}]}}}) { id }`);
  await mutate(schema, `Note(create: {body: "aardvark"}) { id }`, "u2");
  await mutate(schema, `Note(restore: {body: {eq: "beta"}}) { id }`, "u1");
  await mutate(schema, `Note(delete: {body: {eq: "apex"}}) { id }`, "u1");
}

async function truth(schema: GraphQLSchema, list: Variant[]) {
  const out: Record<string, unknown> = {};
  for (const v of list) {
    out[v.name] = await run(schema, v.source, v.user);
  }
  return out;
}

describe.each([
  {mode: "eager", lazy: false},
  {mode: "lazy", lazy: true},
])("read cache equivalence ($mode relations)", ({lazy}) => {
  it("serves every result-shaping argument exactly as the database does, before and after writes", async() => {
    const plain = await build(false, lazy);
    const cached = await build(true, lazy);

    // Cursors are deterministic, so the uncached engine can mint them for both.
    const page = await run(plain.schema, people("orderBy: lastNameASC")) as
      {models: {Person: {edges: {cursor: string}[]}}};
    const list = variants({afterSecond: page.models.Person.edges[1].cursor, beforeFourth: page.models.Person.edges[3].cursor});

    const expected = await truth(plain.schema, list);
    // Variants that should differ really do. Otherwise a key collision could hide.
    expect(new Set(Object.values(expected).map((v) => JSON.stringify(v))).size).toBeGreaterThan(list.length * 0.9);

    // Miss.
    for (const v of list) {
      expect({[v.name]: await run(cached.schema, v.source, v.user)}).toEqual({[v.name]: expected[v.name]});
    }
    // Hit, in the other order, without touching the adapter.
    const before = cached.adapterCalls();
    for (const v of [...list].reverse()) {
      expect({[v.name]: await run(cached.schema, v.source, v.user)}).toEqual({[v.name]: expected[v.name]});
    }
    expect(cached.adapterCalls()).toBe(before);

    // The same writes on both engines. Everything has to reflect them.
    await write(plain.schema);
    await write(cached.schema);
    const after = await truth(plain.schema, list);
    const changed = list.filter((v) => JSON.stringify(after[v.name]) !== JSON.stringify(expected[v.name]));
    expect(changed.length).toBeGreaterThan(list.length / 2);
    for (const v of list) {
      expect({[v.name]: await run(cached.schema, v.source, v.user)}).toEqual({[v.name]: after[v.name]});
    }
  });
});
