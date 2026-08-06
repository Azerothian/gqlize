import Sequelize from "sequelize";
import { validateSchema } from "graphql";
import { Ormize as Database } from "@azerothian/ormize";
import { describe, it, expect } from "@jest/globals";

import { createSchema } from "../src";
import { createAdapterForDialect, registerTeardown } from "./helper/dialect";

// Every definition here opts out of Sequelize's automatic `createdAt`/`updatedAt`
// columns: those are ordinary fields, so leaving them on would keep the types
// under test non-empty and the cases would prove nothing.
async function createInstance(definitions: any[]) {
  const db = new Database();
  const { adapter, name, teardown } = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
  definitions.forEach((definition) => db.addDefinition({ options: { timestamps: false }, ...definition }));
  await db.initialise();
  await db.sync();
  return db;
}

const survivor = {
  name: "Survivor",
  define: {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: Sequelize.STRING },
  },
};

describe("permissions - types emptied by restrictions", () => {
  it("omits a model whose every field is denied", async() => {
    // `Coded`'s primary key is not called `id`, so it does not get the blanket
    // allowance `isFieldAllowed` grants that one name — every field is denied and
    // the output type would have no fields at all.
    const instance = await createInstance([{
      name: "Coded",
      define: {
        code: { type: Sequelize.STRING, primaryKey: true },
        label: { type: Sequelize.STRING },
      },
    }, survivor]);
    const schema: any = await createSchema(instance, {
      permission: {
        field(modelName: string) {
          return modelName !== "Coded";
        },
      },
    });
    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getType("Coded")).not.toBeDefined();
    const queryFields = schema.getQueryType().getFields().models.type.getFields();
    expect(queryFields.Coded).not.toBeDefined();
    expect(queryFields.Survivor).toBeDefined();
  });

  it("omits a model left with only a relationship to an omitted model", async() => {
    // Dropping `Leaf` empties `Branch`, whose only surviving field was the
    // relationship to it — resolving visibility needs a fixpoint, not one pass.
    const instance = await createInstance([{
      name: "Branch",
      define: { code: { type: Sequelize.STRING, primaryKey: true } },
      relationships: [{
        type: "hasMany",
        model: "Leaf",
        name: "leaves",
        options: { as: "leaves", foreignKey: "branchCode" },
      }],
    }, {
      name: "Leaf",
      define: {
        code: { type: Sequelize.STRING, primaryKey: true },
        label: { type: Sequelize.STRING },
      },
      relationships: [{
        type: "belongsTo",
        model: "Branch",
        name: "branch",
        options: { foreignKey: "branchCode" },
      }],
    }, survivor]);
    const schema: any = await createSchema(instance, {
      permission: {
        field(modelName: string) {
          return modelName !== "Leaf" && modelName !== "Branch";
        },
        // Without this `Leaf.branch` and `Branch.leaves` would keep each other
        // alive; denying one direction leaves `Leaf` genuinely empty.
        relationship(modelName: string) {
          return modelName !== "Leaf";
        },
      },
    });
    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getType("Leaf")).not.toBeDefined();
    expect(schema.getType("Branch")).not.toBeDefined();
    expect(schema.getType("Survivor")).toBeDefined();
  });

  it("omits create and update mutations when no input field is writable", async() => {
    // `id` is a primary key and so structurally unwritable; denying `name` leaves
    // both `ThingRequiredInput` and `ThingOptionalInput` with no fields.
    const instance = await createInstance([{
      name: "Thing",
      define: {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: Sequelize.STRING },
      },
    }, survivor]);
    const schema: any = await createSchema(instance, {
      permission: {
        mutationCreateInput(modelName: string) {
          return modelName !== "Thing";
        },
        mutationUpdateInput(modelName: string) {
          return modelName !== "Thing";
        },
      },
    });
    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getType("ThingRequiredInput")).not.toBeDefined();
    expect(schema.getType("ThingOptionalInput")).not.toBeDefined();
    const thing = schema.getMutationType().getFields().models.type.getFields().Thing;
    // `delete` needs only the filter type, so the mutation itself survives.
    expect(thing.args.map((a: any) => a.name)).toEqual(["delete"]);
    expect(schema.getType("SurvivorRequiredInput")).toBeDefined();
  });

  it("omits a mutation whose every argument is denied", async() => {
    const instance = await createInstance([{
      name: "Thing",
      define: {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: Sequelize.STRING },
      },
    }, survivor]);
    const schema: any = await createSchema(instance, {
      permission: {
        mutationCreateInput(modelName: string) {
          return modelName !== "Thing";
        },
        mutationUpdateInput(modelName: string) {
          return modelName !== "Thing";
        },
        mutationDelete(modelName: string) {
          return modelName !== "Thing";
        },
      },
    });
    expect(validateSchema(schema)).toEqual([]);
    const mutationFields = schema.getMutationType().getFields().models.type.getFields();
    expect(mutationFields.Thing).not.toBeDefined();
    expect(mutationFields.Survivor).toBeDefined();
  });
});
