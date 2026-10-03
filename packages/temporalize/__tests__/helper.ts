import { expect } from "@jest/globals";
import { DataTypes } from "sequelize";
import { Ormize } from "@azerothian/ormize";
import type { Definition } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { ApplicationFailure } from "@temporalio/common";
import { dialectConfig, trackConnection, testDialect } from "@azerothian/test-fixtures/dialect";

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
    // Declared under neither `expose` target: it keeps the read gate and the
    // call-and-return shape activities have always had for instance methods.
    describe(args) {
      return `${this.label}:${args?.suffix ?? ""}`;
    },
    /** Declared under `expose.instanceMethods.mutations`: a pre-commit transform. */
    relabel(params) {
      this.label = params?.to ?? `${this.label}!`;
    },
  },
  // Only `relabel` is declared. Both `expose` targets resolve to the one
  // `instanceMethods` namespace above, so the target a name appears under is the
  // only thing that says whether the activity reads or writes.
  expose: {
    instanceMethods: {
      mutations: { relabel: {} },
    },
  },
};

const TaskDef: Definition = {
  // Pin Task to the current dialect's adapter by name, so the datasource segment
  // in queue names reflects whichever project is running.
  datasource: testDialect(),
  name: "Task",
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

/**
 * Fresh, initialised and synced ormize (Item hasMany Task).
 *
 * Pass `{ suite: true }` when the orm is built once in a `beforeAll` and must
 * outlive per-test teardowns. Defaults to per-test, which is what `beforeEach`
 * callers need — otherwise PGlite's 8-connection cap is exhausted.
 */
export async function buildOrm(options: { suite?: boolean } = {}): Promise<Ormize> {
  seenContexts.length = 0;
  const orm = new Ormize();
  const adapter = new SequelizeAdapter({}, await dialectConfig());
  trackConnection(adapter, options);
  orm.registerAdapter(adapter, testDialect());
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
