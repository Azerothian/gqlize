import {graphql, GraphQLEnumType, GraphQLInputObjectType, GraphQLObjectType} from "graphql";
import {describe, it, expect} from "@jest/globals";

import {createInstance, resultData, validateResult} from "./helper";
import {captureQueries} from "./helper/sql";
import {createSchema} from "../src";
import PersonModel, {PetModel} from "./helper/models/person";
import type {Definition} from "../src/types/index";

/**
 * Each test's query shape differs, so rather than one shared loose alias, each
 * defines the minimal result shape its own query produces and reads it through
 * {@link resultData} (see `./helper`).
 */
type TaskInstanceMethodResult = {models: {Task: {edges: {node: {testInstanceMethod: {name: string}[]}}[]}}};
type PersonFullNameResult = {models: {Person: {edges: {node: {fullName: string}}[]}}};
type PersonGreetingResult = {models: {Person: {edges: {node: {greeting: string}}[]}}};
type PersonEverythingResult = {models: {Person: {edges: {node: {everything: string}}[]}}};
type PersonPetsResult = {models: {Person: {edges: {node: {
  petNames: string;
  pets: {edges: {node: {name: string}}[]};
}}[]}}};
type PersonLimitedResult = {models: {Person: {total: number; edges: {node: {limited: string}}[]}}};
type PersonAliasedLimitedResult = {models: {Person: {edges: {node: {a: string; b: string}}[]}}};
type PersonTotalFullNameResult = {models: {Person: {total: number; edges: {node: {fullName: string}}[]}}};
type PersonPetsFilterResult = {models: {Person: {edges: {node: {
  pets: {total: number; edges: {node: {label: string}}[]};
}}[]}}};
type PersonSurnameResult = {models: {Person: {total: number; edges: {node: {surname: string}}[]}}};
type PersonNameLengthResult = {models: {Person: {edges: {node: {nameLength: number}}[]}}};
type PersonCreateResult = {models: {Person: {firstName: string; secret: string | null}[]}};
type PersonUpdateResult = {models: {Person: {firstName: string; lastName: string}[]}};
type PersonSecretResult = {models: {Person: {secret: string}[]}};
type TaskMutationCheckResult = {models: {Task: {name: string; mutationCheck: string}[]}};

/** The manager the test helper hands back. */
type Instance = Awaited<ReturnType<typeof createInstance>>;

/**
 * `expose.instanceMethods` beyond "call a function on the row": what a method
 * declares it needs loaded, how it shapes the query, how it sorts and filters,
 * and — on the mutation side — how it transforms a row before it is committed.
 */

async function people(instance: Instance) {
  const {Person} = instance.models;
  return Promise.all([
    Person.create({firstName: "John", lastName: "Smith", secret: "s1"}),
    Person.create({firstName: "Ada", lastName: "Lovelace", secret: "s2"}),
    Person.create({firstName: "Zoe", lastName: "Adams", secret: "s3"}),
  ]);
}

const personInstance = (extra: Definition[] = []) => createInstance([PersonModel, PetModel, ...extra]);

