import {createInstance, resultData, validateResult} from "./helper";
import {graphql, GraphQLSchema} from "graphql";
// import {createSchema} from "../src";
import Sequelize from "sequelize";
import {toGlobalId} from "graphql-relay";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { Ormize as Database } from "@azerothian/ormize";
import {createSchema} from "../src";
import { GqlizeAdapter } from "../src/types";
import { Definition } from '../src/types/index';
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";

// Sequelize.Promise = global.Promise;

/** The shapes these queries/mutations select, named once rather than cast per assertion. */
type Edge<T> = {node: T};
type Connection<T> = {edges: Edge<T>[]};
type TaskRow = {id: string; name: string};
type TaskOptionsRow = {id: string; name: string; options: {hidden?: string; hidden2?: string}};
type TaskNullCheckRow = {id: string; nullCheck: string | null};
type TaskIntZeroRow = {id: string; intZeroCheck: number};
type TaskMutationCheckRow = {id: string; name: string; mutationCheck: string};
type TaskItemRow = {id: string; name: string; parentId: string | null};
type TaskDeleteRow = {id: string};
type TaskWithTaskItemRow = {id: string; task: {id: string}};
type TaskItemsConnectionRow = {id: string; items: Connection<{id: string; name: string}>};
type TaskWithNestedItemsRow = {id: string; items: Connection<{id: string}>};
type ItemWithHasOneRow = {id: string; hasOne: {id: string; name: string; hasOneId: string}};
type ItemWithBelongsToRow = {id: string; belongsTo: {id: string; name: string}; belongsToId: string};
type ParentWithChildrenRow = {id: string; name?: string; children: Connection<{id: string; name?: string; parentId?: string}>};
type IntrospectionInputFields = {__type: {inputFields: {name: string}[]}};

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
    expect(resultData<{models: {Task: TaskDeleteRow[]}}>(result).models.Task).toHaveLength(1);
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
    db.registerAdapter(new SequelizeAdapter({}, {
      dialect: "sqlite",
    }), "sqlite");
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
    db.registerAdapter(new SequelizeAdapter({}, {
      dialect: "sqlite",
    }), "sqlite");
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
    db.registerAdapter(new SequelizeAdapter({}, {
      dialect: "sqlite",
    }), "sqlite");
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
  it("create complex object", async() => {
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
          }
        }
      }
    }
  }
}`;
    const queryResults = await graphql({schema, source:mutation});
    validateResult(queryResults);
    const taskRows = resultData<{models: {Task: TaskWithNestedItemsRow[]}}>(queryResults).models.Task;
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].items.edges).toHaveLength(1);
  });
  it("create complex object - hasOne", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Item(create: {
          name: "test",
          hasOne: {
            create: {
              name: "testitem"
            }
          }
        }) {
          id
          hasOne {
            id
            name
            hasOneId
          }
        }
      }
    }`;
    const queryResults = await graphql({schema, source:mutation});
    validateResult(queryResults);
    const itemRows = resultData<{models: {Item: ItemWithHasOneRow[]}}>(queryResults).models.Item;
    expect(itemRows).toHaveLength(1);
    const item = itemRows[0];
    const {hasOne} = item;
    expect(item.id).toEqual(hasOne.hasOneId);
  });
  it("create complex object - belongsTo", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Item(create: {
          name: "test",
          belongsTo: {
            create: {
              name: "testitem2"
            }
          }
        }) {
          id
          belongsTo {
            id
            name
          }
          belongsToId
        }
      }
    }`;
    const queryResults = await graphql({schema, source:mutation});
    validateResult(queryResults);
    const itemRows = resultData<{models: {Item: ItemWithBelongsToRow[]}}>(queryResults).models.Item;
    expect(itemRows).toHaveLength(1);
    const item = itemRows[0];
    const {belongsTo} = item;
    expect(item.belongsToId).toEqual(belongsTo.id);
  });
  it("add - multiple", async() => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const startTask = await Task.create({
      name: "start",
    });
    await Task.create({
      name: "end",
    });
    await TaskItem.create({
      name: "item000001",
      taskId: startTask.get("id"),
    });
    await TaskItem.create({
      name: "item000002",
      taskId: startTask.get("id"),
    });
    await TaskItem.create({
      name: "item000003",
      taskId: startTask.get("id"),
    });
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Task(update: {
          where: {
            name: {eq:"end"}
          },
          input: {
            items: {
              add: {
                name: {
                  in: ["item000002", "item000003"]
                }
              }
            }
          }
        }) {
          id
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
    }`;
    const result = await graphql({schema, source:mutation});
    validateResult(result);
    expect(resultData<{models: {Task: TaskItemsConnectionRow[]}}>(result).models.Task).toHaveLength(1);
    const queryResults = await graphql({schema, source:`{
      models {
        Task(where: {name: {eq:"start"}}) {
          edges {
            node {
              id
              name
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
    }`});
    const startEdges = resultData<{models: {Task: Connection<TaskItemsConnectionRow>}}>(queryResults).models.Task.edges;
    expect(startEdges).toHaveLength(1);
    expect(startEdges[0].node.items.edges).toHaveLength(1);
    const endQueryResults = await graphql({schema, source:`{
      models {
        Task(where: {name: {eq:"end"}}) {
          edges {
            node {
              id
              name
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
    }`});
    const endEdges = resultData<{models: {Task: Connection<TaskItemsConnectionRow>}}>(endQueryResults).models.Task.edges;
    expect(endEdges).toHaveLength(1);
    expect(endEdges[0].node.items.edges).toHaveLength(2);
  });
  it("remove - multiple", async() => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const startTask = await Task.create({
      name: "start",
    });
    await TaskItem.create({
      name: "item000001",
      taskId: startTask.get("id"),
    });
    await TaskItem.create({
      name: "item000002",
      taskId: startTask.get("id"),
    });
    await TaskItem.create({
      name: "item000003",
      taskId: startTask.get("id"),
    });
    const schema = await createSchema(instance);
    const mutation = `mutation {
      models {
        Task(update: {
          where: {
            name: {eq:"start"}
          },
          input: {
            items: {
              remove: {
                name: {
                  in: ["item000002", "item000003"]
                }
              }
            }
          }
        }) {
          id
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
    }`;
    const result = await graphql({schema, source:mutation});
    validateResult(result);
    expect(resultData<{models: {Task: TaskItemsConnectionRow[]}}>(result).models.Task).toHaveLength(1);
    const queryResults = await graphql({schema, source:`{
      models {
        Task(where: {name:{eq: "start"}}) {
          edges {
            node {
              id
              name
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
    }`});
    const startEdges = resultData<{models: {Task: Connection<TaskItemsConnectionRow>}}>(queryResults).models.Task.edges;
    expect(startEdges).toHaveLength(1);
    expect(startEdges[0].node.items.edges).toHaveLength(1);
  });
});

