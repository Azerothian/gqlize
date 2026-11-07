// GraphQL mutations that reach across relationships: creating complex objects
// (hasOne, belongsTo), add/remove, multiple ids, and two-degree nested writes.
// The single-model basics are in `mutation-crud.test.ts`.
import {createInstance, resultData, validateResult} from "./helper";
import {graphql, GraphQLSchema} from "graphql";
import Sequelize from "sequelize";
import {toGlobalId} from "graphql-relay";
import { registerDialectAdapter } from "./helper/dialect";
import { Ormize as Database } from "@azerothian/ormize";
import {createSchema} from "../src";
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";
import type {
  Connection,
  TaskItemsConnectionRow,
  TaskWithNestedItemsRow,
  ItemWithHasOneRow,
  ItemWithBelongsToRow,
  ParentWithChildrenRow,
} from "./helper/mutation-types";

describe("mutations", () => {
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
  await registerDialectAdapter(db);
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
  await db.addDefinition(parentDef);
  await db.addDefinition(childDef);
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
    await registerDialectAdapter(db, {suite: true});
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
    await db.addDefinition(parentDef);
    await db.addDefinition(childDef);
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