describe("exposed instance methods — projection", () => {
  it("loads the columns a method declared even when the selection set never asked for them", async() => {
    // The regression this whole feature starts from: attribute narrowing derives
    // the projection from the selection set, and an exposed method is a field
    // name, not a column — so the columns it reads off `this` were dropped and it
    // saw `undefined`.
    const instance = await createInstance();
    const {Task} = instance.models;
    await Task.create({name: "item1"});
    const schema = await createSchema(instance);
    const cap = captureQueries(instance, "Task");
    const result = await graphql({schema, source: `{
      models { Task { edges { node { testInstanceMethod(input: {amount: 1}) { name } } } } }
    }`});
    validateResult(result);

    const rows = resultData<TaskInstanceMethodResult>(result).models.Task.edges;
    expect(rows[0].node.testInstanceMethod[0].name).toBe("item11");
    // and the fix is in the SQL, not in a fallback: `name` is really selected.
    expect(cap.selects()[0]).toMatch(/\bname\b/);
  });

  it("a method with no implementation is a field produced entirely by `output`", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `{
      models { Person(orderBy: firstNameASC) { edges { node { fullName } } } }
    }`});
    validateResult(result);
    expect(resultData<PersonFullNameResult>(result).models.Person.edges.map((e) => e.node.fullName))
      .toEqual(["Ada Lovelace", "John Smith", "Zoe Adams"]);
  });

  it("runs implementation -> output -> after, in that order", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `{
      models { Person(where: {firstName: {eq: "Ada"}}) { edges { node { greeting } } } }
    }`});
    validateResult(result);
    // `hi Ada` (implementation) -> `HI ADA` (output) -> `HI ADA!` (after)
    expect(resultData<PersonGreetingResult>(result).models.Person.edges[0].node.greeting).toBe("HI ADA!");
  });

  it("`fields: \"*\"` opts the query out of narrowing", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const cap = captureQueries(instance, "Person");
    const result = await graphql({schema, source: `{
      models { Person(where: {firstName: {eq: "Ada"}}) { edges { node { everything } } } }
    }`});
    validateResult(result);
    expect(resultData<PersonEverythingResult>(result).models.Person.edges[0].node.everything).toBe("s2");
    // no attribute list at all — `secret` is loaded despite nothing selecting it
    expect(cap.selects()[0]).toMatch(/\bsecret\b/);
  });

  it("merges a method's declared include with the client's own", async() => {
    const instance = await personInstance();
    const [john] = await people(instance);
    const {Pet} = instance.models;
    await Pet.create({name: "rex", personId: john.get("id")});
    await Pet.create({name: "ari", personId: john.get("id")});
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `{
      models { Person(where: {firstName: {eq: "John"}}) { edges { node {
        petNames
        pets { edges { node { name } } }
      } } } }
    }`});
    validateResult(result);

    const node = resultData<PersonPetsResult>(result).models.Person.edges[0].node;
    // the method's include did not clobber the selection-derived one
    expect(node.petNames).toBe("ari,rex");
    expect(node.pets.edges.map((e) => e.node.name).sort()).toEqual(["ari", "rex"]);
  });
});

describe("exposed instance methods — input hooks", () => {
  it("runs `input` after `definition.before`, and lets it overrule the options", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const trace: string[] = [];
    const result = await graphql({schema, contextValue: {trace}, source: `{
      models { Person(where: {firstName: {eq: "Ada"}}) { total edges { node { limited(only: "Zoe") } } } }
    }`});
    validateResult(result);

    expect(trace).toEqual(["before", "input:limited:Zoe"]);
    // the hook replaced the client's `where` wholesale — and `total` followed it,
    // because the filter was pushed into the query rather than applied after.
    const data = resultData<PersonLimitedResult>(result);
    const edges = data.models.Person.edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].node.limited).toBe("Zoe");
    expect(data.models.Person.total).toBe(1);
  });

  it("runs `input` once per selection occurrence, each seeing its own args", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const trace: string[] = [];
    const result = await graphql({schema, contextValue: {trace}, source: `{
      models { Person { edges { node {
        a: limited(only: "Ada")
        b: limited(only: "Zoe")
      } } } }
    }`});
    validateResult(result);

    expect(trace).toEqual(["before", "input:limited:Ada", "input:limited:Zoe"]);
    // both aliases resolve, each with its own args, once per row
    const data = resultData<PersonAliasedLimitedResult>(result);
    const node = data.models.Person.edges[0].node;
    expect(node.a).toBe("Ada");
    expect(node.b).toBe("Zoe");
    // last hook wins the options, so the row set is Zoe's
    expect(data.models.Person.edges).toHaveLength(1);
  });
});

