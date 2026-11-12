import {graphql, GraphQLSchema} from "graphql";
import {createInstance, resultData, validateResult} from "./helper";
import {createSchema} from "../src";
import waterfall from "@azerothian/utilize/utils/waterfall";

import {describe, it, expect, jest} from "@jest/globals";
import Sequelize from "sequelize";
import {toGlobalId} from "graphql-relay";

type Edge<T> = {node: T; cursor?: string};
type Connection<T> = {edges: Edge<T>[]};

type TaskRow = {id: string; name: string};
type TaskModelsResult = {models: {Task: Connection<TaskRow>}};

type TaskWithOptionsRow = {id: string; name: string; options: {hidden?: string}};
type TaskWithOptionsResult = {models: {Task: Connection<TaskWithOptionsRow>}};

type TaskWithItemsRow = {id: string; name: string; items: Connection<{id: string; name?: string}>};
type TaskWithItemsResult = {models: {Task: Connection<TaskWithItemsRow>}};

type TaskWithInstanceMethodRow = {id: string; name: string; testInstanceMethod: {name: string}[]};
type TaskInstanceMethodResult = {models: {Task: Connection<TaskWithInstanceMethodRow>}};

type ClassMethodHiddenResult = {classMethods: {Task: {getHiddenData: {hidden: string}}}};
type ClassMethodReverseArrayResult = {classMethods: {Task: {reverseNameArray: {name: string}[]}}};

type EnumValuesResult = {__type: {enumValues: {name: string}[]}};

type ItemRow = {
  id: string;
  name: string;
  parentId?: string | null;
  children: Connection<{id: string; name: string}>;
  parent?: {id: string; name: string} | null;
};
type ItemModelsResult = {models: {Item: Connection<ItemRow>}};

type ParentMutationResult = {models: {Parent: {id: string; name: string; children: Connection<{parentId: string | null}>}[]}};

type ChildRow = {name: string; parent: {id: string; name: string} | null};
type ChildModelsResult = {models: {Child: Connection<ChildRow>}};

type TaskItemRow = {id: string; name: string};
type TaskItemModelsResult = {models: {TaskItem: Connection<TaskItemRow>}};

async function run<T = unknown>(schema: GraphQLSchema, source: string, rootValue?: unknown): Promise<T> {
  const result = await graphql({schema, source, rootValue});
  validateResult(result);
  return resultData<T>(result);
}

