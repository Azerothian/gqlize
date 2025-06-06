import {PubSub} from "graphql-subscriptions";

import {createInstance} from "./helper";
import {createSchema} from "../src/graphql/index";
import { GraphQLObjectType } from 'graphql';
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";

describe("permissions", () => {
  it("model", async() => {

    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        model(modelName) {
          if (modelName === "Task") {
            return false;
          }
          return true;
        },
      },
    });
    // debugger; //eslint-disable-line
    const queryFields = (schema.getQueryType()?.getFields().models.type as GraphQLObjectType)?.getFields();
    expect(queryFields.Task).not.toBeDefined();
    return expect(queryFields.TaskItem).toBeDefined();
  });
  it("field", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        field(modelName, fieldName) {
          if (modelName === "Task" && fieldName === "name") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const taskFields = schema.getQueryType()?.getFields().
      models.type.getFields().Task.type.getFields().edges.type.ofType.getFields().node.type.getFields();
    expect(taskFields.mutationCheck).toBeDefined();
    expect(taskFields.name).not.toBeDefined();
  });

  it("query listing", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        query(modelName) {
          if (modelName === "Task") {
            return false;
          }
          return true;
        },
      },
    });
    const queryFields = (schema.getQueryType()?.getFields().models.type as GraphQLObjectType)?.getFields();
    expect(queryFields.Task).not.toBeDefined();
    return expect(queryFields.TaskItem).toBeDefined();
  });
  it("query classMethods only", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        query(modelName) {
          return false;
        },
        queryClassMethods(modelName, methodName) {
          if (modelName === "Task" && methodName === "getHiddenData") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const queryFields = schema.getQueryType().getFields().classMethods.type.getFields().Task.type.getFields();
    expect(queryFields.getHiddenData).not.toBeDefined();
    return expect(queryFields.getHiddenData2).toBeDefined();
  });
  it("query classMethods", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        queryClassMethods(modelName, methodName) {
          if (modelName === "Task" && methodName === "getHiddenData") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const queryFields = schema.getQueryType().getFields().classMethods.type.getFields().Task.type.getFields();
    expect(queryFields.getHiddenData).not.toBeDefined();
    return expect(queryFields.getHiddenData2).toBeDefined();
  });
  it("relationship", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        relationship(modelName, relationshipName, targetModelName) {
          if (modelName === "Task" && targetModelName === "TaskItem") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const taskFields = schema.getQueryType().getFields().models.type.getFields().Task.type.getFields().edges.type.ofType.getFields().node.type.getFields();
    return expect(taskFields.items).not.toBeDefined();
  });
  it("mutation model", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        mutation(modelName) {
          if (modelName === "Task") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const queryFields = schema.getQueryType().getFields().models.type.getFields();
    const mutationFields = schema.getMutationType().getFields().models.type.getFields();
    expect(queryFields.Task).toBeDefined();
    return expect(mutationFields.Task).not.toBeDefined();
  });
  it("mutation model - create", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        mutationCreate(modelName) {
          if (modelName === "Task") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const {args} = schema.getMutationType().getFields().models.type.getFields().Task;
    expect(args.filter((a: any) => a.name === "delete")).toHaveLength(1);
    expect(args.filter((a: any) => a.name === "update")).toHaveLength(1);
    return expect(args.filter((a: any) => a.name === "create")).toHaveLength(0);
  });
  it("mutation model - update", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        mutationUpdate(modelName) {
          if (modelName === "Task") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const {args} = schema.getMutationType().getFields().models.type.getFields().Task;
    expect(args.filter((a: any) => a.name === "delete")).toHaveLength(1);
    expect(args.filter((a: any) => a.name === "update")).toHaveLength(0);
    return expect(args.filter((a: any) => a.name === "create")).toHaveLength(1);
  });
  it("mutation model - delete", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        mutationDelete(modelName) {
          if (modelName === "Task") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const {args} = schema.getMutationType().getFields().models.type.getFields().Task;
    expect(args.filter((a: any) => a.name === "delete")).toHaveLength(0);
    expect(args.filter((a: any) => a.name === "update")).toHaveLength(1);
    return expect(args.filter((a: any) => a.name === "create")).toHaveLength(1);
  });
  it("mutation model - classMethods", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        mutationClassMethods(modelName, methodName) {
          if (modelName === "Task" && methodName === "reverseName") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const func = schema.getMutationType().getFields().classMethods.type.getFields().Task.type.getFields();
    expect(func.reverseName2).toBeDefined();
    return expect(func.reverseName).not.toBeDefined();
  });


  it("mutation model - update field permissions", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        mutationUpdateInput(modelName, fieldName, options) {
          if (modelName === "Task" && fieldName === "options2") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const {args} = schema.getMutationType().getFields().models.type.getFields().Task;
    const updateField = args.find((a: any) => a.name === "update");
    const updateFieldTypeInputFields = updateField.type.ofType.getFields().input.type.getFields();
    return expect(updateFieldTypeInputFields.options2).toBeUndefined();
  });

  it("mutation model - create field permissions", async() => {
    const instance = await createInstance();
    const schema = await createSchema(instance, {
      permission: {
        mutationCreateInput(modelName, fieldName) {
          if (modelName === "Task" && fieldName === "options2") {
            return false;
          }
          return true;
        },
      },
    }) as any;
    const {args} = schema.getMutationType().getFields().models.type.getFields().Task;
    const field = args.find((a: any) => a.name === "create");
    const fieldTypeInputFields = field.type.ofType.getFields();
    return expect(fieldTypeInputFields.options2).toBeUndefined();
  });

  // it("subscription", async() => {
  //   const pubsub = new PubSub();

  //   const instance = await createInstance({subscriptions: {pubsub}});
  //   // const {Task} = sqlInstance.models;
  //   const schema = await createSchema(instance, {
  //     permission: {
  //       subscription(modelName, hookName) {
  //         if (modelName === "Task" && hookName === "afterCreate") {
  //           return false;
  //         }
  //         return true;
  //       },
  //     },
  //   });
  //   expect(schema.getSubscriptionType().getFields().afterCreateTask).not.toBeDefined();
  //   return expect(schema.getSubscriptionType().getFields().afterUpdateTask).toBeDefined();
  // });
});
