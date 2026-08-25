import { graphql } from "graphql";
import { toGlobalId } from "graphql-relay";
import { describe, it, expect } from "@jest/globals";
import { createInstance, resultData, validateResult } from "../helper";
import { createSchema } from "../../src";

/** The shapes these queries select, named once rather than cast per assertion. */
type TaskItemRows = {models: {TaskItem: {id: string; taskId: string}[]}};
type TaskItemTotal = {models: {TaskItem: {total: number}}};
type TaskTotal = {models: {Task: {total: number}}};
type NodeResult = {node: {id: string; name?: string} | null};

/**
 * Two decode bugs that the codec seam closes. Both are silent — neither raised
 * an error, both wrote or matched the wrong row. See #42.
 */
describe("id decode regressions", () => {
  // Bug 1: `fromGlobalId("42")` returns `{type: "", id: ""}` rather than
  // throwing, and the empty string was written straight through.
  it("leaves a raw key alone instead of writing an empty string", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const task = await instance.models.Task.create({name: "target"});
    const raw = `${task.id}`;

    const created = await graphql({schema, source: `mutation {
      models { TaskItem(create: {name: "testitem", taskId: "${raw}"}) { id taskId } }
    }`});
    validateResult(created);
    // The raw key is not a global id, so it survives as the key it looks like —
    // it used to decode to `""` and be written as an empty foreign key.
    expect(resultData<TaskItemRows>(created).models.TaskItem[0].taskId).toEqual(toGlobalId("Task", raw));

    const row = await instance.models.TaskItem.findOne({where: {name: "testitem"}});
    expect(`${row.taskId}`).toEqual(raw);
  });

  it("leaves a raw key alone in an update input", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const task = await instance.models.Task.create({name: "target"});
    const item = await instance.models.TaskItem.create({name: "testitem"});
    const raw = `${task.id}`;

    const updated = await graphql({schema, source: `mutation {
      models { TaskItem(update: {where: {id: {eq: "${toGlobalId("TaskItem", item.id)}"}}, input: {taskId: "${raw}"}}) {
        id taskId
      } }
    }`});
    validateResult(updated);
    expect(resultData<TaskItemRows>(updated).models.TaskItem[0].taskId).toEqual(toGlobalId("Task", raw));
    const row = await instance.models.TaskItem.findOne({where: {name: "testitem"}});
    expect(`${row.taskId}`).toEqual(raw);
  });

  it("leaves a raw key alone in a where filter", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const task = await instance.models.Task.create({name: "target"});
    await instance.models.TaskItem.create({name: "testitem", taskId: task.id});

    const found = await graphql({schema, source: `query {
      models { TaskItem(where: {taskId: {eq: "${task.id}"}}) { total } }
    }`});
    validateResult(found);
    expect(resultData<TaskItemTotal>(found).models.TaskItem.total).toEqual(1);
  });

  // Bug 2: the type half was decoded and thrown away, so a global id minted for
  // one model was accepted wherever another model's key was expected — and
  // matched whatever unrelated row happened to share the numeric key.
  it("refuses a global id minted for a different type", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const task = await instance.models.Task.create({name: "target"});
    await instance.models.TaskItem.create({name: "testitem", taskId: task.id});
    // Same numeric key, wrong type.
    const wrongType = toGlobalId("Item", `${task.id}`);

    const found = await graphql({schema, source: `query {
      models { TaskItem(where: {taskId: {eq: "${wrongType}"}}) { total } }
    }`});
    validateResult(found);
    // Undecoded, the base64 string is compared literally and matches nothing —
    // rather than silently filtering on Task ${task.id}.
    expect(resultData<TaskItemTotal>(found).models.TaskItem.total).toEqual(0);

    const right = await graphql({schema, source: `query {
      models { TaskItem(where: {taskId: {eq: "${toGlobalId("Task", `${task.id}`)}"}}) { total } }
    }`});
    validateResult(right);
    expect(resultData<TaskItemTotal>(right).models.TaskItem.total).toEqual(1);
  });

  it("refuses a cross-type global id on a primary key", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const task = await instance.models.Task.create({name: "target"});

    const found = await graphql({schema, source: `query {
      models { Task(where: {id: {eq: "${toGlobalId("TaskItem", `${task.id}`)}"}}) { total } }
    }`});
    validateResult(found);
    expect(resultData<TaskTotal>(found).models.Task.total).toEqual(0);
  });

  // `node(id:)` is the one place a cross-type id is not an error — the id *is*
  // the type declaration there.
  it("still resolves node(id:) for any type", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const task = await instance.models.Task.create({name: "target"});
    const found = await graphql({schema, source:
      `query { node(id: "${toGlobalId("Task", `${task.id}`)}") { id ... on Task { name } } }`});
    validateResult(found);
    expect(resultData<NodeResult>(found).node!.name).toEqual("target");
  });

  it("returns null from node(id:) for something that is not a global id", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const found = await graphql({schema, source: `query { node(id: "42") { id } }`});
    validateResult(found);
    expect(resultData<NodeResult>(found).node).toBeNull();
  });
});
