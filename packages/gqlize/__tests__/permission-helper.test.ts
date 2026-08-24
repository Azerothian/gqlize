import {createInstance} from "./helper";
import {createSchema} from "../src";
import { createRoleBasedPermissions as permissionHelper } from "@azerothian/ormize";
import type { RoleRules } from "@azerothian/utilize";
import { GraphQLObjectType } from 'graphql';

import {describe, it, expect} from "@jest/globals";
describe("permission helper", () => {

  it("basic test - no settings - defaults deny", async() => {
    const instance = await createInstance();
    const permission = permissionHelper("anything", {});
    const result = permission.model!("anything");
    expect(result).toBeFalsy();
    let e;
    try {
      await createSchema(instance, {
        permission,
      });
      expect(true).toBeFalsy();
    } catch (err) {
      e = err;
    }
    expect(e).toBeDefined();

    // // console.log("schema");
    // const queryFields = schema.getQueryType().getFields().models.type.getFields();
    // return expect(queryFields.Task).not.toBeDefined();
  });
  it("basic test - field/model/query - defaults deny", async() => {
    const instance = await createInstance();
    const permission = permissionHelper("anyone", {
      "someone": "deny",
      "anyone": {
        "query": "allow",
        "model": {
          "Task": "allow",
        },
        "field": {
          "Task": {
            "name": "allow",
          },
        },
      },
    });

    expect(permission.query!("Task")).toBeTruthy();
    expect(permission.query!("TaskItem")).toBeTruthy();

    expect(permission.model!("Task")).toBeTruthy();
    expect(permission.model!("TaskItem")).toBeFalsy();

    expect(permission.field!("Task", "name")).toBeTruthy();
    expect(permission.field!("Task", "options")).toBeFalsy();
    // expect(permission.field!("TaskItem", "name")).toBeFalsy();

    const schema = await createSchema(instance, {
      permission,
    });
    const queryFields = (schema.getQueryType()?.getFields().models?.type as GraphQLObjectType)?.getFields();
    expect(queryFields.Task).toBeDefined();
    // expect().toBeDefined();
    // console.log("queryFields.Task", schema.$sql2gql.types.Task.getFields());
    
    const fields = (schema.getType("Task") as GraphQLObjectType).getFields(); //schema.$sql2gql.types.Task.getFields();
    expect(fields.name).toBeDefined();
    expect(fields.options).not.toBeDefined();
    expect(queryFields.TaskItem).not.toBeDefined();
  });

  it("basic test - allow all on task - defaults deny", async() => {
    const permission = permissionHelper("anyone", {
      "someone": "deny",
      "anyone": {
        "query": {
          "Task": "allow",
        },
        "model": {
          "Task": "allow",
        },
        "field": {
          "Task": "allow",
        },
      },
    });
    expect(permission.query!("Task")).toBeTruthy();
    expect(permission.field!("Task", "name")).toBeTruthy();
  });

  it("extend fields are denied under defaultDeny, and grantable by key", async() => {
    // The 7.0 security fix: 6.x emitted no `queryExtension`, so an absent
    // predicate meant ALLOW and every `options.extend.query` root field slipped
    // past a defaultDeny role.
    const {GraphQLString} = await import("graphql");
    const extend = {
      query: {
        health: {type: GraphQLString, resolve: () => "ok"},
        secret: {type: GraphQLString, resolve: () => "nope"},
      },
    };
    // Annotated rather than inline: a `const` without a contextual type widens
    // `"allow"` to `string`, which is no longer assignable to `RuleDecision`.
    const rules: RoleRules = {
      anyone: {
        query: {Task: "allow"},
        model: {Task: "allow"},
        field: {Task: "allow"},
        queryExtension: {health: "allow"},
      },
    };

    const permission = permissionHelper("anyone", rules);
    expect(permission.queryExtension!("health")).toBeTruthy();
    expect(permission.queryExtension!("secret")).toBeFalsy();

    const instance = await createInstance();
    const schema = await createSchema(instance, {extend, permission});
    expect(schema.getQueryType()?.getFields().health).toBeDefined();
    expect(schema.getQueryType()?.getFields().secret).not.toBeDefined();
  });

  it("a field granted for reading is writable as mutation input", async() => {
    // Without the mutationCreateInput -> field fallback a defaultDeny role would
    // deny every input field, emptying the input object and deleting the
    // create/update mutations outright.
    const permission = permissionHelper("anyone", {
      anyone: {
        query: {Task: "allow"},
        model: {Task: "allow"},
        field: {Task: {name: "allow"}},
        mutation: {Task: "allow"},
        mutationCreate: {Task: "allow"},
      },
    });
    expect(permission.mutationCreateInput!("Task", "name")).toBeTruthy();
    expect(permission.mutationCreateInput!("Task", "options")).toBeFalsy();

    const instance = await createInstance();
    const schema = await createSchema(instance, {permission});
    const {args} = (schema.getMutationType() as any).getFields().models.type.getFields().Task;
    const create = args.find((a: any) => a.name === "create");
    const inputFields = create.type.ofType.getFields();
    expect(inputFields.name).toBeDefined();
    expect(inputFields.options).not.toBeDefined();
  });
});