describe("exposed instance methods — filtering", () => {
  it("filters by a computed field at the root, keeping `total` honest", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `{
      models { Person(where: {fullName: {eq: "Ada Lovelace"}}) { total edges { node { fullName } } } }
    }`});
    validateResult(result);

    const conn = resultData<PersonTotalFullNameResult>(result).models.Person;
    expect(conn.edges.map((e) => e.node.fullName)).toEqual(["Ada Lovelace"]);
    expect(conn.total).toBe(conn.edges.length);
  });

  it("filters by a computed field under `and` / `or`", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `{
      models { Person(where: {or: [
        {fullName: {eq: "Ada Lovelace"}},
        {fullName: {eq: "Zoe Adams"}}
      ]}, orderBy: firstNameASC) { total edges { node { fullName } } } }
    }`});
    validateResult(result);

    const conn = resultData<PersonTotalFullNameResult>(result).models.Person;
    expect(conn.edges.map((e) => e.node.fullName)).toEqual(["Ada Lovelace", "Zoe Adams"]);
    expect(conn.total).toBe(2);
  });

  it("filters by a computed field inside an include", async() => {
    const instance = await personInstance();
    const [john] = await people(instance);
    const {Pet} = instance.models;
    await Pet.create({name: "rex", kind: "dog", personId: john.get("id")});
    await Pet.create({name: "ari", kind: "cat", personId: john.get("id")});
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `{
      models { Person(where: {firstName: {eq: "John"}}) { edges { node {
        pets(where: {label: {eq: "cat:ari"}}) { total edges { node { label } } }
      } } } }
    }`});
    validateResult(result);

    const pets = resultData<PersonPetsFilterResult>(result).models.Person.edges[0].node.pets;
    expect(pets.edges.map((e) => e.node.label)).toEqual(["cat:ari"]);
    expect(pets.total).toBe(1);
  });

  it("the portable `where: \"column\"` form filters on the column it names", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `{
      models { Person(where: {surname: {like: "%dam%"}}) { total edges { node { surname } } } }
    }`});
    validateResult(result);

    const data = resultData<PersonSurnameResult>(result);
    expect(data.models.Person.edges.map((e) => e.node.surname)).toEqual(["Adams"]);
    expect(data.models.Person.total).toBe(1);
  });

  it("offers only the operators a computed filter declared", async() => {
    const instance = await personInstance();
    const schema = await createSchema(instance);
    const where = (schema.getType("GQLTQueryPersonWhere") as GraphQLInputObjectType).getFields();
    expect(Object.keys((where.fullName.type as GraphQLInputObjectType).getFields())).toEqual(["eq"]);
    // an undeclared list is the full vocabulary, as before
    expect(Object.keys((where.firstName.type as GraphQLInputObjectType).getFields()).length).toBeGreaterThan(5);
  });
});

describe("exposed instance methods — ordering", () => {
  it("sorts by a computed multi-column order", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `{
      models { Person(orderBy: fullNameASC) { edges { node { fullName } } } }
    }`});
    validateResult(result);
    // ordered by lastName, then firstName
    expect(resultData<PersonFullNameResult>(result).models.Person.edges.map((e) => e.node.fullName))
      .toEqual(["Zoe Adams", "Ada Lovelace", "John Smith"]);
  });

  it("sorts by a literal expression, in the query rather than in memory", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const cap = captureQueries(instance, "Person");
    const result = await graphql({schema, source: `{
      models { Person(orderBy: nameLengthASC) { edges { node { nameLength } } } }
    }`});
    validateResult(result);

    expect(resultData<PersonNameLengthResult>(result).models.Person.edges.map((e) => e.node.nameLength)).toEqual([9, 10, 12]);
    expect(cap.selects()[0]).toMatch(/ORDER BY LENGTH/i);
  });

  it("contributes both directions to the orderBy enum", async() => {
    const instance = await personInstance();
    const schema = await createSchema(instance);
    const values = (schema.getType("PersonOrderBy") as GraphQLEnumType).getValues().map((v) => v.name);
    expect(values).toEqual(expect.arrayContaining(["fullNameASC", "fullNameDESC", "nameLengthASC", "nameLengthDESC"]));
  });
});

describe("exposed instance methods — permissions", () => {
  it("a denied method contributes neither an enum value nor a where field", async() => {
    const instance = await personInstance();
    const schema = await createSchema(instance, {
      permission: {
        queryInstanceMethods: (defName: string, methodName: string) => methodName !== "classified",
      },
    });
    const values = (schema.getType("PersonOrderBy") as GraphQLEnumType).getValues().map((v) => v.name);
    expect(values).not.toContain("classifiedASC");
    expect(values).not.toContain("classifiedDESC");
    // sortability and filterability each leak a denied field's value
    const where = (schema.getType("GQLTQueryPersonWhere") as GraphQLInputObjectType).getFields();
    expect(where.classified).toBeUndefined();
    // the field itself is gone too, so nothing reaches its `fields: ["secret"]`
    expect((schema.getType("Person") as GraphQLObjectType).getFields().classified).toBeUndefined();
  });

  it("a denied transform is absent from the `apply` input", async() => {
    const instance = await personInstance();
    const schema = await createSchema(instance, {
      permission: {
        mutationInstanceMethods: (defName: string, methodName: string) => methodName !== "classifiedTransform",
      },
    });
    const apply = (schema.getType("GQLTPersonInstanceMutations") as GraphQLInputObjectType).getFields();
    expect(Object.keys(apply)).not.toContain("classifiedTransform");
    expect(Object.keys(apply)).toEqual(expect.arrayContaining(["redact", "rename", "stamp"]));
  });
});

