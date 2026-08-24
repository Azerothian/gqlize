import { describe, it, expect, beforeAll } from "@jest/globals";
import Sequelize, { DataTypes } from "sequelize";
import { Ormize, createRoleBasedPermissions, DataType, DataTypes as OrmizeDataTypes } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { generateZodSchemas } from "../src";
import type { Definition } from "@azerothian/utilize";

const ItemDef: Definition = {
  name: "Item",
  define: {
    label: { type: DataTypes.STRING, allowNull: false },
  },
  options: { timestamps: false },
  relationships: [
    { type: "hasMany", model: "Task", name: "tasks", options: { foreignKey: "itemId" } },
  ],
};

const TaskDef: Definition = {
  name: "Task",
  define: {
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { len: { args: [1, 50] }, isAlphanumeric: true },
    },
    count: { type: DataTypes.INTEGER, allowNull: true, validate: { min: 0, max: 10 } },
    status: { type: DataTypes.ENUM("open", "closed"), allowNull: false, defaultValue: "open" },
    ref: { type: DataTypes.UUID, allowNull: false, defaultValue: Sequelize.UUIDV4 },
    // authored with an abstract ormize token (backward-compat write path)
    nickname: { type: OrmizeDataTypes.String, allowNull: true },
  },
  options: { timestamps: false },
  relationships: [
    { type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } },
  ],
};

async function buildOrm() {
  const orm = new Ormize();
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }), "sqlite");
  await orm.addDefinition(ItemDef);
  await orm.addDefinition(TaskDef);
  await orm.initialise();
  await orm.sync();
  return orm;
}

describe("ormize-zod4 - generateZodSchemas", () => {
  let orm: Ormize;
  beforeAll(async () => {
    orm = await buildOrm();
  });

  it("produces entity/create/update maps for each model", () => {
    const { entity, create, update } = generateZodSchemas(orm);
    expect(Object.keys(entity).sort()).toEqual(["Item", "Task"]);
    expect(create.Task).toBeDefined();
    expect(update.Task).toBeDefined();
  });

  it("entity accepts a full row and rejects a bad enum / bad type", () => {
    const { entity } = generateZodSchemas(orm);
    const row = { id: 1, name: "alpha", count: 3, status: "open", ref: "f47ac10b-58cc-4372-a567-0e02b2c3d479", nickname: null, itemId: 1 };
    expect(() => entity.Task.parse(row)).not.toThrow();
    expect(entity.Task.safeParse({ ...row, status: "nope" }).success).toBe(false);
    expect(entity.Task.safeParse({ ...row, name: 123 }).success).toBe(false);
  });

  it("create requires non-null/no-default fields and allows omitting auto/PK/defaulted", () => {
    const { create } = generateZodSchemas(orm);
    // name is required; status/ref have defaults; id is auto PK
    expect(create.Task.safeParse({}).success).toBe(false);
    expect(create.Task.safeParse({ name: "alpha" }).success).toBe(true);
  });

  it("update accepts an empty object and a partial", () => {
    const { update } = generateZodSchemas(orm);
    expect(update.Task.safeParse({}).success).toBe(true);
    expect(update.Task.safeParse({ name: "beta" }).success).toBe(true);
  });

  it("translates validators (len max, isAlphanumeric, numeric min/max)", () => {
    const { create } = generateZodSchemas(orm);
    expect(create.Task.safeParse({ name: "x".repeat(60) }).success).toBe(false); // len max 50
    expect(create.Task.safeParse({ name: "not valid!" }).success).toBe(false);   // non-alphanumeric
    expect(create.Task.safeParse({ name: "alpha", count: 999 }).success).toBe(false); // max 10
    expect(create.Task.safeParse({ name: "alpha", count: 5 }).success).toBe(true);
  });

  it("includes nested relations via z.lazy (eager-loaded child array / parent object)", () => {
    const { entity } = generateZodSchemas(orm);
    expect(entity.Item.shape).toHaveProperty("tasks");
    expect(entity.Task.shape).toHaveProperty("item");
    const item = { id: 1, label: "box", tasks: [{ id: 1, name: "alpha", count: null, status: "open", ref: "f47ac10b-58cc-4372-a567-0e02b2c3d479", nickname: null, itemId: 1 }] };
    expect(() => entity.Item.parse(item)).not.toThrow();
  });

  it("authored abstract DataTypes token behaves like a native type", () => {
    const { entity } = generateZodSchemas(orm);
    expect(entity.Task.shape).toHaveProperty("nickname");
    // nickname authored as OrmizeDataTypes.String -> string schema, nullable
    expect(entity.Task.safeParse({ id: 1, name: "alpha", count: null, status: "open", ref: "f47ac10b-58cc-4372-a567-0e02b2c3d479", nickname: "nick", itemId: 1 }).success).toBe(true);
  });

  it("orm.mapDataType maps native Sequelize type to abstract DataType", () => {
    expect(orm.mapDataType(DataTypes.STRING).type).toBe(DataType.String);
  });

  describe("permissions", () => {
    it("denied field is absent from the entity schema", () => {
      // defaultDeny:false so only the explicitly-denied field is gated out.
      const permission = createRoleBasedPermissions(
        "user",
        { user: { model: "allow", field: { Task: { name: "deny" } } } },
        { defaultDeny: false }
      );
      const { entity } = generateZodSchemas(orm, { permission });
      expect(entity.Task.shape).not.toHaveProperty("name");
      expect(entity.Task.shape).toHaveProperty("status");
    });

    it("denied mutationCreate omits the create schema for that model", () => {
      const permission = createRoleBasedPermissions(
        "user",
        { user: { model: "allow", mutationCreate: { Task: "deny" } } },
        { defaultDeny: false }
      );
      const { create } = generateZodSchemas(orm, { permission });
      expect(create.Task).toBeUndefined();
    });

    it("omitting permission yields the full schema", () => {
      const { entity } = generateZodSchemas(orm);
      expect(entity.Task.shape).toHaveProperty("name");
    });
  });
});
