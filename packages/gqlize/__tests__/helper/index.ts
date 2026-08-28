
import { Ormize as Database } from "@azerothian/ormize";

import TaskModel from "./models/task";
import TaskItemModel from "./models/task-item";
import Item from "./models/item";
import MemoModel from "./models/memo";
import Sequelize from "sequelize";
import { createAdapterForDialect, registerTeardown } from "./dialect";
import type {Definition} from "../../src/types";

/**
 * `extraDefinitions` exists so a test can exercise a definition shape without
 * editing the shared models — `schema-golden.test.ts` pins the SDL these six
 * produce, and any edit to them churns that snapshot for unrelated reasons.
 */
export async function createInstance(extraDefinitions: Definition[] = []) {
  const db = new Database();
  const { adapter, name, teardown } = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
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
  await db.addDefinition(TaskModel);
  await db.addDefinition(TaskItemModel);
  await db.addDefinition(Item);
  await db.addDefinition(MemoModel);
  for (const definition of extraDefinitions) {
    await db.addDefinition(definition);
  }

  await db.initialise();
  await db.sync();
  return db;
}


export function validateResult(result: {errors?: readonly unknown[] | null}) {
  const errors = result.errors || [];
  if (errors.length > 0) {
    console.log("Graphql Error", errors);
    throw errors[0] as Error;
  }
}

/**
 * A graphql result read as the shape the query asked for.
 *
 * `ExecutionResult["data"]` is an index of `unknown`, so every assertion on a
 * selected field would otherwise need a cast of its own. Naming the shape once
 * per test says what the query returns and keeps the assertions readable.
 * Call {@link validateResult} first — this does not check `errors`.
 */
export function resultData<T>(result: {data?: unknown}): T {
  return result.data as T;
}