describe("exposed instance methods — pre-commit transforms", () => {
  it("runs a transform against the pending values on create", async() => {
    const instance = await personInstance();
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `mutation {
      models { Person(
        create: [{firstName: "Grace", lastName: "Hopper", secret: "s9"}]
        apply: {redact: true}
      ) { firstName secret } }
    }`});
    validateResult(result);
    const data = resultData<PersonCreateResult>(result);
    expect(data.models.Person[0].firstName).toBe("Grace");
    expect(data.models.Person[0].secret).toBeNull();
  });

  it("runs a transform against the live row on update", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `mutation {
      models { Person(
        update: [{where: {firstName: {eq: "Ada"}}, input: {lastName: "Byron"}}]
        apply: {rename: {to: "Augusta"}}
      ) { firstName lastName } }
    }`});
    validateResult(result);
    expect(resultData<PersonUpdateResult>(result).models.Person).toEqual([{firstName: "Augusta", lastName: "Byron"}]);

    // and it was persisted, not just returned
    const reread = await instance.models.Person.findOne({where: {lastName: "Byron"}});
    expect(reread.get("firstName")).toBe("Augusta");
  });

  it("a transform sees what an earlier transform in the same mutation wrote", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `mutation {
      models { Person(
        update: [{where: {firstName: {eq: "Ada"}}, input: {}}]
        apply: {rename: {to: "Augusta"}, stamp: true}
      ) { firstName secret } }
    }`});
    validateResult(result);
    expect(resultData<PersonSecretResult>(result).models.Person[0].secret).toBe("stamped:Augusta");
  });

  it("runs after `definition.before`, so it gets the last word on the values", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `mutation {
      models { Task(create: [{name: "taskone"}], apply: {markChecked: true}) { name mutationCheck } }
    }`});
    validateResult(result);
    // `definition.before` sets mutationCheck to "create"; the transform overrides it
    expect(resultData<TaskMutationCheckResult>(result).models.Task[0].mutationCheck).toBe("applied");
  });

  it("a no-arg transform is a flag — naming it without asking for it does not run it", async() => {
    const instance = await personInstance();
    await people(instance);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `mutation {
      models { Person(
        update: [{where: {firstName: {eq: "Ada"}}, input: {}}]
        apply: {redact: false}
      ) { secret } }
    }`});
    validateResult(result);
    expect(resultData<PersonSecretResult>(result).models.Person[0].secret).toBe("s2");
  });

  it("a throwing transform rolls the whole mutation back, relationship writes included", async() => {
    const instance = await personInstance();
    const [john] = await people(instance);
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `mutation {
      models { Person(
        update: [{
          where: {firstName: {eq: "John"}},
          input: {lastName: "Changed", pets: {create: [{name: "newpet"}]}}
        }]
        apply: {boom: true}
      ) { firstName } }
    }`});

    expect((result.errors || []).length).toBeGreaterThan(0);
    expect(result.errors![0].message).toMatch(/transform exploded/);

    const reread = await instance.models.Person.findByPk(john.get("id"));
    expect(reread.get("lastName")).toBe("Smith");
    expect(await instance.models.Pet.count()).toBe(0);
  });
});

describe("exposed instance methods — build-time checks", () => {
  it("refuses a method whose name is already a column", async() => {
    const instance = await personInstance([{
      name: "Collide",
      define: {label: {type: PersonModel.define!.firstName.type}},
      expose: {instanceMethods: {query: {label: {type: "String"}}}},
    }]);
    await expect(createSchema(instance)).rejects.toThrow(/already a field on the model/);
  });

  it("refuses a name declared as both a query field and a transform", async() => {
    const instance = await personInstance([{
      name: "Collide2",
      define: {label: {type: PersonModel.define!.firstName.type}},
      expose: {instanceMethods: {
        query: {twice: {type: "String"}},
        mutations: {twice: {}},
      }},
    }]);
    await expect(createSchema(instance)).rejects.toThrow(/both expose.instanceMethods.query and/);
  });
});
