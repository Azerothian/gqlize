import Sequelize from "sequelize";
import {graphql, GraphQLSchema} from "graphql";
import type {Definition} from "@azerothian/utilize/types/index";
import {createInstance, resultData, validateResult} from "./helper";
import {captureQueries} from "./helper/sql";
import {createSchema} from "../src";
import {describe, it, expect} from "@jest/globals";

/**
 * Conformance tests for the root execution map — the eager-loading include plan
 * described in `docs/specifications.md` §5.
 *
 * Query reduction is a claim about the *number of SQL statements*, so these
 * assert query counts and SQL shape rather than only the returned data. The
 * existing `query-eager.test.ts` mostly checks data, and where it does count it
 * uses `<= 3`, which passes even when a relation degrades from one JOIN to a
 * separate query — exactly the regression these are here to catch.
 *
 * Several are NEGATIVE: they assert something does not happen. A relation that
 * must not be eager-loaded, a limit that must not be exceeded, a hook that must
 * not fire twice.
 */

type Edge<T> = {node: T};
type Connection<T> = {edges: Edge<T>[]; total?: number; pageInfo?: {hasNextPage: boolean}};
type Named = {name: string};

async function run<T>(schema: GraphQLSchema, source: string): Promise<T> {
  const result = await graphql({schema, source});
  validateResult(result);
  return resultData<T>(result);
}

describe("eager plan — pagination is honoured or the relation is not eager-loaded", () => {
  /**
   * The planner sets `descriptor.limit` whenever `first`/`last` is present, but
   * the Sequelize adapter applies `limit`/`offset` only inside its `separate`
   * branch. `separate` is available only for an unrequired `hasMany`, so for a
   * `belongsToMany` the limit used to be discarded in silence and the JOIN
   * loaded every child row.
   *
   * `first` is the client's only bound on how much a nested connection can
   * return, which is why the planner clamps it in the first place — so ignoring
   * it is an unbounded response, not just a wrong one.
   */
  it("bounds a paginated belongsToMany to `first`", async () => {
    const instance = await createInstance();
    const {Task, Item} = instance.models;
    const task = await Task.create({name: "task1"});
    for (const name of ["itemone", "itemtwo", "itemthree", "itemfour"]) {
      await task.addBtmItem(await Item.create({name}));
    }

    const schema = await createSchema(instance);
    const {models} = await run<{models: {Task: Connection<{btmItems: Connection<Named>}>}}>(schema,
      `query { models { Task { edges { node {
        btmItems(first: 2) { total pageInfo { hasNextPage } edges { node { name } } }
      } } } } }`);

    const btm = models.Task.edges[0].node.btmItems;
    expect(btm.edges).toHaveLength(2);
    expect(btm.total).toEqual(4);
    // Told there is more to fetch. Returning all four rows while reporting
    // `hasNextPage: false` is the failure this pins: the client believes it has
    // seen the whole set and has in fact been handed an unbounded page.
    expect(btm.pageInfo?.hasNextPage).toBe(true);
  });

  /**
   * The same discard, reached the other way: `required` correctly wins over
   * `separate` (a separate query cannot filter parents), and the limit used to
   * go with it.
   */
  it("bounds a paginated hasMany that is also `required`", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const task = await Task.create({name: "task1"});
    for (const name of ["taskitem1", "taskitem2", "taskitem3", "taskitem4"]) {
      await TaskItem.create({name, taskId: task.id});
    }

    const schema = await createSchema(instance);
    const {models} = await run<{models: {Task: Connection<{items: Connection<Named>}>}}>(schema,
      `query { models { Task { edges { node {
        items(first: 2, required: true) { total pageInfo { hasNextPage } edges { node { name } } }
      } } } } }`);

    const items = models.Task.edges[0].node.items;
    expect(items.edges).toHaveLength(2);
    expect(items.total).toEqual(4);
    expect(items.pageInfo?.hasNextPage).toBe(true);
  });

  it("still filters parents when a paginated relation is `required`", async () => {
    // Declining to eager-load must not cost `required` its meaning: a parent
    // with no matching child stays excluded.
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const withItems = await Task.create({name: "haschildren"});
    await TaskItem.create({name: "taskitem1", taskId: withItems.id});
    await Task.create({name: "nochildren"});

    const schema = await createSchema(instance);
    const {models} = await run<{models: {Task: Connection<Named & {items: Connection<Named>}>}}>(schema,
      `query { models { Task { edges { node { name
        items(first: 2, required: true) { edges { node { name } } }
      } } } } }`);

    expect(models.Task.edges.map((e) => e.node.name)).toEqual(["haschildren"]);
  });
});

