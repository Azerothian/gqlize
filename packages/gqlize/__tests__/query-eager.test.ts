import {graphql, GraphQLSchema} from "graphql";
import {createInstance, resultData, validateResult} from "./helper";
import {createSchema} from "../src";
import {describe, it, expect} from "@jest/globals";
import {Ormize as Database} from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";

// NOTE: the test TaskItem model validates `name` as alphanumeric, 8-50 chars.

type Edge<T> = {node: T};
type Connection<T> = {edges: Edge<T>[]; total?: number};

type TaskWithItemsRow = {name: string; items: Connection<{name: string}>};
type TaskModelsResult = {models: {Task: Connection<TaskWithItemsRow>}};

type TaskWithBtmItemsRow = {name: string; btmItems: Connection<{name: string}>};
type TaskBtmModelsResult = {models: {Task: Connection<TaskWithBtmItemsRow>}};

type ItemChildRow = {name: string; children: Connection<{name: string}>};
type ItemGrandchildRow = {name: string; children: Connection<ItemChildRow>};
type ItemModelsResult = {models: {Item: Connection<ItemGrandchildRow>}};

type TaskNameRow = {name: string};
type TaskNamesResult = {models: {Task: Connection<TaskNameRow>}};

type TaskWithItemRow = {name: string; item: {name: string}};
type TaskWithItemResult = {models: {Task: Connection<TaskWithItemRow>}};

async function run<T>(schema: GraphQLSchema, source: string, rootValue?: unknown): Promise<T> {
  const result = await graphql({schema, source, rootValue});
  validateResult(result);
  return resultData<T>(result);
}

// `sequelize`'s public types never declare `.options` on `Sequelize` even
// though it is set in its constructor and read throughout the library — it is
// simply absent from the `.d.ts`, not fenced off. `unknown` names the exact
// shape this test depends on rather than opening the door to anything else.
type SequelizeWithLogging = {options: {logging: (sql: string) => void}};

function captureQueries(instance: Database) {
  const queries: string[] = [];
  const adapter = instance.getModelAdapter("Task");
  if (!(adapter instanceof SequelizeAdapter)) {
    throw new Error("Expected the Task adapter to be a SequelizeAdapter");
  }
  (adapter.sequelize as unknown as SequelizeWithLogging).options.logging = (sql) => queries.push(sql);
  return {
    queries,
    selects: () => queries.filter((q) => /SELECT/i.test(q)),
  };
}

