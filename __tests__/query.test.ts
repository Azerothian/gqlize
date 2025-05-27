import {graphql} from "graphql";
import {createInstance, validateResult} from "./helper";
import {createSchema} from "../src/graphql/index";
import waterfall from "../src/utils/waterfall";

import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";
import {toGlobalId} from "graphql-relay";
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
    const result = await graphql({schema, source: "query { models { Task { edges { node { id, name } } } } }"}) as any;
    validateResult(result);
    return expect(result.data.models.Task.edges).toHaveLength(3);
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
    const result = await graphql({schema, source:query}) as any;
    validateResult(result);
    return expect(result.data.classMethods.Task.getHiddenData.hidden).toEqual("Hi");
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
    const result = await graphql({schema, source:query}) as any;
    validateResult(result);
    return expect(result.data.classMethods.Task.reverseNameArray[0].name).toEqual("reverseName4");
  });
  it("override", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const {Task} = instance.models;
    await Task.create({
      name: "item1",
      options: JSON.stringify({"hidden": "invisibot"}),
    });
    const result = await graphql({schema, source:"query { models { Task { edges { node { id, name, options {hidden} } } } } }"}) as any;
    validateResult(result);
    // console.log("result", result.data.models.Task[0]);
    return expect(result.data.models.Task.edges[0].node.options.hidden).toEqual("invisibot");
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
    const result = await graphql({schema, source:`query {
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
    }`, rootValue:{filterName: "filterMe"}}) as any;

    validateResult(result);
    return expect(result.data.models.Task.edges[0].node.items.edges).toHaveLength(0);
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
    const result = await graphql({schema, source:`{
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
    `}) as any;
    validateResult(result);
    expect(result.data.models.Task.edges[0].node.testInstanceMethod[0].name).toEqual("item11");
    expect(result.data.models.Task.edges[1].node.testInstanceMethod[0].name).toEqual("item21");
    expect(result.data.models.Task.edges[2].node.testInstanceMethod[0].name).toEqual("item31");
    return expect(result.data.models.Task.edges).toHaveLength(3);
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
    const result = await graphql({schema, source:"query { models { Task { edges { node { id, name, items(orderBy: idASC) {edges {node{id, name}}} } } } } }"}) as any;
    validateResult(result);
    expect(result.data.models.Task.edges[0].node.name).toEqual("task1");
    expect(result.data.models.Task.edges[0].node.items.edges).toHaveLength(3);
    return expect(result.data.models.Task.edges[0].node.items.edges[0].node.name).toEqual("taskitem1");
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
    const result = await graphql({schema, source:"query { models { Task { edges { node { id, name, items(orderBy: idDESC) {edges {node{id, name}}} } } } } }"}) as any;
    validateResult(result);
    expect(result.data.models.Task.edges[0].node.name).toEqual("task1");
    expect(result.data.models.Task.edges[0].node.items.edges).toHaveLength(3);
    return expect(result.data.models.Task.edges[0].node.items.edges[0].node.name).toEqual("taskitem3");
  });
  it("orderBy values", async() => {
    const instance = await createInstance();
    // const {TaskItem} = instance.models;
    // const fields = TaskItem.$sqlgql.define;
    const schema = await createSchema(instance);
    const result = await graphql({schema, source:"query {__type(name:\"TaskItemOrderBy\") { enumValues {name} }}"}) as any;
    validateResult(result);
    const enumValues = result.data.__type.enumValues.map((x: any) => x.name);// eslint-disable-line
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
    const itemResult = await graphql({schema, source:mutation}) as any;
    validateResult(itemResult);

    const queryResult = await graphql({schema, source:`query {
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
    }`}) as any;
    validateResult(queryResult);
    expect(queryResult.data.models.Item.edges).toHaveLength(1);
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
    const itemResult = await graphql({schema, source:mutation}) as any;
    validateResult(itemResult);

    const queryResult = await graphql({schema, source:`query {
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
    }`}) as any;
    validateResult(queryResult);
    expect(queryResult.data.models.Item.edges).toHaveLength(1);
    expect(queryResult.data.models.Item.edges[0].node.parent).not.toBeNull();
    expect(queryResult.data.models.Item.edges[0].node.children.edges).toHaveLength(1);
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
    const itemResult = await graphql({schema, source:mutation}) as any;
    validateResult(itemResult);

    const queryResult = await graphql({schema, source:`query {
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
    }`}) as any;
    validateResult(queryResult);
    expect(queryResult.data.models.Item.edges).toHaveLength(1);
    expect(queryResult.data.models.Item.edges[0].node).not.toBeNull();
    expect(queryResult.data.models.Item.edges[0].node.name).toBe("item");
    expect(queryResult.data.models.Item.edges[0].node.children.edges).toHaveLength(1);
    expect(queryResult.data.models.Item.edges[0].node.children.edges[0].node.name).toBe("item2");

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
    const itemResult = await graphql({schema, source:mutation}) as  any;
    validateResult(itemResult);

    const queryResult = await graphql({schema, source:`query {
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
    }`}) as any;
    validateResult(queryResult);
    expect(queryResult.data.models.Item.edges).toHaveLength(1);
    expect(queryResult.data.models.Item.edges[0].node.parent).not.toBeNull();

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
  const result = await graphql({schema, source:`query {
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
  }`}) as any;

  validateResult(result);
  expect(result.data.models.Task.edges).toHaveLength(2);
  expect(result.data.models.Task.edges[0].node.name).toEqual("task1");
  expect(result.data.models.Task.edges[0].node.items.edges).toHaveLength(2);
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
  const result = await graphql({schema, source:`query {
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
  }`}) as any;

  validateResult(result);
  expect(result.data.models.Task.edges).toHaveLength(1);
  expect(result.data.models.Task.edges[0].node.name).toEqual("task1");
  expect(result.data.models.Task.edges[0].node.items.edges).toHaveLength(1);
  expect(result.data.models.Task.edges[0].node.items.edges[0].node.name).toEqual("taskitem2");
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
  const result = await graphql({schema, source:`query {
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
  }`}) as any;

  validateResult(result);
  expect(result.data.models.Task.edges).toHaveLength(1);
  expect(result.data.models.Task.edges[0].node.name).toEqual("task1");
  expect(result.data.models.Task.edges[0].node.items.edges).toHaveLength(2);
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
  const result = await graphql({schema, source:`query {
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
  }`}) as any;

  validateResult(result);
  expect(result.data.models.Task.edges).toHaveLength(1);
  expect(result.data.models.Task.edges[0].node.name).toEqual("task1");
  expect(result.data.models.Task.edges[0].node.items.edges).toHaveLength(1);
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
  const model2 = await Task.create({
    name: "task2",
  });
  const schema = await createSchema(instance);
  const result = await graphql({schema, source:`query {
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
  }`}) as any;

  validateResult(result);
  expect(result.data.models.Task.edges).toHaveLength(1);
  expect(result.data.models.Task.edges[0].node.name).toEqual("task2");
  expect(result.data.models.Task.edges[0].node.items.edges).toHaveLength(0);
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
  const model2 = await Task.create({
    name: "task2",
  });
  const schema = await createSchema(instance);
  const result = await graphql({schema, source:`query {
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
  }`}) as any;

  validateResult(result);
  expect(result.data.models.Task.edges).toHaveLength(1);
  expect(result.data.models.Task.edges[0].node.name).toEqual("task2");
  expect(result.data.models.Task.edges[0].node.items.edges).toHaveLength(0);
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
  const result = await graphql({schema, source:`query {
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
}`}) as any;
  validateResult(result);
  const firstItem = result.data.models.TaskItem.edges[0];
  const target = result.data.models.TaskItem.edges[1];
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
}`}) as any;
  const pageTarget = queryResult.data.models.TaskItem.edges[0];
  expect(pageTarget.node.name).toEqual("taskitem2");
});

it("Child to Parent", async() => {
  const instance = await createInstance();
  const { Parent, Child } = instance.models;

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
  const res = await graphql({schema, source:mutation}) as any;
  expect(res.data.models.Parent).toHaveLength(1);

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

  const queryResult = await graphql({schema, source:query}) as any;
  expect(queryResult.data.models.Child.edges[0].node.parent).not.toBeNull();
});