test("add multiple ids", async() => {
  const db = new Database();
  const sqlite = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter;
  db.registerAdapter(sqlite, "sqlite");
  const parentDef = {
    name: "Parent",
    define: {
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
    },
    relationships: [{
      type: "hasMany",
      model: "Child",
      name: "children",
      options: {
        as: "children",
        foreignKey: "parentId",
      },
    }],
  };

  const childDef = {
    name: "Child",
    define: {
      name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
    },
    relationships: [
      {
        type: "belongsTo",
        model: "Parent",
        name: "parent",
        options: {
          foreignKey: "parentId",
        },
      },
    ],
  };
  await db.addDefinition(parentDef, "sqlite");
  await db.addDefinition(childDef, "sqlite");
  await db.initialise();
  await db.sync();
  // const ParentModel = db.getModel("Parent");
  const ChildModel = db.getModel("Child");

  const children = await Promise.all([
    ChildModel.create({
      name: "child1",
    }),
    ChildModel.create({
      name: "child2",
    }),
  ]);

  const schema = await createSchema(db);

  const childIds = children.map(({id}) => toGlobalId("Child", id));
  let variableValues = {childIds};
  const mutation = `mutation($childIds: [ID]) {
    models {
      Parent(create: {
        name: "parent3",
        children: {
          add: {id: {in: $childIds}}
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
  const res = await graphql({schema, source:mutation, variableValues});

  expect(resultData<{models: {Parent: ParentWithChildrenRow[]}}>(res).models.Parent[0].children.edges).toHaveLength(2);

  const query = `
    query {
      models {
        Parent(where: {
          name: {eq: "parent3"}
        }) {
          edges {
            node {
              id
              name
              children {
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
    }
  `;
  const queryResult = await graphql({schema, source:query});
  validateResult(queryResult);
  const parentEdges = resultData<{models: {Parent: Connection<ParentWithChildrenRow>}}>(queryResult).models.Parent.edges;
  expect(parentEdges[0].node.children.edges).toHaveLength(2);

  const newChild = await ChildModel.create({
    name: "child3",
  });

  const mutation2 = `
    mutation($childIds: [ID]) {
      models {
        Parent(update: {
          where: {id: {eq:"${parentEdges[0].node.id}"}}
          input: {
            name: "haha"
            children: {
              remove: {},
              add: {id: {in: $childIds}}
            }
          }
        }) {
          id
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
  `;
  variableValues = {childIds: [toGlobalId("Child", newChild.id)]};

  const res2 = await graphql({schema, source:mutation2,variableValues});
  expect(resultData<{models: {Parent: ParentWithChildrenRow[]}}>(res2).models.Parent[0].children.edges).toHaveLength(1);
});

describe("2 degree mutation(nested)", () => {
  let parent: {id: number}, child: {id: number}, schema: GraphQLSchema, db: Database;
  beforeAll(async() => {
    db = new Database();
    const sqlite = new SequelizeAdapter({}, {
      dialect: "sqlite",
    }) as GqlizeAdapter;
    db.registerAdapter(sqlite, "sqlite");
    const parentDef = {
      name: "Parent",
      define: {
        name: {
          type: Sequelize.STRING,
          allowNull: false,
        },
      },
      relationships: [{
        type: "hasMany",
        model: "Child",
        name: "children",
        options: {
          as: "children",
          foreignKey: "parentId",
        },
      }],
    };
    const childDef = {
      name: "Child",
      define: {
        name: {
          type: Sequelize.STRING,
          allowNull: true,
        },
      },
      relationships: [
        {
          type: "belongsTo",
          model: "Parent",
          name: "parent",
          options: {
            foreignKey: "parentId",
          },
        },
      ],
    };
    await db.addDefinition(parentDef, "sqlite");
    await db.addDefinition(childDef, "sqlite");
    await db.initialise();
    await db.sync();
  });
  // afterAll(async() => {
  //   sqlite.reset();
  // });

  beforeEach(async() => {
    const ParentModel = db.getModel("Parent");

    parent = await ParentModel.create({
      name: "parent1",
    });

    schema = await createSchema(db);
  });

  test("should update child", async() => {
    //given
    const ChildModel = db.getModel("Child");
    child = await ChildModel.create({
      name: "child1",
      parentId: parent.id,
    });

    const variableValues = {
      parentId: toGlobalId("Parent", parent.id),
      childId: toGlobalId("Child", child.id),
    };
    const mutation = `mutation($parentId: ID, $childId: ID) {
      models {
        Parent(update: {
          where: {
            id: {eq: $parentId}
          },
          input: {
            name: "parent 2",
            children: {
              update: {
                where: {id: {eq: $childId}},
                input: {
                  name: "child 2"
                }
              }
            }
          }
        }) {
          id
          name
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
    }`;

    //when
    const res = await graphql({schema, source:mutation, variableValues});

    //then
    expect(resultData<{models: {Parent: ParentWithChildrenRow[]}}>(res).models.Parent[0].children.edges[0].node.name).toEqual("child 2");
  });

  test("should delete child", async() => {
    //given
    const ChildModel = db.getModel("Child");
    child = await ChildModel.create({
      name: "child1",
      parentId: parent.id,
    });

    const variableValues = {
      parentId: toGlobalId("Parent", parent.id),
      childId: toGlobalId("Child", child.id),
    };
    const mutation = `mutation($parentId: ID, $childId: ID) {
      models {
        Parent(update: {
          where: {
            id: {eq: $parentId}
          },
          input: {
            name: "parent 3",
            children: {
              delete:{
                id:{eq: $childId}
              }
            }
          }
        }) {
          id
          name
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
    }`;

    //when
    const res = await graphql({schema, source:mutation, variableValues});
    const isChildStillExisting = await ChildModel.findOne({
      where: {id: child.id},
    });

    //then
    expect(resultData<{models: {Parent: ParentWithChildrenRow[]}}>(res).models.Parent[0].children.edges).toHaveLength(0);
    expect(isChildStillExisting).toBeFalsy();
  });

  test("should remove child", async() => {
    //given
    const ChildModel = db.getModel("Child");
    child = await ChildModel.create({
      name: "child1",
      parentId: parent.id,
    });

    const variableValues = {
      parentId: toGlobalId("Parent", parent.id),
      childId: toGlobalId("Child", child.id),
    };
    const mutation = `mutation($parentId: ID, $childId: ID) {
      models {
        Parent(update: {
          where: {
            id: {eq: $parentId}
          },
          input: {
            name: "parent 3",
            children: {
              remove:{
                id:{eq: $childId}
              }
            }
          }
        }) {
          id
          name
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
    }`;

    //when
    const res = await graphql({schema, source:mutation, variableValues});
    const isChildStillExisting = await ChildModel.findOne({
      where: {id: child.id},
    });

    //then
    expect(resultData<{models: {Parent: ParentWithChildrenRow[]}}>(res).models.Parent[0].children.edges).toHaveLength(0);
    expect(isChildStillExisting).toBeTruthy();
  });

  test("should add child", async() => {
    //given
    const ChildModel = db.getModel("Child");
    child = await ChildModel.create({
      name: "child1",
    });

    const variableValues = {
      parentId: toGlobalId("Parent", parent.id),
      childId: toGlobalId("Child", child.id),
    };
    const mutation = `mutation($parentId: ID, $childId: ID) {
      models {
        Parent(update: {
          where: {
            id: {eq: $parentId}
          },
          input: {
            name: "parent 3",
            children: {
              add:{
                id:{eq: $childId}
              }
            }
          }
        }) {
          id
          name
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
    }`;

    //when
    const res = await graphql({schema, source:mutation, variableValues});
    await ChildModel.findOne({
      where: {id: child.id},
    });

    //then
    const parentRows = resultData<{models: {Parent: ParentWithChildrenRow[]}}>(res).models.Parent;
    expect(parentRows[0].children.edges).toHaveLength(1);
    expect(parentRows[0].children.edges[0].node.name).toEqual("child1");
  });
});