describe("queries", () => {
  it("basic", async() => {
    const instance = await createInstance();
    const {Task} = instance.models;
    await Promise.all([
      Task.create({
        name: "item1",
      }),
      Task.create({
        name: "item2",
      }),
      Task.create({
        name: "item3",
      }),
    ]);
    const schema = await createSchema(instance);
    const {models} = await run<TaskModelsResult>(schema, "query { models { Task { edges { node { id, name } } } } }");
    return expect(models.Task.edges).toHaveLength(3);
  });
  it("classMethod", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);

    const query = `query {
      classMethods {
        Task {
          getHiddenData {
            hidden
          }
        }
      }
    }`;
    const {classMethods} = await run<ClassMethodHiddenResult>(schema, query);
    return expect(classMethods.Task.getHiddenData.hidden).toEqual("Hi");
  });
  it("classMethod - list", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);

    const query = `query {
      classMethods {
        Task {
          reverseNameArray {
            name
          }
        }
      }
    }`;
    const {classMethods} = await run<ClassMethodReverseArrayResult>(schema, query);
    return expect(classMethods.Task.reverseNameArray[0].name).toEqual("reverseName4");
  });
  it("override", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const {Task} = instance.models;
    await Task.create({
      name: "item1",
      options: JSON.stringify({"hidden": "invisibot"}),
    });
    const {models} = await run<TaskWithOptionsResult>(schema, "query { models { Task { edges { node { id, name, options {hidden} } } } } }");
    return expect(models.Task.edges[0].node.options.hidden).toEqual("invisibot");
  });
  it("filter hooks", async() => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const model = await Task.create({
      name: "item1",
    });
    await TaskItem.create({
      name: "filterMe",
      taskId: model.get("id"),
    });
    const schema = await createSchema(instance);
    const {models} = await run<TaskWithItemsResult>(schema, `query {
      models { 
        Task { 
          edges { 
            node { 
              id, 
              name, 
              items { 
                edges { 
                  node { 
                    id 
                  } 
                } 
              } 
            } 
          } 
        } 
      }
    }`, {filterName: "filterMe"});

    return expect(models.Task.edges[0].node.items.edges).toHaveLength(0);
  });
  it("instance method", async() => {
    const instance = await createInstance();
    const {Task} = instance.models;
    await Promise.all([
      Task.create({
        name: "item1",
      }),
      Task.create({
        name: "item2",
      }),
      Task.create({
        name: "item3",
      }),
    ]);
    const schema = await createSchema(instance);
    const {models} = await run<TaskInstanceMethodResult>(schema, `{
      models {
        Task {
          edges {
            node {
              id
              name
              testInstanceMethod(input: {amount: 1}) {
                name
              }
            }
          }
        }
      }
    }
    `);
    expect(models.Task.edges[0].node.testInstanceMethod[0].name).toEqual("item11");
    expect(models.Task.edges[1].node.testInstanceMethod[0].name).toEqual("item21");
    expect(models.Task.edges[2].node.testInstanceMethod[0].name).toEqual("item31");
    return expect(models.Task.edges).toHaveLength(3);
  });
  it("orderBy asc", async() => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const model = await Task.create({
      name: "task1",
    });
    await Promise.all([
      TaskItem.create({
        name: "taskitem1",
        taskId: model.get("id"),
      }),
      TaskItem.create({
        name: "taskitem2",
        taskId: model.get("id"),
      }),
      TaskItem.create({
        name: "taskitem3",
        taskId: model.get("id"),
      }),
    ]);
    const schema = await createSchema(instance);
    const {models} = await run<TaskWithItemsResult>(schema, "query { models { Task { edges { node { id, name, items(orderBy: idASC) {edges {node{id, name}}} } } } } }");
    expect(models.Task.edges[0].node.name).toEqual("task1");
    expect(models.Task.edges[0].node.items.edges).toHaveLength(3);
    return expect(models.Task.edges[0].node.items.edges[0].node.name).toEqual("taskitem1");
  });
  it("orderBy desc", async() => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const model = await Task.create({
      name: "task1",
    });
    await Promise.all([
      TaskItem.create({
        name: "taskitem1",
        taskId: model.get("id"),
      }),
      TaskItem.create({
        name: "taskitem2",
        taskId: model.get("id"),
      }),
      TaskItem.create({
        name: "taskitem3",
        taskId: model.get("id"),
      }),
    ]);
    const schema = await createSchema(instance);
    const {models} = await run<TaskWithItemsResult>(schema, "query { models { Task { edges { node { id, name, items(orderBy: idDESC) {edges {node{id, name}}} } } } } }");
    expect(models.Task.edges[0].node.name).toEqual("task1");
    expect(models.Task.edges[0].node.items.edges).toHaveLength(3);
    return expect(models.Task.edges[0].node.items.edges[0].node.name).toEqual("taskitem3");
  });
  it("orderBy values", async() => {
    const instance = await createInstance();
    // const {TaskItem} = instance.models;
    // const fields = TaskItem.$sqlgql.define;
    const schema = await createSchema(instance);
    const {__type} = await run<EnumValuesResult>(schema, "query {__type(name:\"TaskItemOrderBy\") { enumValues {name} }}");
    const enumValues = __type.enumValues.map((x) => x.name);
    // const fields = instance.getFields();
    // Object.keys(fields).map((field) => {
    //   expect(enumValues).toContain(`${field}ASC`);
    //   expect(enumValues).toContain(`${field}DESC`);
    // });
    expect(enumValues).toContain("createdAtASC");
    expect(enumValues).toContain("createdAtDESC");
    expect(enumValues).toContain("updatedAtASC");
    expect(enumValues).toContain("updatedAtDESC");
    expect(enumValues).toContain("idASC");
    return expect(enumValues).toContain("idDESC");
  });
  it("before hook - filter non-null", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Item(create: [
          {name: "item"},
          {name: "item-null"}
        ]) {
          id,
          name
        }
      }
    }`;
    await run(schema, mutation);

    const {models} = await run<ItemModelsResult>(schema, `query {
      models {
        Item {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }`);
    expect(models.Item.edges).toHaveLength(1);
  });
  it("test relationships - hasMany", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Item(
          create: {
            name: "item"
            children: {
              create: [{ name: "item1", children: { create: [{ name: "item2" }] } }]
            }
          }
        ) {
          id
          name
        }
      }
    }`;
    await run(schema, mutation);

    const {models} = await run<ItemModelsResult>(schema, `query {
      models {
        Item(where: {
          name: {eq:"item1"}
        }) {
          edges {
            node {
              id
              name
              parentId
              children {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
              parent {
                id
                name
              }
            }
          }
        }
      }
    }`);
    expect(models.Item.edges).toHaveLength(1);
    expect(models.Item.edges[0].node.parent).not.toBeNull();
    expect(models.Item.edges[0].node.children.edges).toHaveLength(1);
  });

  it("test relationships - hasMany - inner where", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Item(
          create: {
            name: "item"
            children: {
              create: [{ name: "item1" }, { name: "item2" }]
            }
          }
        ) {
          id
          name
        }
      }
    }`;
    await run(schema, mutation);

    const {models} = await run<ItemModelsResult>(schema, `query {
      models {
        Item(where: {
          name: {eq:"item"}
        }) {
          edges {
            node {
              id
              name
              parentId
              children(where: {name: {eq: "item2"}}) {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    }`);
    expect(models.Item.edges).toHaveLength(1);
    expect(models.Item.edges[0].node).not.toBeNull();
    expect(models.Item.edges[0].node.name).toBe("item");
    expect(models.Item.edges[0].node.children.edges).toHaveLength(1);
    expect(models.Item.edges[0].node.children.edges[0].node.name).toBe("item2");

  });

  
  it("test relationships - belongsTo", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Item(create: {
          name: "item",
          parent: {
            create: {
              name: "item1"
            }
          }
        }) {
          id,
          name
        }
      }
    }`;
    await run(schema, mutation);

    const {models} = await run<ItemModelsResult>(schema, `query {
      models {
        Item(where: {
          name: {eq:"item"}
        }) {
          edges {
            node {
              id
              name
              parentId
              children {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
              parent {
                id
                name
              }
            }
          }
        }
      }
    }`);
    expect(models.Item.edges).toHaveLength(1);
    expect(models.Item.edges[0].node.parent).not.toBeNull();

  });
});


it("include operator - not required", async() => {
  const instance = await createInstance();
  const {Task, TaskItem} = instance.models;
  const model = await Task.create({
    name: "task1",
  });
  await TaskItem.create({
    name: "taskitem1",
    taskId: model.get("id"),
  });

  await TaskItem.create({
    name: "taskitem2",
    taskId: model.get("id"),
  });
  await Task.create({
    name: "task2",
  });
  const schema = await createSchema(instance);
  const {models} = await run<TaskWithItemsResult>(schema, `query {
    models { 
      Task(include: {
        items: {
          required: false
        }
      }) { 
        edges { 
          node { 
            id, 
            name, 
            items { 
              edges { 
                node { 
                  id 
                } 
              } 
            } 
          } 
        } 
      } 
    }
  }`);

  expect(models.Task.edges).toHaveLength(2);
  expect(models.Task.edges[0].node.name).toEqual("task1");
  expect(models.Task.edges[0].node.items.edges).toHaveLength(2);
});


it("include operator - relationship filter", async() => {
  const instance = await createInstance();
  const {Task, TaskItem} = instance.models;
  const model = await Task.create({
    name: "task1",
  });
  await TaskItem.create({
    name: "taskitem1",
    taskId: model.get("id"),
  });

  await TaskItem.create({
    name: "taskitem2",
    taskId: model.get("id"),
  });
  await Task.create({
    name: "task2",
  });
  const schema = await createSchema(instance);
  const {models} = await run<TaskWithItemsResult>(schema, `query {
    models { 
      Task(include: {
        items: {
          required: true
          where: {
            name: {
              eq: "taskitem2"
            }
          }
        }
      }) { 
        edges { 
          node { 
            id, 
            name, 
            items { 
              edges { 
                node { 
                  id
                  name
                } 
              } 
            } 
          } 
        } 
      } 
    }
  }`);

  expect(models.Task.edges).toHaveLength(1);
  expect(models.Task.edges[0].node.name).toEqual("task1");
  expect(models.Task.edges[0].node.items.edges).toHaveLength(1);
  expect(models.Task.edges[0].node.items.edges[0].node.name).toEqual("taskitem2");
});

it("include operator - required", async() => {
  const instance = await createInstance();
  const {Task, TaskItem} = instance.models;
  const model = await Task.create({
    name: "task1",
  });
  await TaskItem.create({
    name: "taskitem1",
    taskId: model.get("id"),
  });

  await TaskItem.create({
    name: "taskitem2",
    taskId: model.get("id"),
  });
  await Task.create({
    name: "task2",
  });
  const schema = await createSchema(instance);
  const {models} = await run<TaskWithItemsResult>(schema, `query {
    models { 
      Task(include: {
        items: {
          required: true
        }
      }) { 
        edges { 
          node { 
            id, 
            name, 
            items { 
              edges { 
                node { 
                  id 
                } 
              } 
            } 
          } 
        } 
      } 
    }
  }`);

  expect(models.Task.edges).toHaveLength(1);
  expect(models.Task.edges[0].node.name).toEqual("task1");
  expect(models.Task.edges[0].node.items.edges).toHaveLength(2);
});

it("include operator - required at every level (#70)", async() => {
  const instance = await createInstance();
  const {Task, Item} = instance.models;
  const other = await Task.create({name: "other"});
  const test = await Task.create({name: "test"});
  const p1 = await Item.create({name: "p1", taskId: other.id});
  const p2 = await Item.create({name: "p2"});
  const p3 = await Item.create({name: "p3", taskId: test.id});
  await Item.create({name: "c1", parentId: p1.id});
  await Item.create({name: "c2", parentId: p2.id});
  await Item.create({name: "c3", parentId: p3.id});
  const schema = await createSchema(instance);
  const include = `include: [{parent: {required: true, include: {task: {required: true, where: {name: {eq: "test"}}}}}}]`;
  type Row = {name: string; parent?: {name: string; task?: {name: string} | null} | null};
  type Result = {models: {Item: Connection<Row> & {total: number}}};
  // Whether or not the selection reaches the nested relation — the selection
  // builds its own plan, which the explicit include has to merge into, not lose.
  for (const node of ["name", "name parent { name }", "name parent { name task { name } }"]) {
    const {models} = await run<Result>(schema, `query {
      models { Item(${include}) { total edges { node { ${node} } } } }
    }`);
    expect(models.Item.edges.map((e) => e.node.name)).toEqual(["c3"]);
    expect(models.Item.total).toEqual(1);
  }
});

it("include operator - required include under a required collection", async() => {
  // Sequelize 6 put the nested join inside the paginated subquery, away from
  // the collection it joins through, and the SQL failed (#70). The adapter's
  // `beforeFindAfterOptions` hook keeps it in the outer query.
  const instance = await createInstance();
  const {Task, Item} = instance.models;
  const test = await Task.create({name: "test"});
  const other = await Task.create({name: "other"});
  const p1 = await Item.create({name: "p1"});
  const p2 = await Item.create({name: "p2"});
  await Item.create({name: "p3"});
  await Item.create({name: "c1", parentId: p1.id, taskId: test.id});
  await Item.create({name: "c2", parentId: p1.id, taskId: other.id});
  await Item.create({name: "c3", parentId: p2.id, taskId: other.id});
  const schema = await createSchema(instance);
  type Result = {models: {Item: Connection<{name: string; children: Connection<{name: string}>}> & {total: number}}};
  // `first: 1` as well: the page has to be counted in parents that pass the
  // filter, not in whatever rows the subquery happened to take first.
  for (const args of ["", "first: 1, "]) {
    const {models} = await run<Result>(schema, `query {
      models { Item(${args}include: [{children: {required: true, include: {task: {required: true, where: {name: {eq: "test"}}}}}}]) {
        total edges { node { name children { edges { node { name } } } } }
      } }
    }`);
    expect(models.Item.edges.map((e) => e.node.name)).toEqual(["p1"]);
    // The INNER JOIN filters the children too, exactly as it does unpaginated.
    expect(models.Item.edges[0].node.children.edges.map((e) => e.node.name)).toEqual(["c1"]);
    expect(models.Item.total).toEqual(1);
  }
});

it("include operator - a relationship whose options.as differs is reached by its name", async() => {
  // The include input, permissions and the output field all key by `name`;
  // the adapter used to register the association under `options.as` instead,
  // so `include: {owner: …}` reached for an association that did not exist.
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const instance = await createInstance([{
      name: "Ticket",
      define: {name: {type: Sequelize.STRING, allowNull: false}},
      relationships: [{type: "belongsTo", model: "Task", name: "owner", options: {as: "user", foreignKey: "taskId"}}],
    }]);
    const {Task, Ticket} = instance.models;
    const task = await Task.create({name: "task1"});
    await Ticket.create({name: "t1", taskId: task.id});
    await Ticket.create({name: "t2"});
    const schema = await createSchema(instance);
    const {models} = await run<{models: {Ticket: Connection<{name: string; owner: {name: string} | null}>}}>(schema, `query {
      models { Ticket(include: [{owner: {required: true}}]) { edges { node { name owner { name } } } } }
    }`);
    expect(models.Ticket.edges.map((e) => e.node)).toEqual([{name: "t1", owner: {name: "task1"}}]);
  } finally {
    warn.mockRestore();
  }
});

