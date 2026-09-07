import { graphql } from "graphql";
import Sequelize from "sequelize";
import { toGlobalId } from "graphql-relay";
import { describe, it, expect } from "@jest/globals";
import { createInstance, resultData, validateResult } from "../helper";
import { createSchema } from "../../src";
import type { Definition } from "../../src/types";

/** The shapes these queries select, named once rather than cast per assertion. */
type TaskItemRows = {models: {TaskItem: {id: string; taskId: string}[]}};
type TaskItemTotal = {models: {TaskItem: {total: number}}};
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
  // matched whatever unrelated row happened to share the numeric key. #42 made
  // it stop matching; #65 made it say so, because a filter that quietly returns
  // nothing is indistinguishable from a filter that legitimately found nothing.
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
    expect(found.errors?.[0]?.message).toEqual(
      'gqlize: "TaskItem.taskId" expects a "Task" id, but the id given is a "Item" id');
    expect(found.errors?.[0]?.extensions?.code).toEqual("GLOBAL_ID_TYPE_MISMATCH");

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
    expect(found.errors?.[0]?.message).toEqual(
      'gqlize: "Task.id" expects a "Task" id, but the id given is a "TaskItem" id');
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

/**
 * #65: `Role -> RoleUser <- User`. `belongsToMany` drops the join model's own
 * `id` and makes `roleId`/`userId` its composite primary key, so each column is a
 * primary key *and* a foreign key at once. Typing them by `primaryKey` first — as
 * both the encoder and `globalKeyTargets` used to — minted and demanded
 * `RoleUser` ids for keys that hold `Role` and `User` keys, which no client can
 * ever produce.
 */
describe("a join model's keys carry the type they point at", () => {
  const joinDefs: Definition[] = [
    {
      name: "Role",
      define: {name: {type: Sequelize.STRING, allowNull: true}},
      relationships: [{
        type: "belongsToMany", model: "User", name: "users",
        options: {through: "RoleUser", foreignKey: "roleId", otherKey: "userId"},
      }],
    },
    {
      name: "User",
      define: {name: {type: Sequelize.STRING, allowNull: true}},
      relationships: [{
        type: "belongsToMany", model: "Role", name: "roles",
        options: {through: "RoleUser", foreignKey: "userId", otherKey: "roleId"},
      }],
    },
    {
      name: "RoleUser",
      define: {note: {type: Sequelize.STRING, allowNull: true}},
      relationships: [
        {type: "belongsTo", model: "Role", name: "role", options: {foreignKey: "roleId"}},
        {type: "belongsTo", model: "User", name: "user", options: {foreignKey: "userId"}},
      ],
    },
  ];

  type JoinRows = {models: {RoleUser: {edges: {node: {roleId: string; userId: string}}[]}}};
  type JoinTotal = {models: {RoleUser: {total: number}}};

  const seed = async() => {
    const instance = await createInstance(joinDefs);
    const schema = await createSchema(instance);
    const role = await instance.models.Role.create({name: "admin"});
    const user = await instance.models.User.create({name: "dave"});
    await instance.models.RoleUser.create({roleId: role.id, userId: user.id, note: "n"});
    return {schema, role, user};
  };

  it("mints each key as the type it points at, not as the join model", async() => {
    const {schema, role, user} = await seed();
    const found = await graphql({schema, source: `query {
      models { RoleUser { edges { node { roleId userId } } } }
    }`});
    validateResult(found);
    const [{node}] = resultData<JoinRows>(found).models.RoleUser.edges;
    expect(node.roleId).toEqual(toGlobalId("Role", `${role.id}`));
    expect(node.userId).toEqual(toGlobalId("User", `${user.id}`));
  });

  it("filters on the id the client was handed", async() => {
    const {schema, user} = await seed();
    const found = await graphql({schema, source: `query {
      models { RoleUser(where: {userId: {eq: "${toGlobalId("User", `${user.id}`)}"}}) { total } }
    }`});
    validateResult(found);
    expect(resultData<JoinTotal>(found).models.RoleUser.total).toEqual(1);
  });

  it("raises on the join model's own name, which is what it used to accept", async() => {
    const {schema, user} = await seed();
    const found = await graphql({schema, source: `query {
      models { RoleUser(where: {userId: {eq: "${toGlobalId("RoleUser", `${user.id}`)}"}}) { total } }
    }`});
    expect(found.errors?.[0]?.message).toEqual(
      'gqlize: "RoleUser.userId" expects a "User" id, but the id given is a "RoleUser" id');
  });
});
