import {createInstance} from "./helper";
import {createSchema} from "../src";
import { GraphQLObjectType } from 'graphql';
import {test,describe, it, beforeAll, beforeEach, expect, jest} from "@jest/globals";
import {PERMISSION_KEYS} from "@azerothian/utilize";

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
  it("relationship - denying every relationship omits the include type", async() => {
    const instance = await createInstance();
    // Task has three relationships (items, item, btmItems). Denying all of them
    // leaves GQLTTaskIncludeObject with no fields, which is an invalid GraphQL
    // input object — it must be dropped rather than emitted empty.
    const schema = await createSchema(instance, {
      permission: {
        relationship(modelName) {
          return modelName !== "Task";
        },
      },
    }) as any;
    expect(schema.getType("GQLTTaskIncludeObject")).not.toBeDefined();
    const taskField = schema.getQueryType().getFields().models.type.getFields().Task;
    expect(taskField.args.find((a: any) => a.name === "include")).not.toBeDefined();
    // Sibling models are unaffected and keep their include argument.
    const taskItemField = schema.getQueryType().getFields().models.type.getFields().TaskItem;
    expect(taskItemField).toBeDefined();
  });
  it("model - denied datatypes are excluded from include types", async() => {
    const instance = await createInstance();
    // Task.item and Task.btmItems both target Item; only Task.items (TaskItem)
    // should survive.
    const schema = await createSchema(instance, {
      permission: {
        model(modelName) {
          return modelName !== "Item";
        },
      },
    }) as any;
    const includeType = schema.getType("GQLTTaskIncludeObject");
    expect(includeType).toBeDefined();
    const includeFields = includeType.getFields();
    expect(includeFields.items).toBeDefined();
    expect(includeFields.item).not.toBeDefined();
    expect(includeFields.btmItems).not.toBeDefined();
  });
  it("type cache - a later build with a stricter permission re-gates the cached types", async() => {
    const instance = await createInstance();
    const open: any = await createSchema(instance);
    expect(Object.keys(open.getType("GQLTQueryTaskWhere").getFields())).toContain("name");
    expect(open.getType("TaskOrderBy").getValues().map((v: any) => v.name)).toContain("nameASC");

    // Adapters cache the filter/order/include types by model name, so a second
    // build off the same instance used to hand back the first build's types and
    // silently ignore the stricter permission.
    const locked: any = await createSchema(instance, {
      permission: {
        field(modelName: string, fieldName: string) {
          return !(modelName === "Task" && fieldName === "name");
        },
      },
    });
    expect(Object.keys(locked.getType("GQLTQueryTaskWhere").getFields())).not.toContain("name");
    expect(locked.getType("TaskOrderBy").getValues().map((v: any) => v.name)).not.toContain("nameASC");
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

  it("invokes every permission predicate", async() => {
    // The regression guard for "the permission model never runs": a predicate
    // that is never consulted is not a no-op, it is an ALLOW, so a key with no
    // call site silently widens the schema. Driven off PERMISSION_KEYS so a new
    // key added to the bag has to come with a call site or fail here.
    const {GraphQLString} = await import("graphql");
    const permission: any = {options: {role: "test"}};
    PERMISSION_KEYS.forEach((key) => {
      if (key !== "options") {
        permission[key] = jest.fn(() => true);
      }
    });

    const instance = await createInstance();
    await createSchema(instance, {
      extend: {
        query: {health: {type: GraphQLString, resolve: () => "ok"}},
        mutation: {ping: {type: GraphQLString, resolve: () => "pong"}},
      },
      permission,
    });

    const uncalled = PERMISSION_KEYS.filter((key) => key !== "options" && permission[key].mock.calls.length === 0);
    expect(uncalled).toEqual([]);
  });

  it("threads permission.options into every predicate", async() => {
    const options = {role: "test"};
    const model = jest.fn(() => true);
    const field = jest.fn(() => true);
    const instance = await createInstance();
    await createSchema(instance, {permission: {model, field, options}});

    expect(model.mock.calls.every((call: any[]) => call[call.length - 1] === options)).toBe(true);
    expect(field.mock.calls.every((call: any[]) => call[call.length - 1] === options)).toBe(true);
  });

  it("warns about an unknown permission key, and still builds", async() => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const instance = await createInstance();
      // `modle` is never read, so the model is allowed — the warning is the only
      // signal a JS caller gets. The `roundtrip` project builds twice, so assert
      // on the calls made rather than on a call count.
      const schema = await createSchema(instance, {permission: {modle: () => false}} as any);
      const warned = warn.mock.calls.some((call) => String(call[0]).includes("modle"));
      expect(warned).toBe(true);
      expect((schema.getQueryType()?.getFields().models.type as GraphQLObjectType)?.getFields().Task).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn about a valid permission bag", async() => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const instance = await createInstance();
      await createSchema(instance, {permission: {model: () => true, options: {role: "test"}}});
      const warned = warn.mock.calls.some((call) => String(call[0]).includes("permission"));
      expect(warned).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