it("include operator - where primarykey converted correctly", async() => {
  const instance = await createInstance();
  const {Task, TaskItem} = instance.models;
  const model = await Task.create({
    name: "task1",
  });
  await TaskItem.create({
    name: "taskitem1",
    taskId: model.get("id"),
  });

  const ti2 = await TaskItem.create({
    name: "taskitem2",
    taskId: model.get("id"),
  });
  await Task.create({
    name: "task2",
  });
  const schema = await createSchema(instance);
  const {models} = await run<TaskWithItemsResult>(schema, `query {
    models { 
      Task(include: {
        items: {
          required: true
          where: {
            id: {
              eq: "${toGlobalId("TaskItem", ti2.id)}"
            }
          }
        }
      }) { 
        edges { 
          node { 
            id, 
            name, 
            items { 
              edges { 
                node { 
                  id 
                } 
              } 
            } 
          } 
        } 
      } 
    }
  }`);

  expect(models.Task.edges).toHaveLength(1);
  expect(models.Task.edges[0].node.name).toEqual("task1");
  expect(models.Task.edges[0].node.items.edges).toHaveLength(1);
});


it("where operators - not chained", async() => {
  const instance = await createInstance();
  const {Task, TaskItem} = instance.models;
  const model = await Task.create({
    name: "task1",
  });
  await TaskItem.create({
    name: "item12222222222",
    taskId: model.get("id"),
  });
  await Task.create({
    name: "task2",
  });
  const schema = await createSchema(instance);
  const {models} = await run<TaskWithItemsResult>(schema, `query {
    models { 
      Task(where: {hasNoItems: true}) { 
        edges { 
          node { 
            id, 
            name, 
            items { 
              edges { 
                node { 
                  id 
                } 
              } 
            } 
          } 
        } 
      } 
    }
  }`);

  expect(models.Task.edges).toHaveLength(1);
  expect(models.Task.edges[0].node.name).toEqual("task2");
  expect(models.Task.edges[0].node.items.edges).toHaveLength(0);
});


