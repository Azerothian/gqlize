import { expect } from "@jest/globals";
import { DataTypes } from "sequelize";
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";

/** Contexts seen by `definition.before`, so tests can assert context propagation. */
export const seenContexts: any[] = [];

const ItemDef: any = {
  name: "Item",
  define: {
    label: { type: DataTypes.STRING },
    // Stands in for a permission-denied column (e.g. a password hash): it must
    // never appear in an activity result, nor be filterable, when denied.
    secret: { type: DataTypes.STRING, allowNull: true },
  },
  options: { timestamps: false },
  relationships: [
    { type: "hasMany", model: "Task", name: "tasks", options: { foreignKey: "itemId" } },
  ],
  before(options: any) {
    seenContexts.push(options.context);
    return options.params;
  },
  classMethods: {
    async labelsUpper(this: any, args: any) {
      const rows = await this.findAll({ where: args?.where });
      return rows.map((r: any) => String(r.label || "").toUpperCase());
    },
  },
  instanceMethods: {
    async describe(this: any, args: any) {
      return `${this.label}:${args?.suffix ?? ""}`;
    },
  },
};

const TaskDef: any = {
  name: "Task",
  datasource: "sqlite",
  define: {
    name: { type: DataTypes.STRING, allowNull: false },
    done: { type: DataTypes.BOOLEAN, defaultValue: false },
    // Foreign keys are excluded from mutation input by default (mass-assignment
    // / IDOR guard); `writable: true` re-enables setting it directly.
    itemId: { type: DataTypes.INTEGER, allowNull: true, writable: true },
  },
  options: { timestamps: false },
  relationships: [
    { type: "belongsTo", model: "Item", name: "item", options: { foreignKey: "itemId" } },
  ],
};

/** Fresh, initialised and synced in-memory ormize (Item hasMany Task). */
export async function buildOrm(): Promise<any> {
  seenContexts.length = 0;
  const orm: any = new Ormize();
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  await orm.addDefinition(ItemDef);
  await orm.addDefinition(TaskDef);
  await orm.initialise();
  await orm.sync();
  return orm;
}

/** The context every test call carries: an identity and a role. */
export const ctx = { userId: "u1", role: "admin" };

/** Assert a promise rejects with a non-retryable ApplicationFailure of `type`. */
export async function expectFailure(promise: Promise<any>, type: string): Promise<any> {
  try {
    await promise;
  } catch (e: any) {
    expect(e.name).toBe("ApplicationFailure");
    expect(e.nonRetryable).toBe(true);
    expect(e.type).toBe(type);
    return e;
  }
  throw new Error(`expected the call to fail with ${type}, but it resolved`);
}
