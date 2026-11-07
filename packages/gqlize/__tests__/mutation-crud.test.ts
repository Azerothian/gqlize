// GraphQL mutations, the basics: create/update/delete, `override` inputs, null and
// zero values, class-method mutations, hook variables and the generated input
// fields. Relationship writes are in `mutation-complex.test.ts`.
import {createInstance, resultData, validateResult} from "./helper";
import {graphql} from "graphql";
import Sequelize from "sequelize";
import {toGlobalId} from "graphql-relay";
import { registerDialectAdapter } from "./helper/dialect";
import { Ormize as Database } from "@azerothian/ormize";
import {createSchema} from "../src";
import { Definition } from '../src/types/index';
import {describe, it, expect} from "@jest/globals";
import type {
  Connection,
  TaskRow,
  TaskOptionsRow,
  TaskNullCheckRow,
  TaskIntZeroRow,
  TaskMutationCheckRow,
  TaskItemRow,
  TaskDeleteRow,
  TaskWithTaskItemRow,
  IntrospectionInputFields,
} from "./helper/mutation-types";

describe("mutations", () => {
  it("create", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Task(create: {name: "item1"}) {
          id,
          name
        }
      }
    }`;
    const mutationResult = await graphql({schema, source: mutation});
    validateResult(mutationResult);
    const query = "query { models { Task { edges { node { id, name } } } } }";
    const queryResult = await graphql({schema, source: query});
    validateResult(queryResult);
    return expect(resultData<{models: {Task: Connection<TaskRow>}}>(queryResult).models.Task.edges).toHaveLength(1);
  });
  it("create - set parentid as null", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Item(create: {name: "item1", parentId: null}) {
          id,
          name
        }
      }
    }`;
    const mutationResult = await graphql({schema, source: mutation});
    validateResult(mutationResult);
    const query = "query { models { Item { edges { node { id, name, parentId } } } } }";
    const queryResult = await graphql({schema, source: query});
    validateResult(queryResult);
    return expect(resultData<{models: {Item: Connection<TaskItemRow>}}>(queryResult).models.Item.edges).toHaveLength(1);
  });
  it("update - set parentid as null", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const createMutation = `mutation {
      models {
        Item(create: {name: "item1", parentId: null}) {
          id,
          name
        }
      }
    }`;
    const createMutationResult = await graphql({schema, source: createMutation});
    validateResult(createMutationResult);
    const updateMutation = `mutation {
      models {
        Item(update: { where:{name: {eq: "item1"}}, input: {name: "item2", parentId: null}}) {
          id,
          name
        }
      }
    }`;
    const updateMutationResult = await graphql({schema, source: updateMutation});
    validateResult(updateMutationResult);
    const query = "query { models { Item { edges { node { id, name, parentId } } } } }";
    const queryResult = await graphql({schema, source: query});
    validateResult(queryResult);
    return expect(resultData<{models: {Item: Connection<TaskItemRow>}}>(queryResult).models.Item.edges).toHaveLength(1);
  });
  it("create - override", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Task(create: {name: "item1", options: {hidden: "nowhere"}}) {
          id,
          name
          options {
            hidden
          }
        }
      }
    }`;
    const mutationResult = await graphql({schema, source: mutation});
    validateResult(mutationResult);
    expect(resultData<{models: {Task: TaskOptionsRow[]}}>(mutationResult).models.Task[0].options.hidden).toEqual("nowhere");

    const q = "query { models { Task { edges { node { id, name, options {hidden} } } } } }";
    const queryResult = await graphql({schema, source: q});
    validateResult(queryResult);
    return expect(resultData<{models: {Task: Connection<TaskOptionsRow>}}>(queryResult).models.Task.edges[0].node.options.hidden).toEqual("nowhere");
  });
  it("update - override", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const createMutation = `mutation {
      models {
        Task(create: {name: "item1", options: {hidden: "nowhere"}}) {
          id,
          name
          options {
            hidden
          }
        }
      }
    }`;
    const createMutationResult = await graphql({schema,  source: createMutation});
    validateResult(createMutationResult);
    const id = resultData<{models: {Task: TaskOptionsRow[]}}>(createMutationResult).models.Task[0].id;

    const updateMutation = `mutation {
      models {
        Task(update: {where: {id: {eq: "${id}"}}, input: {options: {hidden2: "nowhere2"}}}) {
          id,
          name
          options {
            hidden
            hidden2
          }
        }
      }
    }`;
    const updateMutationResult = await graphql({schema, source: updateMutation});
    validateResult(updateMutationResult);
    const q = "query { models { Task { edges { node { id, name, options {hidden, hidden2} } } } } }";
    const queryResult = await graphql({schema, source: q});
    validateResult(queryResult);
    const taskEdges = resultData<{models: {Task: Connection<TaskOptionsRow>}}>(queryResult).models.Task.edges;
    expect(taskEdges[0].node.options.hidden).toEqual("nowhere");
    return expect(taskEdges[0].node.options.hidden2).toEqual("nowhere2");
  });
  it("update - set null", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const createMutation = `mutation {
      models {
        Task(create: {name: "item1", nullCheck: "not null"}) {
          id,
          name
        }
      }
    }`;
    const createMutationResult = await graphql({schema, source: createMutation});
    validateResult(createMutationResult);
    const id = resultData<{models: {Task: TaskRow[]}}>(createMutationResult).models.Task[0].id;

    const updateMutation = `mutation {
      models {
        Task(update: {where: {id: {eq: "${id}"}}, input: {nullCheck: null}}) {
          id,
          name
        }
      }
    }`;
    const updateMutationResult = await graphql({schema, source: updateMutation});
    validateResult(updateMutationResult);

    const queryResult = await graphql({schema, source: `query {
  models {
    Task {
      edges {
        node {
          id,
          nullCheck
        }
      }
    }
  }
}`});
    validateResult(queryResult);
    expect(resultData<{models: {Task: Connection<TaskNullCheckRow>}}>(queryResult).models.Task.edges[0].node.nullCheck).toEqual(null);
  });
  it("update - set 0", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const createMutation = `mutation {
      models {
        Task(create: {name: "item1", intZeroCheck: 1}) {
          id,
          name
        }
      }
    }`;
    const createMutationResult = await graphql({schema, source: createMutation});
    validateResult(createMutationResult);
    const id = resultData<{models: {Task: TaskRow[]}}>(createMutationResult).models.Task[0].id;

    const updateMutation = `mutation {
      models {
        Task(update: {where: {id: {eq: "${id}"}}, input: {intZeroCheck: 0}}) {
          id,
          name
        }
      }
    }`;
    const updateMutationResult = await graphql({schema, source: updateMutation});
    validateResult(updateMutationResult);

    const queryResult = await graphql({schema,  source: `query {
  models {
    Task {
      edges {
        node {
          id,
          intZeroCheck
        }
      }
    }
  }
}`});
    validateResult(queryResult);
    return expect(resultData<{models: {Task: Connection<TaskIntZeroRow>}}>(queryResult).models.Task.edges[0].node.intZeroCheck).toEqual(0);
  });
  it("update", async() => {
    const instance = await createInstance();
    const {Task} = instance.models;
    const item = await Task.create({
      name: "item2",
    });
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Task(update: {where: {id: {eq: "${toGlobalId("Task", item.id)}"}}, input: {name: "UPDATED"}}) {
          id,
          name
        }
      }
    }`;
    const result = await graphql({schema, source: mutation});
    validateResult(result);
    const taskRows = resultData<{models: {Task: TaskRow[]}}>(result).models.Task;
    expect(taskRows[0].id).toEqual(toGlobalId("Task", item.id));
    expect(taskRows[0].name).toEqual("UPDATED");
  });
  it("delete", async() => {
    const instance = await createInstance();
    const {Task} = instance.models;
    const item = await Task.create({
      name: "item2",
    });
    const schema = await createSchema(instance);
    const itemId = toGlobalId("Task", item.id);
    const mutation = `mutation {
      models {
        Task(delete: {id: {eq: "${itemId}"} }) {
          id
        }
      }
    }`;
    const result = await graphql({schema, source: mutation});
    validateResult(result);
    expect(resultData<{models: {Task: TaskDeleteRow[]}}>(result).models.Task[0].id).toEqual(itemId);
    const query = `query {
      models {
        Task(where: {id: {eq: "${itemId}"}}) {
          edges {
            node {
              id,
              name
            }
          }
        }
      }
    }`;
    const queryResult = await graphql({schema, source: query});
    validateResult(queryResult);
    return expect(resultData<{models: {Task: Connection<TaskRow>}}>(queryResult).models.Task.edges).toHaveLength(0);
  });

  it("delete - single", async() => {
    const instance = await createInstance();
    const {Task} = instance.models;
    const items = await Promise.all([
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
    const itemId = toGlobalId("Task", items[0].id);
    const variableValues = {
      where: {
        id: {
          eq: itemId,
        },
      },
    };
    const mutation = `mutation ($where: [GQLTQueryTaskWhere]){
      models {
        Task(delete: $where) {
          id
        }
      }
    }`;
    const result = await graphql({
      schema,
      source: mutation,
      variableValues
    });
    validateResult(result);
    expect(resultData<{models: {Task: TaskDeleteRow[]}}>(result).models.Task[0].id).toEqual(itemId);
    const query = `query {
      models {
        Task {
          edges {
            node {
              id,
              name
            }
          }
        }
      }
    }`;
    const queryResult = await graphql({schema, source: query});
    validateResult(queryResult);
    return expect(resultData<{models: {Task: Connection<TaskRow>}}>(queryResult).models.Task.edges).toHaveLength(2);
  });

  it("update - multiple", async() => {
    const instance = await createInstance();
    const {Task} = instance.models;
    const items = await Promise.all([
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
    const mutation = `mutation {
      models {
        Task(update: {
          where: {
            name: {in: ["item2", "item3"]}
          },
          input: {name: "UPDATED"}
        }) {
          id,
          name
        }
      }
    }`;
    const item2Id = toGlobalId("Task", items[1].id);
    const item3Id = toGlobalId("Task", items[2].id);
    const mutationResult = await graphql({schema, source: mutation});
    validateResult(mutationResult);
    const item2Result = await graphql({schema, source: `{
      models {
        Task(where: {id: {eq:"${item2Id}"}}) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }`});
    validateResult(item2Result);
    const item3Result = await graphql({schema, source:`{
      models {
        Task(where: {id: {eq:"${item3Id}"}}) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }`});
    validateResult(item3Result);
    expect(resultData<{models: {Task: Connection<TaskRow>}}>(item2Result).models.Task.edges[0].node.name).toEqual("UPDATED");
    expect(resultData<{models: {Task: Connection<TaskRow>}}>(item3Result).models.Task.edges[0].node.name).toEqual("UPDATED");
  });
  it("delete - multiple", async() => {
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
    const mutation = `mutation {
      models {
        Task(delete: {
          name: {in: ["item2", "item3"]}
        }) {
          id
        }
      }
    }`;
    const result = await graphql({schema, source: mutation});
    validateResult(result);
    // Both rows the filter named come back, not just the last one.
    expect(resultData<{models: {Task: TaskDeleteRow[]}}>(result).models.Task).toHaveLength(2);
    const queryResults = await graphql({schema, source:`{
      models {
        Task {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }`});
    expect(resultData<{models: {Task: Connection<TaskRow>}}>(queryResults).models.Task.edges).toHaveLength(1);
  });
  it("classMethod", async() => {
    const instance = await createInstance();
    const {Task} = instance.models;
    await Task.create({
      name: "item2",
    });
    const schema = await createSchema(instance);

    const mutation = `mutation {
      classMethods {
        Task {
          reverseName(input: {amount: 2}) {
            id
            name
          }
        }
      }
    }`;
    const result = await graphql({schema, source:mutation});
    validateResult(result);
    return expect(resultData<{classMethods: {Task: {reverseName: TaskRow}}}>(result).classMethods.Task.reverseName.name).toEqual("reverseName2");
  });
  it("create - before hook", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Task(create: {name: "item1"}) {
          id,
          name,
          mutationCheck
        }
      }
    }`;
    const mutationResult = await graphql({schema, source:mutation});
    validateResult(mutationResult);
    return expect(resultData<{models: {Task: TaskMutationCheckRow[]}}>(mutationResult).models.Task[0].mutationCheck).toEqual("create");
  });
  it("update - before hook", async() => {
    const instance = await createInstance();
    const {Task} = instance.models;
    const item = await Task.create({
      name: "item2",
    });
    const schema = await createSchema(instance);
    const itemId = toGlobalId("Task", item.id);
    const mutation = `mutation {
      models {
        Task(update: {where: {id:{eq:"${itemId}"}}, input: {name: "UPDATED"}}) {
          id,
          name,
          mutationCheck
        }
      }
    }`;
    const result = await graphql({schema, source:mutation});
    validateResult(result);
    return expect(resultData<{models: {Task: TaskMutationCheckRow[]}}>(result).models.Task[0].mutationCheck).toEqual("update");
  });

  it("update - ensure input foreignKeys are types of GraphQLID", async() => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const task = await Task.create({
      name: "task2",
    });

    await TaskItem.create({
      name: "item1234",
    });
    const schema = await createSchema(instance);
    const taskId = toGlobalId("Task", task.id);
    const taskItemId = toGlobalId("TaskItem", task.id);
    const mutation = `mutation {
      models {
        TaskItem(update: {where: {id: {eq:"${taskItemId}"}}, input: {taskId: "${taskId}"}}) {
          id,
          task {
            id
          }
        }
      }
    }`;
    const result = await graphql({schema, source:mutation});
    validateResult(result);
    const taskItemRows = resultData<{models: {TaskItem: TaskWithTaskItemRow[]}}>(result).models.TaskItem;
    expect(taskItemRows[0].id).toEqual(taskItemId);
    expect(taskItemRows[0].task.id).toEqual(taskId);
  });
  it("create - hook variables {rootValue}", async() => {
    const taskModel = {
      name: "Task",
      define: {
        name: {
          type: Sequelize.STRING,
          allowNull: false,
        },
      },
      options: {
        tableName: "tasks",
        hooks: {
          beforeFind(options) {
            expect(options.getGraphQLArgs).toBeDefined();
            expect(options.getGraphQLArgs).toBeInstanceOf(Function);
            const args = options.getGraphQLArgs();
            expect(args.info).toBeDefined();
            expect(args.info.rootValue).toBeDefined();
            expect(args.info.rootValue.req).toEqual("exists");//, `beforeFind: rootValue: {req: 'exists'} does not match. ${JSON.stringify(args.info.rootValue)}`);
            return undefined;
          },
          beforeCreate(instance, options) {
            expect(options.getGraphQLArgs).toBeDefined();
            expect(options.getGraphQLArgs).toBeInstanceOf(Function);
            const args = options.getGraphQLArgs();
            expect(args.info.rootValue).toBeDefined();
            expect(args.info.rootValue.req).toEqual("exists"); //, `beforeCreate: rootValue: {req: 'exists'} does not match. ${JSON.stringify(args.info.rootValue)}`);
            return undefined;
          },
          beforeUpdate(instance, options) {
            expect(false).toEqual(true);
          },
          beforeDestroy(instance, options) {
            expect(false).toEqual(true);
          },
        },
      },
    } as Definition;
    const db = new Database();
    await registerDialectAdapter(db);
    await db.addDefinition(taskModel);
    await db.initialise();
    await db.sync();
    const schema = await createSchema(db);

    const createMutation = `mutation {
      models {
        Task(create:{name: "CREATED"}) {
          id,
          name
        }
      }
    }`;
    const createResult = await graphql({schema, source: createMutation,
      rootValue: {req: "exists"}
    });
    validateResult(createResult);
  });
  it("update - hook variables {rootValue}", async() => {
    const taskModel = {
      name: "Task",
      define: {
        name: {
          type: Sequelize.STRING,
          allowNull: false,
        },
      },
      options: {
        tableName: "tasks",
        hooks: {
          beforeFind(options) {
            expect(options.getGraphQLArgs).toBeDefined();
            expect(options.getGraphQLArgs).toBeInstanceOf(Function);
            const args = options.getGraphQLArgs();
            expect(args.info).toBeDefined();
            expect(args.info.rootValue).toBeDefined();
            expect(args.info.rootValue.req).toEqual("exists");///), `beforeFind: rootValue: {req: 'exists'} does not match. ${JSON.stringify(args.info.rootValue)}`);
            return undefined;
          },
          beforeUpdate(instance, options) {
            expect(options.getGraphQLArgs).toBeDefined();
            expect(options.getGraphQLArgs).toBeInstanceOf(Function);
            const args = options.getGraphQLArgs();
            expect(args.info).toBeDefined();
            expect(args.info.rootValue).toBeDefined();
            expect(args.info.rootValue.req).toEqual("exists");//, `beforeUpdate: rootValue: {req: 'exists'} does not match. ${JSON.stringify(args.info.rootValue)}`);
            return undefined;
          },
          beforeDestroy(instance, options) {
            expect(false).toEqual(true);
          },
        },
      },
    } as Definition;

    const db = new Database();
    await registerDialectAdapter(db);
    await db.addDefinition(taskModel);
    await db.initialise();
    await db.sync();
    const {Task} = db.models;
    const item = await Task.create({
      name: "item2",
    });
    const schema = await createSchema(db);

    const itemId = toGlobalId("Task", item.id);
    const updateMutation = `mutation {
      models {
        Task(update: {where: {id: {eq:"${itemId}"}}, input: {name: "UPDATED"}}) {
            id,
            name
          }
        }
      }`;
    const updateResult = await graphql({schema, source:updateMutation, rootValue:{req: "exists"}});
    validateResult(updateResult);
  });
  it("delete - hook variables {rootValue, context}", async() => {
    const taskModel = {
      name: "Task",
      define: {
        name: {
          type: Sequelize.STRING,
          allowNull: false,
        },
      },
      options: {
        tableName: "tasks",
        hooks: {
          beforeFind(options) {
            expect(options.getGraphQLArgs).toBeDefined();
            expect(options.getGraphQLArgs).toBeInstanceOf(Function);
            const args = options.getGraphQLArgs();
            expect(args.info).toBeDefined();
            expect(args.info.rootValue).toBeDefined();
            expect(args.info.rootValue.req).toEqual("exists");//, `beforeFind: rootValue: {req: 'exists'} does not match. ${JSON.stringify(args.info.rootValue)}`);
            return undefined;
          },
          beforeUpdate(instance, options) {
            expect(false).toEqual(true);
            // return instance;
          },
          beforeDestroy(instance, options) {
            expect(options.getGraphQLArgs).toBeDefined();
            expect(options.getGraphQLArgs).toBeInstanceOf(Function);
            const args = options.getGraphQLArgs();
            expect(args.info).toBeDefined();
            expect(args.info.rootValue).toBeDefined();
            expect(args.info.rootValue.req).toEqual("exists");//, `beforeDestroy: rootValue: {req: 'exists'} does not match. ${JSON.stringify(args.info.rootValue)}`);
            return instance;
          },
        },
      },
    } as Definition;
    const db = new Database();
    await registerDialectAdapter(db);
    await db.addDefinition(taskModel);
    await db.initialise();
    await db.sync();
    const {Task} = db.models;
    const item = await Task.create({
      name: "item2",
    });
    const itemId = toGlobalId("Task", item.id);
    const schema = await createSchema(db);
    const deleteMutation = `mutation {
      models {
        Task(delete: {id: {eq:"${itemId}"}}) {
          id
        }
      }
    }`;
    const deleteResult = await graphql({schema, source:deleteMutation, rootValue: {req: "exists"}});
    validateResult(deleteResult);
  });
  it("create inputs - with no PK defined", async() => {
    const instance = await createInstance();
    const fields = instance.getFields("Task"); //TaskItem.$sqlgql.define;
    const schema = await createSchema(instance);
    const result = await graphql({schema, source:"query {__type(name:\"TaskRequiredInput\") { inputFields {name} }}"});
    const {__type: {inputFields}} = resultData<IntrospectionInputFields>(result);
    const mutationInputFields = inputFields.map((x) => x.name);

    // Primary and foreign keys are excluded from mutation input by default
    // (mass-assignment guard); every other field — including defaulted /
    // auto-populated columns — is exposed.
    Object.keys(fields)
      .filter((field) => !fields[field].primaryKey && !fields[field].foreignKey)
      .map((field) => {
        expect(mutationInputFields).toContain(field);
      });
    expect(mutationInputFields).not.toContain("id");
  });
  it("create inputs - with PK defined", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Item(create: {name: "item1"}) {
          id,
          name
        }
      }
    }`;
    const itemResult = await graphql({schema, source:mutation});
    validateResult(itemResult);
    const result = await graphql({schema, source:"query {__type(name:\"ItemRequiredInput\") { inputFields {name} }}"});
    const {__type: {inputFields}} = resultData<IntrospectionInputFields>(result);
    expect(inputFields.filter((x) => x.name === "id")).toHaveLength(0);
  });
});