it("where operators - chained", async() => {
  const instance = await createInstance();
  const {Task, TaskItem} = instance.models;
  const model = await Task.create({
    name: "task1",
  });
  await TaskItem.create({
    name: "item12222222222",
    taskId: model.get("id"),
  });
  await Task.create({
    name: "task2",
  });
  const schema = await createSchema(instance);
  const {models} = await run<TaskWithItemsResult>(schema, `query {
    models { 
      Task(where: {chainTest: true}) { 
        edges { 
          node { 
            id, 
            name, 
            items { 
              edges { 
                node { 
                  id 
                } 
              } 
            } 
          } 
        } 
      } 
    }
  }`);

  expect(models.Task.edges).toHaveLength(1);
  expect(models.Task.edges[0].node.name).toEqual("task2");
  expect(models.Task.edges[0].node.items.edges).toHaveLength(0);
});
it("paging asc", async() => {
  const instance = await createInstance();
  const {Task, TaskItem} = instance.models;
  const model = await Task.create({
    name: "task1",
  });
  await waterfall([{
    name: "taskitem1",
    taskId: model.get("id"),
  }, {
    name: "taskitem2",
    taskId: model.get("id"),
  }, {
    name: "taskitem3",
    taskId: model.get("id"),
  }], (item) => TaskItem.create(item));

  const schema = await createSchema(instance);
  const {models} = await run<TaskItemModelsResult>(schema, `query {
  models {
    TaskItem {
      edges {
        cursor
        node {
          id
          name
        }
      }
    }
  }
}`);
  const firstItem = models.TaskItem.edges[0];
  const target = models.TaskItem.edges[1];
  expect(firstItem.node.name).toEqual("taskitem1");
  expect(target.node.name).toEqual("taskitem2");
  const queryResult = await graphql({schema, source:`query {
  models {
    TaskItem(first: 1, after: "${firstItem.cursor}") {
      edges {
        cursor
        node {
          id
          name
        }
      }
    }
  }
}`});
  const pageResult = resultData<TaskItemModelsResult>(queryResult);
  const pageTarget = pageResult.models.TaskItem.edges[0];
  expect(pageTarget.node.name).toEqual("taskitem2");
});

it("Child to Parent", async() => {
  const instance = await createInstance();
  const { Child } = instance.models;

  const child = await Child.create({
    name: "child1",
  });
  const schema = await createSchema(instance);

  const mutation = `mutation {
    models {
      Parent(create: {
        name: "parent1",
        children: {
          add: {id: {in: ["${toGlobalId("Child", child.id)}"]}}
        }
      }) {
        id
        name
        children {
          edges {
            node {
              parentId
            }
          }
        }
      }
    }
  }`;
  const mutationResult = await graphql({schema, source:mutation});
  const mutationData = resultData<ParentMutationResult>(mutationResult);
  expect(mutationData.models.Parent).toHaveLength(1);

  const query = `
    query {
      models {
        Child {
          edges {
            node {
              name
              parent {
                id
                name
              }
            }
          }
        }
      }
    }
  `;

  const queryResult = await graphql({schema, source:query});
  const queryData = resultData<ChildModelsResult>(queryResult);
  expect(queryData.models.Child.edges[0].node.parent).not.toBeNull();
});
