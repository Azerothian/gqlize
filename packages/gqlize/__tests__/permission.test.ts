import {createInstance} from "./helper";
import {createSchema} from "../src";
import { GraphQLObjectType } from 'graphql';
import {describe, it, expect, jest} from "@jest/globals";
import {
  BUILD_TIME_PERMISSION_KEYS,
  PERMISSION_KEYS,
  RESOLUTION_TIME_PERMISSION_KEYS,
  type Permission,
} from "@azerothian/utilize";
import {
  argInputObjectType,
  asInputObjectType,
  enumType,
  fieldOn,
  inputFieldInputObjectType,
  inputObjectType,
  mutationType,
  queryType,
  walkFields,
} from "./helper/graphql-introspection";

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
    });
    const taskFields = walkFields(queryType(schema), "models", "Task", "edges", "node").getFields();
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
    });
    const queryFields = walkFields(queryType(schema), "classMethods", "Task").getFields();
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
    });
    const queryFields = walkFields(queryType(schema), "classMethods", "Task").getFields();
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
    });
    const taskFields = walkFields(queryType(schema), "models", "Task", "edges", "node").getFields();
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
    });
    expect(schema.getType("GQLTTaskIncludeObject")).not.toBeDefined();
    const taskField = fieldOn(walkFields(queryType(schema), "models"), "Task");
    expect(taskField.args.find((a) => a.name === "include")).not.toBeDefined();
    // Sibling models are unaffected and keep their include argument.
    const taskItemField = walkFields(queryType(schema), "models").getFields().TaskItem;
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
    });
    const includeType = schema.getType("GQLTTaskIncludeObject");
    expect(includeType).toBeDefined();
    if (!includeType) {
      throw new Error("Expected GQLTTaskIncludeObject to be defined");
    }
    const includeFields = asInputObjectType(includeType).getFields();
    expect(includeFields.items).toBeDefined();
    expect(includeFields.item).not.toBeDefined();
    expect(includeFields.btmItems).not.toBeDefined();
  });
  it("type cache - a later build with a stricter permission re-gates the cached types", async() => {
    const instance = await createInstance();
    const open = await createSchema(instance);
    expect(Object.keys(inputObjectType(open, "GQLTQueryTaskWhere").getFields())).toContain("name");
    expect(enumType(open, "TaskOrderBy").getValues().map((v) => v.name)).toContain("nameASC");

    // Adapters cache the filter/order/include types by model name, so a second
    // build off the same instance used to hand back the first build's types and
    // silently ignore the stricter permission.
    const locked = await createSchema(instance, {
      permission: {
        field(modelName: string, fieldName: string) {
          return !(modelName === "Task" && fieldName === "name");
        },
      },
    });
    expect(Object.keys(inputObjectType(locked, "GQLTQueryTaskWhere").getFields())).not.toContain("name");
    expect(enumType(locked, "TaskOrderBy").getValues().map((v) => v.name)).not.toContain("nameASC");
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
    });
    const queryFields = walkFields(queryType(schema), "models").getFields();
    const mutationFields = walkFields(mutationType(schema), "models").getFields();
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
    });
    const {args} = fieldOn(walkFields(mutationType(schema), "models"), "Task");
    expect(args.filter((a) => a.name === "delete")).toHaveLength(1);
    expect(args.filter((a) => a.name === "update")).toHaveLength(1);
    return expect(args.filter((a) => a.name === "create")).toHaveLength(0);
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
    });
    const {args} = fieldOn(walkFields(mutationType(schema), "models"), "Task");
    expect(args.filter((a) => a.name === "delete")).toHaveLength(1);
    expect(args.filter((a) => a.name === "update")).toHaveLength(0);
    return expect(args.filter((a) => a.name === "create")).toHaveLength(1);
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
    });
    const {args} = fieldOn(walkFields(mutationType(schema), "models"), "Task");
    expect(args.filter((a) => a.name === "delete")).toHaveLength(0);
    expect(args.filter((a) => a.name === "update")).toHaveLength(1);
    return expect(args.filter((a) => a.name === "create")).toHaveLength(1);
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
    });
    const func = walkFields(mutationType(schema), "classMethods", "Task").getFields();
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
    });
    const {args} = fieldOn(walkFields(mutationType(schema), "models"), "Task");
    const updateField = args.find((a) => a.name === "update");
    if (!updateField) {
      throw new Error('Expected an "update" argument');
    }
    const updateInputField = argInputObjectType(updateField).getFields().input;
    const updateFieldTypeInputFields = inputFieldInputObjectType(updateInputField).getFields();
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
    });
    const {args} = fieldOn(walkFields(mutationType(schema), "models"), "Task");
    const field = args.find((a) => a.name === "create");
    if (!field) {
      throw new Error('Expected a "create" argument');
    }
    const fieldTypeInputFields = argInputObjectType(field).getFields();
    return expect(fieldTypeInputFields.options2).toBeUndefined();
  });

  it("invokes every build-time permission predicate, and no resolution-time one", async() => {
    // The regression guard for "the permission model never runs": a predicate
    // that is never consulted is not a no-op, it is an ALLOW, so a key with no
    // call site silently widens the schema. Driven off BUILD_TIME_PERMISSION_KEYS
    // so a new key added to the bag has to come with a call site or fail here.
    //
    // The second half is the structural form of the rule that lets `scope` be
    // async: a schema builder cannot await, so a resolution-time predicate
    // called from here would resolve to a pending promise — which coerces to
    // `true`, i.e. to an unrestricted query. Asserting it is never called at
    // build time is what keeps that from being a comment.
    const {GraphQLString} = await import("graphql");
    const permission: Permission = {options: {role: "test"}};
    const mocks: Record<string, ReturnType<typeof jest.fn>> = {};
    (PERMISSION_KEYS as readonly string[]).forEach((key) => {
      if (key === "options") {
        return;
      }
      const fn = jest.fn((..._args: unknown[]) => true);
      mocks[key] = fn;
      // `Permission` is deliberately closed (no index signature), so a
      // misspelled key is a compile error for a real caller. Writing every
      // predicate in one loop off `PERMISSION_KEYS` needs an escape hatch for
      // that closedness — `unknown` rather than `any` since nothing here reads
      // the value back through this reference.
      (permission as unknown as Record<string, unknown>)[key] = fn;
    });

    const instance = await createInstance();
    await createSchema(instance, {
      extend: {
        query: {health: {type: GraphQLString, resolve: () => "ok"}},
        mutation: {ping: {type: GraphQLString, resolve: () => "pong"}},
      },
      permission,
    });

    const uncalled = (BUILD_TIME_PERMISSION_KEYS as readonly string[])
      .filter((key) => key !== "options" && mocks[key].mock.calls.length === 0);
    expect(uncalled).toEqual([]);

    const calledAtBuildTime = (RESOLUTION_TIME_PERMISSION_KEYS as readonly string[])
      .filter((key) => mocks[key].mock.calls.length > 0);
    expect(calledAtBuildTime).toEqual([]);
  });

  it("threads permission.options into every predicate", async() => {
    const options = {role: "test"};
    const model = jest.fn((_defName: string, _options?: unknown) => true);
    const field = jest.fn((_defName: string, _fieldName: string, _options?: unknown) => true);
    const instance = await createInstance();
    await createSchema(instance, {permission: {model, field, options}});

    expect(model.mock.calls.every((call) => call[call.length - 1] === options)).toBe(true);
    expect(field.mock.calls.every((call) => call[call.length - 1] === options)).toBe(true);
  });

  it("warns about an unknown permission key, and still builds", async() => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const instance = await createInstance();
      // `modle` is never read, so the model is allowed — the warning is the only
      // signal a JS caller gets. The `roundtrip` project builds twice, so assert
      // on the calls made rather than on a call count.
      // `as any` stands in for the JS caller: `Permission` is closed, so a
      // misspelled key is a compile error for a TS one.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- simulates a JS caller passing a misspelled key past the closed `Permission` type; no TS caller could construct this literal.
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