describe("eager resolution (root-level include from selection)", () => {
  it("loads a nested collection in a batched query, not one-per-parent", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const tasks = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => Task.create({name: `task${n}`}))
    );
    // two items on the first task, one each on the rest
    await TaskItem.create({name: "taskitemaa1", taskId: tasks[0].get("id")});
    await TaskItem.create({name: "taskitembb1", taskId: tasks[0].get("id")});
    for (let i = 1; i < tasks.length; i++) {
      await TaskItem.create({name: `taskitemaa${i + 1}`, taskId: tasks[i].get("id")});
    }

    const schema = await createSchema(instance);
    const cap = captureQueries(instance);
    const {models} = await run<TaskModelsResult>(schema,
      `query { models { Task { edges { node { name items { edges { node { name } } } } } } } }`);

    const edges = models.Task.edges;
    expect(edges).toHaveLength(5);
    const byName: Record<string, string[]> = {};
    for (const e of edges) {
      byName[e.node.name] = e.node.items.edges.map((x) => x.node.name).sort();
    }
    expect(byName.task1).toEqual(["taskitemaa1", "taskitembb1"]);
    expect(byName.task2).toEqual(["taskitemaa2"]);

    // N+1 would be 1 (root) + 5 (per-parent) = 6 SELECTs. Batched `separate:true`
    // loads all items in a single extra query regardless of parent count.
    expect(cap.selects().length).toBeLessThanOrEqual(3);
  });

  it("honors a nested where under a parent query without an include arg (Issue A)", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const task = await Task.create({name: "task1"});
    await TaskItem.create({name: "taskitemkeep", taskId: task.get("id")});
    await TaskItem.create({name: "taskitemdrop", taskId: task.get("id")});

    const schema = await createSchema(instance);
    const {models} = await run<TaskModelsResult>(schema,
      `query { models { Task { edges { node { name
        items(where: { name: { eq: "taskitemkeep" } }) { edges { node { name } } }
      } } } } }`);

    const items = models.Task.edges[0].node.items.edges;
    expect(items).toHaveLength(1);
    expect(items[0].node.name).toEqual("taskitemkeep");
  });

  it("honors nested first (per-parent limit) and reports true total (Issue A)", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const task = await Task.create({name: "task1"});
    await TaskItem.create({name: "taskitemaaa", taskId: task.get("id")});
    await TaskItem.create({name: "taskitembbb", taskId: task.get("id")});
    await TaskItem.create({name: "taskitemccc", taskId: task.get("id")});

    const schema = await createSchema(instance);
    const {models} = await run<TaskModelsResult>(schema,
      `query { models { Task { edges { node { name
        items(first: 2) { total edges { node { name } } }
      } } } } }`);

    const items = models.Task.edges[0].node.items;
    expect(items.edges).toHaveLength(2); // limited per parent
    expect(items.total).toEqual(3); // true total via count
  });

  it("merges a parent include and the nested selection for the same section", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const t1 = await Task.create({name: "task1"});
    await TaskItem.create({name: "taskitem2", taskId: t1.get("id")});
    await TaskItem.create({name: "taskitemother", taskId: t1.get("id")});
    await Task.create({name: "task2"});

    const schema = await createSchema(instance);
    // parent include filters parents (required + where) AND the nested selection is present;
    // both must apply — the include is not clobbered by the auto-generated selection include.
    const {models} = await run<TaskModelsResult>(schema,
      `query { models {
        Task(include: { items: { required: true, where: { name: { eq: "taskitem2" } } } }) {
          edges { node { name items { edges { node { name } } } } }
        }
      } }`);

    const edges = models.Task.edges;
    expect(edges).toHaveLength(1); // required include filtered to task1 only
    expect(edges[0].node.name).toEqual("task1");
    expect(edges[0].node.items.edges).toHaveLength(1);
    expect(edges[0].node.items.edges[0].node.name).toEqual("taskitem2");
  });

  it("eager-loads a belongsToMany relation (JOIN, not separate)", async () => {
    const instance = await createInstance();
    const {Task, Item} = instance.models;
    const task = await Task.create({name: "task1"});
    const item = await Item.create({name: "itemone"});
    await task.addBtmItem(item);

    const schema = await createSchema(instance);
    const {models} = await run<TaskBtmModelsResult>(schema,
      `query { models { Task { edges { node { name
        btmItems { edges { node { name } } }
      } } } } }`);

    const btm = models.Task.edges[0].node.btmItems.edges;
    expect(btm).toHaveLength(1);
    expect(btm[0].node.name).toEqual("itemone");
  });

  it("folds relations requested via a named fragment spread into the auto-include", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const tasks = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => Task.create({name: `task${n}`}))
    );
    for (let i = 0; i < tasks.length; i++) {
      await TaskItem.create({name: `taskitemaa${i + 1}`, taskId: tasks[i].get("id")});
    }

    const schema = await createSchema(instance);
    const cap = captureQueries(instance);
    const {models} = await run<TaskModelsResult>(schema,
      `query {
        models { Task { edges { node { ...TaskFields } } } }
      }
      fragment TaskFields on Task {
        name
        items(where: { name: { eq: "taskitemaa1" } }) { edges { node { name } } }
      }`);

    const edges = models.Task.edges;
    expect(edges).toHaveLength(5);
    // items came through the fragment AND the nested where was honored
    const withItems = edges.filter((e) => e.node.items.edges.length > 0);
    expect(withItems).toHaveLength(1);
    expect(withItems[0].node.items.edges[0].node.name).toEqual("taskitemaa1");
    // still batched (fragment folded into a single separate query, not N+1)
    expect(cap.selects().length).toBeLessThanOrEqual(3);
  });

  it("folds relations requested via an inline fragment into the auto-include", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const task = await Task.create({name: "task1"});
    await TaskItem.create({name: "taskitemkeep", taskId: task.get("id")});
    await TaskItem.create({name: "taskitemdrop", taskId: task.get("id")});

    const schema = await createSchema(instance);
    const {models} = await run<TaskModelsResult>(schema,
      `query { models { Task { edges { node {
        ... on Task {
          name
          items(where: { name: { eq: "taskitemkeep" } }) { edges { node { name } } }
        }
      } } } } }`);

    const items = models.Task.edges[0].node.items.edges;
    expect(items).toHaveLength(1);
    expect(items[0].node.name).toEqual("taskitemkeep");
  });

  it("honors nested where at two relationship levels (selection-driven)", async () => {
    const instance = await createInstance();
    const {Item} = instance.models;
    const root = await Item.create({name: "root1"});
    const childKeep = await Item.create({name: "childkeep", parentId: root.get("id")});
    await Item.create({name: "childdrop", parentId: root.get("id")});
    await Item.create({name: "grandkeep", parentId: childKeep.get("id")});
    await Item.create({name: "granddrop", parentId: childKeep.get("id")});

    const schema = await createSchema(instance);
    const cap = captureQueries(instance);
    const {models} = await run<ItemModelsResult>(schema,
      `query { models {
        Item(where: { name: { eq: "root1" } }) {
          edges { node { name
            children(where: { name: { eq: "childkeep" } }) {
              edges { node { name
                children(where: { name: { eq: "grandkeep" } }) {
                  edges { node { name } }
                }
              } }
            }
          } }
        }
      } }`);

    const rootEdges = models.Item.edges;
    expect(rootEdges).toHaveLength(1);
    const rootNode = rootEdges[0].node;
    expect(rootNode.name).toEqual("root1");

    // level 1 where honored
    expect(rootNode.children.edges).toHaveLength(1);
    const childNode = rootNode.children.edges[0].node;
    expect(childNode.name).toEqual("childkeep");

    // level 2 where honored
    expect(childNode.children.edges).toHaveLength(1);
    expect(childNode.children.edges[0].node.name).toEqual("grandkeep");

    // no pagination -> both levels fold into a single JOINed query, with the
    // WHERE at each level applied in-query.
    expect(cap.selects().length).toEqual(1);
  });

  it("honors nested include statements two levels deep (explicit include arg)", async () => {
    const instance = await createInstance();
    const {Item} = instance.models;
    const root = await Item.create({name: "root1"});
    const childKeep = await Item.create({name: "childkeep", parentId: root.get("id")});
    await Item.create({name: "childdrop", parentId: root.get("id")});
    await Item.create({name: "grandkeep", parentId: childKeep.get("id")});
    await Item.create({name: "granddrop", parentId: childKeep.get("id")});

    const schema = await createSchema(instance);
    const {models} = await run<ItemModelsResult>(schema,
      `query { models {
        Item(
          where: { name: { eq: "root1" } }
          include: {
            children: {
              where: { name: { eq: "childkeep" } }
              include: {
                children: { where: { name: { eq: "grandkeep" } } }
              }
            }
          }
        ) {
          edges { node { name
            children {
              edges { node { name
                children { edges { node { name } } }
              } }
            }
          } }
        }
      } }`);

    const rootEdges = models.Item.edges;
    expect(rootEdges).toHaveLength(1);
    const rootNode = rootEdges[0].node;
    expect(rootNode.name).toEqual("root1");

    // level 1 include/where honored
    expect(rootNode.children.edges).toHaveLength(1);
    const childNode = rootNode.children.edges[0].node;
    expect(childNode.name).toEqual("childkeep");

    // level 2 include/where honored
    expect(childNode.children.edges).toHaveLength(1);
    expect(childNode.children.edges[0].node.name).toEqual("grandkeep");
  });

  it("JOIN and separate:true return identical results at different query counts", async () => {
    const instance = await createInstance();
    const {Item} = instance.models;
    const root = await Item.create({name: "root1"});
    await Item.create({name: "childaa", parentId: root.get("id")});
    await Item.create({name: "childbb", parentId: root.get("id")});
    await Item.create({name: "childcc", parentId: root.get("id")});
    const schema = await createSchema(instance);

    const selection = (extra: string) => `query { models {
      Item(where: { name: { eq: "root1" } }${extra}) {
        edges { node { name children { edges { node { name } } } } }
      }
    } }`;

    // JOIN (default, no pagination): folds into the parent query.
    const joinCap = captureQueries(instance);
    const joinResult = await run<ItemModelsResult>(schema, selection(""));
    const joinSelects = joinCap.selects().length;

    // separate:true forced via the include arg — same selection, same data.
    const sepCap = captureQueries(instance);
    const sepResult = await run<ItemModelsResult>(schema, selection(", include: { children: { separate: true } }"));
    const sepSelects = sepCap.selects().length;

    // normalise child order (JOIN vs separate may order differently without orderBy)
    const normalise = (r: ItemModelsResult) =>
      r.models.Item.edges.map((e) => ({
        name: e.node.name,
        children: e.node.children.edges.map((c) => c.node.name).sort(),
      }));

    // identical results
    expect(normalise(joinResult)).toEqual(normalise(sepResult));
    expect(normalise(joinResult)[0].children).toEqual(["childaa", "childbb", "childcc"]);

    // different query shapes: JOIN = one query, separate = root + one batched child query
    expect(joinSelects).toEqual(1);
    expect(sepSelects).toEqual(2);
  });

  it("fires the child beforeFind filter hook on the eager path (Issue B)", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const task = await Task.create({name: "task1"});
    await TaskItem.create({name: "filterMe", taskId: task.get("id")});
    await TaskItem.create({name: "taskitemvis", taskId: task.get("id")});

    const schema = await createSchema(instance);
    const {models} = await run<TaskModelsResult>(schema,
      `query { models { Task { edges { node { name
        items { edges { node { name } } }
      } } } } }`,
      {filterName: "filterMe"});

    const items = models.Task.edges[0].node.items.edges;
    // TaskItem.beforeFind removes rows named `filterName` — must apply even though
    // items are eager-loaded at the root level.
    expect(items.map((x) => x.node.name)).toEqual(["taskitemvis"]);
  });

  it("required:true on a collection filters parents (INNER JOIN)", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const t1 = await Task.create({name: "task1"});
    const t2 = await Task.create({name: "task2"});
    await TaskItem.create({name: "taskitemkeep", taskId: t1.get("id")});
    await TaskItem.create({name: "taskitemdrop", taskId: t2.get("id")});
    const schema = await createSchema(instance);

    const src = (extra: string) => `query { models { Task { edges { node { name
      items(${extra}where: { name: { eq: "taskitemkeep" } }) { edges { node { name } } }
    } } } } }`;

    // Without required: LEFT JOIN — both tasks returned, task2's items empty.
    const left = await run<TaskModelsResult>(schema, src(""));
    expect(left.models.Task.edges).toHaveLength(2);

    // With required: INNER JOIN — only the task with a matching item.
    const inner = await run<TaskModelsResult>(schema, src("required: true, "));
    expect(inner.models.Task.edges).toHaveLength(1);
    expect(inner.models.Task.edges[0].node.name).toEqual("task1");
    expect(inner.models.Task.edges[0].node.items.edges).toHaveLength(1);
    expect(inner.models.Task.edges[0].node.items.edges[0].node.name).toEqual("taskitemkeep");
  });

  it("required:true without a where returns only parents that have the relation", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const t1 = await Task.create({name: "task1"});
    await Task.create({name: "task2"});
    await TaskItem.create({name: "taskitemone", taskId: t1.get("id")});
    const schema = await createSchema(instance);

    const {models} = await run<TaskNamesResult>(schema,
      `query { models { Task { edges { node { name
        items(required: true) { edges { node { name } } }
      } } } } }`);
    expect(models.Task.edges).toHaveLength(1);
    expect(models.Task.edges[0].node.name).toEqual("task1");
  });

  it("required:true on a single-valued relation filters parents", async () => {
    const instance = await createInstance();
    const {Task, Item} = instance.models;
    const t1 = await Task.create({name: "task1"});
    await Task.create({name: "task2"});
    await Item.create({name: "itemone", taskId: t1.get("id")});
    const schema = await createSchema(instance);

    const {models} = await run<TaskWithItemResult>(schema,
      `query { models { Task { edges { node { name
        item(required: true) { name }
      } } } } }`);
    expect(models.Task.edges).toHaveLength(1);
    expect(models.Task.edges[0].node.name).toEqual("task1");
    expect(models.Task.edges[0].node.item.name).toEqual("itemone");
  });

  it("field-level required matches an explicit include required", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const t1 = await Task.create({name: "task1"});
    const t2 = await Task.create({name: "task2"});
    await TaskItem.create({name: "taskitemkeep", taskId: t1.get("id")});
    await TaskItem.create({name: "taskitemdrop", taskId: t2.get("id")});
    const schema = await createSchema(instance);

    const viaField = await run<TaskModelsResult>(schema,
      `query { models { Task { edges { node { name
        items(required: true, where: { name: { eq: "taskitemkeep" } }) { edges { node { name } } }
      } } } } }`);
    const viaInclude = await run<TaskModelsResult>(schema,
      `query { models {
        Task(include: { items: { required: true, where: { name: { eq: "taskitemkeep" } } } }) {
          edges { node { name items { edges { node { name } } } } }
        }
      } }`);
    const names = (r: TaskModelsResult) => r.models.Task.edges.map((e) => e.node.name);
    expect(names(viaField)).toEqual(["task1"]);
    expect(names(viaInclude)).toEqual(["task1"]);
  });
});
