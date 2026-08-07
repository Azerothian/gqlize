import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import {graphql} from "graphql";
import {describe, it, expect, beforeAll, afterAll} from "@jest/globals";

import {createInstance, validateResult} from "../helper";
import {createSchema} from "../../src";
import {loadSchema, materializeSchema, snapshotSchema} from "../../src/snapshot";

/**
 * The `roundtrip` jest project already re-runs the functional suites through
 * `snapshotSchema` -> JSON -> `materializeSchema`, but it does that **in
 * memory**: nothing there ever touches a file. So the path an actual deployment
 * takes — `gqlize build --gzip` writes bytes, a server calls `loadSchema` on
 * them — is only proven as far as `printSchema` equality by
 * `staleness.test.ts`, which never executes a query.
 *
 * This suite closes that: real bytes on disk, gzipped exactly as `build --gzip`
 * writes them, loaded back and *executed* against real rows.
 */
describe("a schema loaded from a file on disk", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gqlize-load-runtime-"));
  });
  afterAll(() => rmSync(dir, {recursive: true, force: true}));

  /** write the artifact the way `gqlize build --gzip` does, then load it back */
  async function fromDisk(instance: any, name: string) {
    const path = join(dir, name);
    writeFileSync(path, gzipSync(JSON.stringify(snapshotSchema(await createSchema(instance)))));
    return loadSchema(path, instance);
  }

  it("executes a paginated, ordered query and returns real rows", async() => {
    const instance: any = await createInstance();
    for (const name of ["c3", "c1", "c2"]) {
      await instance.models.Child.create({name});
    }
    const schema = await fromDisk(instance, "query.json.gz");

    const result: any = await graphql({
      schema,
      source: `query { models { Child(first: 2, orderBy: nameASC) {
        total
        pageInfo { hasNextPage hasPreviousPage }
        edges { cursor node { id name } }
      } } }`,
    });
    validateResult(result);

    const {Child} = result.data.models;
    expect(Child.total).toEqual(3);
    // ordering comes from the enum's *internal* value, which SDL cannot carry —
    // getting `c1, c2` back is what proves the JSON IR preserved it
    expect(Child.edges.map((e: any) => e.node.name)).toEqual(["c1", "c2"]);
    expect(Child.pageInfo).toEqual({hasNextPage: true, hasPreviousPage: false});
    expect(typeof Child.edges[0].cursor).toEqual("string");
  });

  it("writes through the loaded schema, hooks and all", async() => {
    const instance: any = await createInstance();
    const schema = await fromDisk(instance, "mutation.json.gz");

    const result: any = await graphql({
      schema,
      source: `mutation { models { Task(create: {name: "fromDisk1"}) {
        id name mutationCheck
      } } }`,
    });
    validateResult(result);

    expect(result.data.models.Task[0].name).toEqual("fromDisk1");
    // the fixture's `before` hook stamps this: the artifact carries field shapes,
    // but the hooks have to come from the live ormize instance at load time
    expect(result.data.models.Task[0].mutationCheck).toEqual("create");

    const rows = await instance.models.Task.findAll({});
    expect(rows).toHaveLength(1);
  });
});

/**
 * Scalars are the one part of a schema that is irreducibly code — `serialize` /
 * `parseValue` / `parseLiteral` cannot be serialised, so the IR stores a
 * registry *key* and both ends look the instance up in `createScalarRegistry`.
 *
 * The fixture already carries one without anybody arranging it: the sequelize
 * adapter maps DATETIME to `GQLTDate`, so every model's `createdAt`/`updatedAt`
 * (and their whole `where` operator inputs) are custom scalars. Nothing
 * previously *coerced a value* through one after a round trip — the structural
 * assertions in `snapshot.test.ts` and the `printSchema` comparisons in
 * `staleness.test.ts` would both still pass if the registry handed back a
 * same-named scalar with no coercion at all.
 */
describe("custom scalars survive the artifact", () => {
  async function roundTrip(instance: any) {
    const artifact = JSON.parse(JSON.stringify(snapshotSchema(await createSchema(instance))));
    return materializeSchema(artifact, instance);
  }

  it("serialises a GQLTDate on the way out", async() => {
    const instance: any = await createInstance();
    const row: any = await instance.models.Child.create({name: "c1"});
    const schema = await roundTrip(instance);

    const result: any = await graphql({
      schema,
      source: "query { models { Child { edges { node { name createdAt updatedAt } } } } }",
    });
    validateResult(result);

    const node = result.data.models.Child.edges[0].node;
    // `graphql()` returns JS values, not JSON — an un-coerced field would come
    // back as the adapter's `Date` instance, so `typeof === "string"` is exactly
    // the assertion that says GQLTDate.serialize ran
    expect(typeof node.createdAt).toEqual("string");
    expect(typeof node.updatedAt).toEqual("string");
    expect(node.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(new Date(node.createdAt).getTime())
      .toEqual(new Date(row.createdAt ?? row.get("createdAt")).getTime());
  });

  it("parses a GQLTDate on the way in, as a literal and as a variable", async() => {
    const instance: any = await createInstance();
    await instance.models.Child.create({name: "c1"});
    const schema = await roundTrip(instance);

    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    // inline in the document -> parseLiteral
    const literal = async(bound: string) => {
      const r: any = await graphql({
        schema,
        source: `query { models { Child(where: {createdAt: {gte: "${bound}"}}) {
          edges { node { name } } } } }`,
      });
      validateResult(r);
      return r.data.models.Child.edges;
    };
    expect(await literal(past)).toHaveLength(1);
    expect(await literal(future)).toHaveLength(0);

    // supplied as a variable -> parseValue, a different function on the scalar
    const variable = async(bound: string) => {
      const r: any = await graphql({
        schema,
        source: `query($d: GQLTDate) { models { Child(where: {createdAt: {gte: $d}}) {
          edges { node { name } } } } }`,
        variableValues: {d: bound},
      });
      validateResult(r);
      return r.data.models.Child.edges;
    };
    expect(await variable(past)).toHaveLength(1);
    expect(await variable(future)).toHaveLength(0);
  });
});
