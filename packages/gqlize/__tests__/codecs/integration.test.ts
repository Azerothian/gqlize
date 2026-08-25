import { graphql, GraphQLSchema } from "graphql";
import { describe, it, expect } from "@jest/globals";
import { createInstance, resultData, validateResult } from "../helper";
import {
  createSchema,
  relayIdCodec, prefixIdCodec, rawIdCodec,
  relayCursorCodec, plainCursorCodec, signedCursorCodec, fallbackCursorCodec,
} from "../../src";
import type { IdCodec, CursorCodec } from "../../src/types";

const PREFIXES = {
  Task: "TSK", TaskItem: "TSKI", Item: "ITM", Parent: "PAR", Child: "CHD", Person: "PSN",
};

const ID_CODECS: [string, IdCodec][] = [
  ["relayIdCodec", relayIdCodec()],
  ["prefixIdCodec", prefixIdCodec({prefixes: PREFIXES, pad: 6})],
  ["rawIdCodec", rawIdCodec()],
];

const CURSOR_CODECS: [string, CursorCodec][] = [
  ["relayCursorCodec", relayCursorCodec()],
  ["plainCursorCodec", plainCursorCodec()],
  ["signedCursorCodec", signedCursorCodec({secret: "s3cret"})],
];

/** The shapes these queries select, named once rather than cast per assertion. */
type TaskWithItems = {models: {Task: {id: string; items: {edges: {node: {id: string; taskId: string}}[]}}[]}};
type TaskItemPage = {models: {TaskItem: {total: number; edges: {node: {id: string}}[]}}};
type TaskRows = {models: {Task: {id: string; name: string}[]}};
type TaskItemRows = {models: {TaskItem: {id: string; taskId: string}[]}};
type NodeResult = {node: {id: string; name: string} | null};
type ChildConnection = {
  total: number;
  pageInfo: {hasNextPage: boolean; hasPreviousPage: boolean};
  edges: {cursor: string; node: {name: string}}[];
};
type ChildPage = {models: {Child: ChildConnection}};

async function run<T>(schema: GraphQLSchema, source: string): Promise<T> {
  const result = await graphql({schema, source});
  validateResult(result);
  return resultData<T>(result);
}

// ---------------------------------------------------------------------------
// The whole id surface, once per shipped codec. Everything here is behaviour the
// default has always had — the point is that swapping the codec does not change
// any of it.
// ---------------------------------------------------------------------------
describe.each(ID_CODECS)("id codec: %s", (name, id) => {
  it("mints ids in its own format and reads them back on pk and fk", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {id});

    const created = await run<TaskWithItems>(schema, `mutation {
      models { Task(create: {name: "test", items: {create: {name: "testitem"}}}) {
        id items { edges { node { id taskId } } }
      } }
    }`);
    const task = created.models.Task[0];
    const item = task.items.edges[0].node;

    expect(task.id).toEqual(id.encode({type: "Task", id: 1, defName: "Task", fieldName: "id"}));
    // A foreign key is minted as the *target's* id, not the parent's.
    expect(item.taskId).toEqual(id.encode({type: "Task", id: 1, defName: "TaskItem", fieldName: "taskId"}));
    expect(id.decode({value: item.taskId})!.id).toEqual("1");

    // ...and the same ids filter.
    const filtered = await run<TaskItemPage>(schema, `query {
      models { TaskItem(where: {taskId: {eq: "${item.taskId}"}}) { total edges { node { id } } } }
    }`);
    expect(filtered.models.TaskItem.total).toEqual(1);
    expect(filtered.models.TaskItem.edges[0].node.id).toEqual(item.id);
  });

  it("accepts its own id in a mutation `where` and in an input foreign key", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {id});
    const created = await run<TaskRows>(schema, `mutation {
      models { Task(create: {name: "first"}) { id } }
    }`);
    const taskId = created.models.Task[0].id;

    const updated = await run<TaskRows>(schema, `mutation {
      models { Task(update: {where: {id: {eq: "${taskId}"}}, input: {name: "renamed"}}) { id name } }
    }`);
    expect(updated.models.Task).toHaveLength(1);
    expect(updated.models.Task[0].name).toEqual("renamed");

    const item = await run<TaskItemRows>(schema, `mutation {
      models { TaskItem(create: {name: "testitem", taskId: "${taskId}"}) { id taskId } }
    }`);
    expect(item.models.TaskItem[0].taskId).toEqual(taskId);
  });

  it(`${name === "rawIdCodec" ? "omits" : "exposes"} the relay node field`, async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {id});
    // A codec that cannot recover a type cannot answer `node(id:)` at all, so
    // the field is not in the schema rather than in it and always null.
    expect(Boolean(schema.getQueryType()!.getFields().node)).toEqual(id.carriesType !== false);
  });
});

// Narrowed rather than branched inside a test: an assertion reached on only one
// branch passes vacuously on the other, and the codec with no `node` field has
// nothing to assert here.
describe.each(ID_CODECS.filter(([, codec]) => codec.carriesType !== false))(
  "id codec: %s — node(id:)", (_name, id) => {
    it("resolves back to the row the id was minted for", async() => {
      const instance = await createInstance();
      const schema = await createSchema(instance, {id});
      const created = await run<TaskRows>(schema, `mutation { models { Task(create: {name: "test"}) { id } } }`);
      const taskId = created.models.Task[0].id;
      const found = await run<NodeResult>(schema, `query { node(id: "${taskId}") { id ... on Task { name } } }`);
      expect(found.node).toEqual({id: taskId, name: "test"});
    });
  });