describe("eager plan — relations fold into the parent query", () => {
  it("folds a hasOne into the parent as a single JOINed SELECT", async () => {
    const instance = await createInstance();
    const {Task, Item} = instance.models;
    for (const name of ["task1", "task2", "task3"]) {
      const task = await Task.create({name});
      await Item.create({name: `item${name}`, taskId: task.id});
    }
    const schema = await createSchema(instance);

    const cap = captureQueries(instance);
    const {models} = await run<{models: {Task: Connection<Named & {item: Named}>}}>(schema,
      `query { models { Task { edges { node { name item { name } } } } } }`);

    expect(models.Task.edges).toHaveLength(3);
    expect(models.Task.edges[0].node.item.name).toContain("item");
    // One statement for three parents — the whole point. Nothing proved this
    // for a singular relation before.
    expect(cap.selects()).toHaveLength(1);
    expect(cap.joins()).toHaveLength(1);
  });

  it("folds a belongsTo into the parent as a single JOINed SELECT", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const task = await Task.create({name: "task1"});
    for (const name of ["taskitem1", "taskitem2", "taskitem3"]) {
      await TaskItem.create({name, taskId: task.id});
    }
    const schema = await createSchema(instance);

    const cap = captureQueries(instance);
    const {models} = await run<{models: {TaskItem: Connection<Named & {task: Named}>}}>(schema,
      `query { models { TaskItem { edges { node { name task { name } } } } } }`);

    expect(models.TaskItem.edges).toHaveLength(3);
    expect(models.TaskItem.edges[0].node.task.name).toEqual("task1");
    expect(cap.selects()).toHaveLength(1);
    expect(cap.joins()).toHaveLength(1);
  });

  it("folds an unpaginated belongsToMany into the parent as a single JOINed SELECT", async () => {
    // `query-eager.test.ts` claims this in a test title and never checks it.
    const instance = await createInstance();
    const {Task, Item} = instance.models;
    const task = await Task.create({name: "task1"});
    for (const name of ["itemone", "itemtwo"]) {
      await task.addBtmItem(await Item.create({name}));
    }
    const schema = await createSchema(instance);

    const cap = captureQueries(instance);
    const {models} = await run<{models: {Task: Connection<{btmItems: Connection<Named>}>}}>(schema,
      `query { models { Task { edges { node { btmItems { edges { node { name } } } } } } } }`);

    expect(models.Task.edges[0].node.btmItems.edges).toHaveLength(2);
    expect(cap.selects()).toHaveLength(1);
    expect(cap.joins()).toHaveLength(1);
  });
});

describe("eager plan — negative: relations that must not be eager-loaded", () => {
  /**
   * `options.autoInclude = false` is the documented per-model opt-out (§5). It is
   * read in exactly one place and, before this, had no test at all — so nothing
   * would have noticed if the gate stopped working.
   */
  it("does not eager-load anything for a model with autoInclude: false", async () => {
    const defs: Definition[] = [
      {
        name: "Ledger",
        define: {name: {type: Sequelize.STRING, allowNull: false}},
        // The switch under test.
        options: {autoInclude: false, tableName: "ledgers"},
        relationships: [{type: "hasMany", model: "Entry", name: "entries", options: {foreignKey: "ledgerId"}}],
      },
      {
        name: "Entry",
        define: {
          name: {type: Sequelize.STRING, allowNull: false},
          ledgerId: {type: Sequelize.INTEGER, allowNull: true},
        },
        options: {tableName: "entries"},
        relationships: [{type: "belongsTo", model: "Ledger", name: "ledger", options: {foreignKey: "ledgerId"}}],
      },
    ];
    const instance = await createInstance(defs);
    const {Ledger, Entry} = instance.models;
    for (const name of ["l1", "l2", "l3"]) {
      const ledger = await Ledger.create({name});
      await Entry.create({name: `e-${name}`, ledgerId: ledger.id});
    }
    const schema = await createSchema(instance);

    const cap = captureQueries(instance, "Ledger");
    const {models} = await run<{models: {Ledger: Connection<Named & {entries: Connection<Named>}>}}>(schema,
      `query { models { Ledger { edges { node { name entries { edges { node { name } } } } } } } }`);

    // The data is still right — falling back is a strategy, not a failure.
    expect(models.Ledger.edges).toHaveLength(3);
    for (const edge of models.Ledger.edges) {
      expect(edge.node.entries.edges).toHaveLength(1);
    }
    // But it cost one query per parent plus the root, which is the whole point
    // of the opt-out. A single JOINed SELECT here would mean the gate is dead.
    expect(cap.selects().length).toBeGreaterThan(1);
    expect(cap.joins()).toHaveLength(0);
  });

  /**
   * The blanket `catch` in `gqlize/src/manager.ts` logs and continues without an
   * include plan. Nothing tested that the request still *resolves* on that path —
   * only that the catch exists.
   */
  it("still answers correctly when the include planner throws", async () => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const task = await Task.create({name: "task1"});
    await TaskItem.create({name: "taskitem1", taskId: task.id});
    const schema = await createSchema(instance);

    // Force the planner to throw at the point it reads associations.
    const original = instance.getAssociations.bind(instance);
    let thrown = 0;
    (instance as unknown as {getAssociations: unknown}).getAssociations = (defName: string) => {
      // Only for the root model's own lookup inside the planner; the resolvers
      // need the real thing or nothing would resolve at all.
      if (defName === "Task" && thrown === 0) {
        thrown++;
        throw new Error("planner boom");
      }
      return original(defName);
    };
    try {
      const {models} = await run<{models: {Task: Connection<Named & {items: Connection<Named>}>}}>(schema,
        `query { models { Task { edges { node { name items { edges { node { name } } } } } } } }`);
      expect(models.Task.edges[0].node.name).toEqual("task1");
      expect(models.Task.edges[0].node.items.edges[0].node.name).toEqual("taskitem1");
    } finally {
      (instance as unknown as {getAssociations: unknown}).getAssociations = original;
    }
    expect(thrown).toEqual(1);
  });

  it("does not re-query a nullable singular relation that was eager-loaded as null", async () => {
    // `resolveSingleRelationship`'s eager check is truthy, so a LEFT-JOINed null
    // falls through to the per-parent accessor — which returns null too, after a
    // wasted round trip. One parent, one SELECT.
    const instance = await createInstance();
    const {Task} = instance.models;
    await Task.create({name: "lonely"});   // no Item, so `item` joins to null
    const schema = await createSchema(instance);

    const cap = captureQueries(instance);
    const {models} = await run<{models: {Task: Connection<Named & {item: Named | null}>}}>(schema,
      `query { models { Task { edges { node { name item { name } } } } } }`);

    expect(models.Task.edges[0].node.item).toBeNull();
    expect(cap.selects()).toHaveLength(1);
  });
});
