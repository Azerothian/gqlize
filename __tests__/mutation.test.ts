import {createInstance, validateResult} from "./helper";
import {graphql} from "graphql";
// import {createSchema} from "../src/graphql/index";
import Sequelize from "sequelize";
import {toGlobalId} from "graphql-relay";
import SequelizeAdapter from "@azerothian/gqlize-adapter-sequelize";
import Database from "../src/manager";
import {createSchema} from "../src/graphql/index";
import { GqlizeAdapter } from "../src/types";
import { Definition } from '../src/types/index';
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";

// Sequelize.Promise = global.Promise;

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
    const queryResult = await graphql({schema, source: query}) as any; 
    validateResult(queryResult);
    return expect(queryResult.data.models.Task.edges).toHaveLength(1);
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
    const queryResult = await graphql({schema, source: query}) as any;
    validateResult(queryResult);
    return expect(queryResult.data.models.Item.edges).toHaveLength(1);
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
    const queryResult = await graphql({schema, source: query}) as any;
    validateResult(queryResult);
    return expect(queryResult.data.models.Item.edges).toHaveLength(1);
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
    const mutationResult = await graphql({schema, source: mutation}) as any;
    validateResult(mutationResult);
    expect(mutationResult.data.models.Task[0].options.hidden).toEqual("nowhere");

    const q = "query { models { Task { edges { node { id, name, options {hidden} } } } } }";
    const queryResult = await graphql({schema, source: q}) as any;
    validateResult(queryResult);
    return expect(queryResult.data.models.Task.edges[0].node.options.hidden).toEqual("nowhere");
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
    const createMutationResult = await graphql({schema,  source: createMutation}) as any;
    validateResult(createMutationResult);
    const id = createMutationResult.data.models.Task[0].id;

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
    const queryResult = await graphql({schema, source: q}) as any;
    validateResult(queryResult);
    expect(queryResult.data.models.Task.edges[0].node.options.hidden).toEqual("nowhere");
    return expect(queryResult.data.models.Task.edges[0].node.options.hidden2).toEqual("nowhere2");
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
    const createMutationResult = await graphql({schema, source: createMutation}) as any;
    validateResult(createMutationResult);
    const id = createMutationResult.data.models.Task[0].id;

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
}`}) as any;
    validateResult(queryResult);
    expect(queryResult.data.models.Task.edges[0].node.nullCheck).toEqual(null);
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
    const createMutationResult = await graphql({schema, source: createMutation}) as any;
    validateResult(createMutationResult);
    const id = createMutationResult.data.models.Task[0].id;

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
}`}) as any;
    validateResult(queryResult);
    return expect(queryResult.data.models.Task.edges[0].node.intZeroCheck).toEqual(0);
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
    const result = await graphql({schema, source: mutation}) as any;
    validateResult(result);
    expect(result.data.models.Task[0].id).toEqual(toGlobalId("Task", item.id));
    expect(result.data.models.Task[0].name).toEqual("UPDATED");
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
    const result = await graphql({schema, source: mutation}) as any;
    validateResult(result);
    expect(result.data.models.Task[0].id).toEqual(itemId);
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
    const queryResult = await graphql({schema, source: query}) as any;
    validateResult(queryResult);
    return expect(queryResult.data.models.Task.edges).toHaveLength(0);
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
    }) as any;
    validateResult(result);
    expect(result.data.models.Task[0].id).toEqual(itemId);
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
    const queryResult = await graphql({schema, source: query}) as any;
    validateResult(queryResult);
    return expect(queryResult.data.models.Task.edges).toHaveLength(2);
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
    }`}) as any;
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
    }`}) as any;
    validateResult(item3Result);
    expect(item2Result.data.models.Task.edges[0].node.name).toEqual("UPDATED");
    expect(item3Result.data.models.Task.edges[0].node.name).toEqual("UPDATED");
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
    const result = await graphql({schema, source: mutation}) as any;
    validateResult(result);
    expect(result.data.models.Task).toHaveLength(1);
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
    }`}) as any;
    expect(queryResults.data.models.Task.edges).toHaveLength(1);
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
    const result = await graphql({schema, source:mutation}) as any;
    validateResult(result);
    return expect(result.data.classMethods.Task.reverseName.name).toEqual("reverseName2");
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
    const mutationResult = await graphql({schema, source:mutation}) as any;
    validateResult(mutationResult);
    return expect(mutationResult.data.models.Task[0].mutationCheck).toEqual("create");
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
    const result = await graphql({schema, source:mutation}) as any;
    validateResult(result);
    return expect(result.data.models.Task[0].mutationCheck).toEqual("update");
  });

  it("update - ensure input foreignKeys are types of GraphQLID", async() => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const task = await Task.create({
      name: "task2",
    });

    const taskItem = await TaskItem.create({
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
    const result = await graphql({schema, source:mutation}) as any;
    validateResult(result);
    expect(result.data.models.TaskItem[0].id).toEqual(taskItemId);
    expect(result.data.models.TaskItem[0].task.id).toEqual(taskId);
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
    }) as GqlizeAdapter, "sqlite");
    db.addDefinition(taskModel);
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
    }) as GqlizeAdapter, "sqlite");
    db.addDefinition(taskModel);
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
    }) as GqlizeAdapter, "sqlite");
    db.addDefinition(taskModel);
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
    const {TaskItem} = instance.models;
    const fields = instance.getFields("Task"); //TaskItem.$sqlgql.define;
    const schema = await createSchema(instance);
    const {data: {__type: {inputFields}}} = await graphql({schema, source:"query {__type(name:\"TaskRequiredInput\") { inputFields {name} }}"}) as any;
    const mutationInputFields = inputFields.map((x: any) => x.name);

    Object.keys(fields).map((field) => {
      expect(mutationInputFields).toContain(field);
    });
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
    const itemResult = await graphql({schema, source:mutation}) as any;
    validateResult(itemResult);
    const {data: {__type: {inputFields}}} = await graphql({schema, source:"query {__type(name:\"ItemRequiredInput\") { inputFields {name} }}"}) as any;
    expect(Object.keys(inputFields).filter((x: any) => x.name === "id")).toHaveLength(0);
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
    const queryResults = await graphql({schema, source:mutation}) as any;
    validateResult(queryResults);
    expect(queryResults.data.models.Task).toHaveLength(1);
    expect(queryResults.data.models.Task[0].items.edges).toHaveLength(1);
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
    const queryResults = await graphql({schema, source:mutation}) as any;
    validateResult(queryResults);
    expect(queryResults.data.models.Item).toHaveLength(1);
    const item = queryResults.data.models.Item[0];
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
    const queryResults = await graphql({schema, source:mutation}) as any;
    validateResult(queryResults);
    expect(queryResults.data.models.Item).toHaveLength(1);
    const item = queryResults.data.models.Item[0];
    const {belongsTo} = item;
    expect(item.belongsToId).toEqual(belongsTo.id);
  });
  it("add - multiple", async() => {
    const instance = await createInstance();
    const {Task, TaskItem} = instance.models;
    const startTask = await Task.create({
      name: "start",
    });
    const endTask = await Task.create({
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
    const result = await graphql({schema, source:mutation}) as any;
    validateResult(result);
    expect(result.data.models.Task).toHaveLength(1);
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
    }`}) as any;
    expect(queryResults.data.models.Task.edges).toHaveLength(1);
    expect(queryResults.data.models.Task.edges[0].node.items.edges).toHaveLength(1);
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
    }`}) as any;
    expect(endQueryResults.data.models.Task.edges).toHaveLength(1);
    expect(endQueryResults.data.models.Task.edges[0].node.items.edges).toHaveLength(2);
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
    const result = await graphql({schema, source:mutation}) as any;
    validateResult(result);
    expect(result.data.models.Task).toHaveLength(1);
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
    }`}) as any;
    expect(queryResults.data.models.Task.edges).toHaveLength(1);
    expect(queryResults.data.models.Task.edges[0].node.items.edges).toHaveLength(1);
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
  const res = await graphql({schema, source:mutation, variableValues}) as any;

  expect(res.data.models.Parent[0].children.edges).toHaveLength(2);

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
  const queryResult = await graphql({schema, source:query}) as any;
  validateResult(queryResult);
  expect(queryResult.data.models.Parent.edges[0].node.children.edges).toHaveLength(2);

  const newChild = await ChildModel.create({
    name: "child3",
  });

  const mutation2 = `
    mutation($childIds: [ID]) {
      models {
        Parent(update: {
          where: {id: {eq:"${queryResult.data.models.Parent.edges[0].node.id}"}}
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

  const res2 = await graphql({schema, source:mutation2,variableValues}) as any;
  expect(res2.data.models.Parent[0].children.edges).toHaveLength(1);
});

describe("2 degree mutation(nested)", () => {
  let parent: any, child: any, schema: any, db: Database;
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
    const res = await graphql({schema, source:mutation, variableValues}) as any;

    //then
    expect(res.data.models.Parent[0].children.edges[0].node.name).toEqual("child 2");
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
    const res = await graphql({schema, source:mutation, variableValues}) as any;
    let isChildStillExisting = await ChildModel.findOne({
      where: {id: child.id},
    });

    //then
    expect(res.data.models.Parent[0] .children.edges).toHaveLength(0);
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
    const res = await graphql({schema, source:mutation, variableValues}) as any;
    let isChildStillExisting = await ChildModel.findOne({
      where: {id: child.id},
    });

    //then
    expect(res.data.models.Parent[0] .children.edges).toHaveLength(0);
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
    const res = await graphql({schema, source:mutation, variableValues}) as any;
    let isChildStillExisting = await ChildModel.findOne({
      where: {id: child.id},
    });

    //then
    expect(res.data.models.Parent[0] .children.edges).toHaveLength(1);
    expect(res.data.models.Parent[0].children.edges[0].node.name).toEqual("child1");
  });
});