// ---------------------------------------------------------------------------
// The same for cursors.
// ---------------------------------------------------------------------------
describe.each(CURSOR_CODECS)("cursor codec: %s", (_name, cursor) => {
  const seed = async() => {
    const instance = await createInstance();
    for (let i = 1; i <= 5; i++) {
      await instance.models.Child.create({name: `c${i}`});
    }
    return createSchema(instance, {cursor});
  };

  it("mints cursors in its own format and pages with them", async() => {
    const schema = await seed();
    const page = async(args: string) => (await run<ChildPage>(schema, `query { models {
      Child(${args}, orderBy: nameASC) { total pageInfo { hasNextPage hasPreviousPage } edges { cursor node { name } } }
    } }`)).models.Child;

    const first = await page("first: 2");
    expect(first.edges.map((e) => e.node.name)).toEqual(["c1", "c2"]);
    expect(first.pageInfo).toEqual({hasNextPage: true, hasPreviousPage: false});
    // the cursor really is this codec's output
    const connection = cursor.decode({value: first.edges[0].cursor})!.connection;
    expect(cursor.decode({value: first.edges[0].cursor})).toEqual({connection, index: 0});
    expect(first.edges[1].cursor).toEqual(cursor.encode({connection, index: 1}));

    const next = await page(`first: 2, after: "${first.edges[1].cursor}"`);
    expect(next.edges.map((e) => e.node.name)).toEqual(["c3", "c4"]);
    expect(next.pageInfo).toEqual({hasNextPage: true, hasPreviousPage: true});

    const last = await page(`first: 2, after: "${next.edges[1].cursor}"`);
    expect(last.edges.map((e) => e.node.name)).toEqual(["c5"]);
    expect(last.pageInfo).toEqual({hasNextPage: false, hasPreviousPage: true});
  });

  it("rejects a malformed cursor", async() => {
    const schema = await seed();
    const result = await graphql({schema, source:
      `query { models { Child(first: 1, after: "@@@not-a-cursor@@@") { edges { cursor } } } }`});
    expect(result.errors?.[0]?.message).toEqual("Invalid cursor");
  });

  it("rejects a cursor minted by a different connection", async() => {
    const schema = await seed();
    const forged = cursor.encode({connection: "SomeOtherConnection", index: 1});
    const result = await graphql({schema, source:
      `query { models { Child(first: 1, after: "${forged}") { edges { cursor } } } }`});
    // Either the codec refuses it outright or the connection-name check does.
    expect(result.errors?.[0]?.message).toMatch(/Invalid cursor|does not belong to the .* connection/);
  });
});

describe("cursor codec: signedCursorCodec", () => {
  it("rejects a forged index", async() => {
    const cursor = signedCursorCodec({secret: "s3cret"});
    const instance = await createInstance();
    for (let i = 1; i <= 5; i++) {
      await instance.models.Child.create({name: `c${i}`});
    }
    const schema = await createSchema(instance, {cursor});
    const real = await run<ChildPage>(schema,
      `query { models { Child(first: 1, orderBy: nameASC) { edges { cursor } } } }`);
    const minted = real.models.Child.edges[0].cursor;
    const connection = cursor.decode({value: minted})!.connection;
    // Same connection, an index the server never signed.
    const forged = `${connection}:3.${minted.slice(minted.lastIndexOf(".") + 1)}`;
    const result = await graphql({schema, source:
      `query { models { Child(first: 1, after: "${forged}") { edges { cursor } } } }`});
    expect(result.errors?.[0]?.message).toEqual("Invalid cursor");
  });
});

describe("cursor codec: fallbackCursorCodec", () => {
  it("accepts cursors minted before the swap and mints only in the new format", async() => {
    const previous = relayCursorCodec();
    const next = plainCursorCodec();
    const instance = await createInstance();
    for (let i = 1; i <= 5; i++) {
      await instance.models.Child.create({name: `c${i}`});
    }
    // What the old process handed the client, mid-pagination.
    const before = await createSchema(instance, {cursor: previous});
    const old = await run<ChildPage>(before,
      `query { models { Child(first: 2, orderBy: nameASC) { edges { cursor node { name } } } } }`);
    const oldCursor = old.models.Child.edges[1].cursor;

    const after = await createSchema(instance, {cursor: fallbackCursorCodec(next, previous)});
    const resumed = await run<ChildPage>(after,
      `query { models { Child(first: 2, after: "${oldCursor}", orderBy: nameASC) { edges { cursor node { name } } } } }`);
    expect(resumed.models.Child.edges.map((e) => e.node.name)).toEqual(["c3", "c4"]);
    // The client's next cursor is in the new format.
    expect(next.decode({value: resumed.models.Child.edges[0].cursor})).toEqual({
      connection: previous.decode({value: oldCursor})!.connection,
      index: 2,
    });
  });
});
