import {graphql} from "graphql";
import {v4 as uuid} from "uuid";
import {createInstance, resultData, validateResult} from "./helper";
import {createSchema} from "../src";
import {fromGlobalId} from "graphql-relay";
import {describe, it, expect} from "@jest/globals";

type NodeIdTaskId = {id: string; taskId: string};
type TaskItemsResult = {models: {Task: {id: string; items: {edges: {node: NodeIdTaskId}[]}}[]}};
type TaskItemQueryResult = {models: {TaskItem: {edges: {node: NodeIdTaskId}[]}}};
type TaskItemSingleMethodResult = {models: {TaskItem: {edges: {node: {testInstanceMethodSingle: NodeIdTaskId}}[]}}};
type TaskItemArrayMethodResult = {models: {TaskItem: {edges: {node: {testInstanceMethodArray: NodeIdTaskId[]}}[]}}};
type ClassMethodSingleResult = {classMethods: {TaskItem: {getTaskItemsSingle: NodeIdTaskId}}};
type ClassMethodArrayResult = {classMethods: {TaskItem: {getTaskItemsArray: NodeIdTaskId[]}}};
type ClassMethodArrayWithTaskResult = {classMethods: {TaskItem: {getTaskItemsArray: (NodeIdTaskId & {task: {id: string}})[]}}};
type TaskIdResult = {models: {Task: {id: string}[]}};
type NodeResult = {node: {id: string; __typename: string; name?: string} | null};
type ItemRow = {id: string; name: string};
type ItemMutationResult = {models: {Item: ItemRow[]}};
type ItemQueryResult = {models: {Item: {edges: {node: ItemRow & {parent: ItemRow | null; children: {edges: {node: ItemRow}[]}}}[]}}};

