import { expect } from "@jest/globals";
import { DataTypes } from "sequelize";
import { Ormize } from "@azerothian/ormize";
import type { Definition } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { ApplicationFailure } from "@temporalio/common";

/** Contexts seen by `definition.before`, so tests can assert context propagation. */
export const seenContexts: unknown[] = [];

const ItemDef: Definition = {
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
  before(options) {
    seenContexts.push(options.context);
    return options.params;
  },
  classMethods: {
    async labelsUpper(args) {
      const rows = await this.findAll({ where: args?.where });
      return rows.map((r: { label?: string }) => String(r.label || "").toUpperCase());
    },
  },
  instanceMethods: {
    describe(args) {
      return `${this.label}:${args?.suffix ?? ""}`;
    },
  },
};

const TaskDef: Definition = {
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
export async function buildOrm(): Promise<Ormize> {
  seenContexts.length = 0;
  const orm = new Ormize();
  orm.registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite", logging: false }), "sqlite");
  await orm.addDefinition(ItemDef);
  await orm.addDefinition(TaskDef);
  await orm.initialise();
  await orm.sync();
  return orm;
}

/** Context shape every test call carries: an identity and a role, plus whatever a test spreads onto it. */
export type TestContext = { userId: string; role: string; [key: string]: unknown };

/** The context every test call carries: an identity and a role. */
export const ctx: TestContext = { userId: "u1", role: "admin" };

/** Assert a promise rejects with a non-retryable ApplicationFailure of `type`. */
export async function expectFailure(promise: Promise<unknown>, type: string): Promise<ApplicationFailure> {
  try {
    await promise;
  } catch (e) {
    if (!(e instanceof ApplicationFailure)) {
      throw e;
    }
    expect(e.name).toBe("ApplicationFailure");
    expect(e.nonRetryable).toBe(true);
    expect(e.type).toBe(type);
    return e;
  }
  throw new Error(`expected the call to fail with ${type}, but it resolved`);
}