describe("relay", () => {
  it("validate foreign key global id conversion - models", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
  models {
    Task(create: { name: "test", items: { create: { name: "testitem" } } }) {
      id
      items {
        edges {
          node {
            id
            taskId
          }
        }
      }
    }
  }
}`;
    const mutationResults = await graphql({schema, source:mutation});
    validateResult(mutationResults);
    const mutationData = resultData<TaskItemsResult>(mutationResults);
    expect(mutationData.models.Task).toHaveLength(1);
    expect(mutationData.models.Task[0].items.edges).toHaveLength(1);
    const mutationTaskId = fromGlobalId(mutationData.models.Task[0].items.edges[0].node.taskId).id;
    expect(mutationTaskId).toEqual("1");
    const query = `query {
  models {
    TaskItem {
      edges {
        node {
          id
          taskId
        }
      }
    }
  }
}`;
    const queryResults = await graphql({schema, source:query});
    validateResult(queryResults);
    const queryData = resultData<TaskItemQueryResult>(queryResults);
    expect(queryData.models.TaskItem.edges).toHaveLength(1);
    const taskId = fromGlobalId(queryData.models.TaskItem.edges[0].node.taskId).id;
    expect(taskId).toEqual("1");
  });
  it("validate foreign key global id conversion - query instanceMethod - single", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
  models {
    Task(create: { name: "test", items: { create: { name: "testitem" } } }) {
      id
      items {
        edges {
          node {
            id
            taskId
          }
        }
      }
    }
  }
}`;
    const mutationResults = await graphql({schema, source:mutation});
    validateResult(mutationResults);
    const mutationData = resultData<TaskItemsResult>(mutationResults);
    expect(mutationData.models.Task).toHaveLength(1);
    expect(mutationData.models.Task[0].items.edges).toHaveLength(1);
    const mutationTaskId = fromGlobalId(mutationData.models.Task[0].items.edges[0].node.taskId).id;
    expect(mutationTaskId).toEqual("1");
    const query = `query {
  models {
    TaskItem {
      edges {
        node {
          testInstanceMethodSingle {
            id,
            taskId
          }
        }
      }
    }
  }
}`;
    const queryResults = await graphql({schema, source:query, contextValue: {instance}});
    validateResult(queryResults);
    const queryData = resultData<TaskItemSingleMethodResult>(queryResults);
    const taskId = fromGlobalId(queryData.models.TaskItem.edges[0].node.testInstanceMethodSingle.taskId).id;
    expect(taskId).toEqual("1");
  });
  it("validate foreign key global id conversion - query instanceMethod - array", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Task(
          create: [
            {
              name: "test"
              items: { create: [{ name: "testitem" }, { name: "testitem2" }] }
            }
          ]
        ) {
          id
          items {
            edges {
              node {
                id
                taskId
              }
            }
          }
        }
      }
    }`;
    const mutationResults = await graphql({schema, source:mutation});
    validateResult(mutationResults);
    const mutationData = resultData<TaskItemsResult>(mutationResults);
    expect(mutationData.models.Task).toHaveLength(1);
    expect(mutationData.models.Task[0].items.edges).toHaveLength(2);
    const mutationTaskId = fromGlobalId(mutationData.models.Task[0].items.edges[0].node.taskId).id;
    expect(mutationTaskId).toEqual("1");
    const query = `query {
      models {
        TaskItem {
          edges {
            node {
              testInstanceMethodArray {
                id,
                taskId
              }
            }
          }
        }
      }
    }`;
    const queryResults = await graphql({schema, source:query, contextValue: {instance}});
    validateResult(queryResults);
    const queryData = resultData<TaskItemArrayMethodResult>(queryResults);
    expect(queryData.models.TaskItem.edges[0].node.testInstanceMethodArray).toHaveLength(2);
    const taskId = fromGlobalId(queryData.models.TaskItem.edges[0].node.testInstanceMethodArray[0].taskId).id;
    expect(taskId).toEqual("1");
  });
  it("validate foreign key global id conversion - query classMethods - single", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
  models {
    Task(create: { name: "test", items: { create: { name: "testitem" } } }) {
      id
      items {
        edges {
          node {
            id
            taskId
          }
        }
      }
    }
  }
}`;
    const mutationResults = await graphql({schema, source:mutation});
    validateResult(mutationResults);
    const mutationData = resultData<TaskItemsResult>(mutationResults);
    expect(mutationData.models.Task).toHaveLength(1);
    expect(mutationData.models.Task[0].items.edges).toHaveLength(1);
    const mutationTaskId = fromGlobalId(mutationData.models.Task[0].items.edges[0].node.taskId).id;
    expect(mutationTaskId).toEqual("1");
    const query = `query {
  classMethods {
    TaskItem {
      getTaskItemsSingle {
        id
        taskId
      }
    }
  }
}`;
    const queryResults = await graphql({schema, source:query, contextValue: {instance}});
    validateResult(queryResults);
    const queryData = resultData<ClassMethodSingleResult>(queryResults);
    const taskId = fromGlobalId(queryData.classMethods.TaskItem.getTaskItemsSingle.taskId).id;
    expect(taskId).toEqual("1");
  });
  it("validate foreign key global id conversion - mutation classMethods - single", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
  models {
    Task(create: { name: "test", items: { create: { name: "testitem" } } }) {
      id
      items {
        edges {
          node {
            id
            taskId
          }
        }
      }
    }
  }
}`;
    const mutationResults = await graphql({schema, source:mutation});
    validateResult(mutationResults);
    const mutationData = resultData<TaskItemsResult>(mutationResults);
    expect(mutationData.models.Task).toHaveLength(1);
    expect(mutationData.models.Task[0].items.edges).toHaveLength(1);
    const mutationTaskId = fromGlobalId(mutationData.models.Task[0].items.edges[0].node.taskId).id;
    expect(mutationTaskId).toEqual("1");
    const query = `mutation {
  classMethods {
    TaskItem {
      getTaskItemsSingle {
        id
        taskId
      }
    }
  }
}`;
    const queryResults = await graphql({schema, source:query, contextValue: {instance}});
    validateResult(queryResults);
    const queryData = resultData<ClassMethodSingleResult>(queryResults);
    const taskId = fromGlobalId(queryData.classMethods.TaskItem.getTaskItemsSingle.taskId).id;
    expect(taskId).toEqual("1");
  });
  it("validate foreign key global id conversion - query classMethods - array", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Task(
          create: {
            name: "test"
            items: { create: [{ name: "testitem" }, { name: "testitem2" }] }
          }
        ) {
          id
          items {
            edges {
              node {
                id
                taskId
              }
            }
          }
        }
      }
    }`;
    const mutationResults = await graphql({schema, source:mutation});
    validateResult(mutationResults);
    const mutationData = resultData<TaskItemsResult>(mutationResults);
    expect(mutationData.models.Task).toHaveLength(1);
    expect(mutationData.models.Task[0].items.edges).toHaveLength(2);
    const mutationTaskId = fromGlobalId(mutationData.models.Task[0].items.edges[0].node.taskId).id;
    expect(mutationTaskId).toEqual("1");
    const query = `query {
  classMethods {
    TaskItem {
      getTaskItemsArray {
        id
        taskId
      }
    }
  }
}`;
    const queryResults = await graphql({schema, source:query, contextValue: {instance}});
    validateResult(queryResults);
    const queryData = resultData<ClassMethodArrayResult>(queryResults);
    expect(queryData.classMethods.TaskItem.getTaskItemsArray).toHaveLength(2);
    const taskId = fromGlobalId(queryData.classMethods.TaskItem.getTaskItemsArray[0].taskId).id;
    expect(taskId).toEqual("1");
  });
  it("validate foreign key global id conversion - mutation classMethods - array", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Task(
          create: {
            name: "test"
            items: { create: [{ name: "testitem" }, { name: "testitem2" }] }
          }
        ) {
          id
          items {
            edges {
              node {
                id
                taskId
              }
            }
          }
        }
      }
    }`;
    const mutationResults = await graphql({schema, source: mutation});
    validateResult(mutationResults);
    const mutationData = resultData<TaskItemsResult>(mutationResults);
    expect(mutationData.models.Task).toHaveLength(1);
    expect(mutationData.models.Task[0].items.edges).toHaveLength(2);
    const mutationTaskId = fromGlobalId(mutationData.models.Task[0].items.edges[0].node.taskId).id;
    expect(mutationTaskId).toEqual("1");
    const query = `mutation {
  classMethods {
    TaskItem {
      getTaskItemsArray {
        id
        taskId
        task {
          id
        }
      }
    }
  }
}`;
    const queryResults = await graphql({schema, source:query, contextValue: {instance}});
    validateResult(queryResults);
    const queryData = resultData<ClassMethodArrayWithTaskResult>(queryResults);
    expect(queryData.classMethods.TaskItem.getTaskItemsArray).toHaveLength(2);
    const taskId = fromGlobalId(queryData.classMethods.TaskItem.getTaskItemsArray[0].taskId).id;
    expect(taskId).toEqual("1");
  });
  it("node id validation", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutationResult = await graphql({schema, source:`mutation {
      models {
        Task(create: {
          name: "test"
        }) {
          id
        }
      }
    }`});
    validateResult(mutationResult);
    const mutationData = resultData<TaskIdResult>(mutationResult);
    const modelId = mutationData.models.Task[0].id;
    const queryResult = await graphql({schema, source:`query testNode($id: ID!) {
      node(id:$id) {
        id, __typename
        ... on Task {
          name
        }
      }
    }`, variableValues: {
      id: modelId,
    }});
    validateResult(queryResult);
    const queryData = resultData<NodeResult>(queryResult);
    expect(queryData.node?.id).toEqual(modelId);
    expect(queryData.node?.name).toEqual("test");
    return expect(queryData.node?.__typename).toEqual("Task"); //eslint-disable-line
  });
  it("node id - redundant convert to global id", async() => {
    try {
      const instance = await createInstance();
      const schema = await createSchema(instance);
      const mutation = `mutation {
        models {
          Item(create: {name: "item1", id: "${uuid()}"}) {
            id, 
            name
          }
        }
      }`;
      const itemResult = await graphql({schema, source:mutation});
      validateResult(itemResult);
      const {models: {Item}} = resultData<ItemMutationResult>(itemResult);
      const itemChildrenMutation = `mutation {
        models {
          Item(create: [
            {name: "item1.1", id: "${uuid()}", parentId: "${Item[0].id}"},
            {name: "item1.2", id: "${uuid()}", parentId: "${Item[0].id}"},
          ]) {
            id
            name
            parent {
              id
              name
            }
          }
        }
      }`;
      const itemChildrenResult = await graphql({schema, source:itemChildrenMutation});
      validateResult(itemChildrenResult);

      const queryResult = await graphql({schema, source:`query {
        models {
          Item(where:{name:{eq:"item1"}}) {
            edges {
              node {
                id
                name
                parent {
                  id
                  name
                }
                children {
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
      }`});
      validateResult(queryResult);
      const queryData = resultData<ItemQueryResult>(queryResult);
      expect(queryData.models.Item.edges[0].node.children.edges).toHaveLength(2);
    } catch(err) {
      console.log("err", err);
    }
  });
});
