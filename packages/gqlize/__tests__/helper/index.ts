
import { Ormize as Database } from "@azerothian/ormize";

import TaskModel from "./models/task";
import TaskItemModel from "./models/task-item";
import Item from "./models/item";
import Sequelize from "sequelize";
import { createAdapterForDialect, registerTeardown } from "./dialect";

export async function createInstance() {
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
  db.addDefinition(parentDef);
  db.addDefinition(childDef);
  db.addDefinition(TaskModel);
  db.addDefinition(TaskItemModel);
  db.addDefinition(Item);

  await db.initialise();
  await db.sync();
  return db;
}


export function validateResult(result: any) {
  if ((result.errors || []).length > 0) {
    console.log("Graphql Error", result.errors); //eslint-disable-line
    throw result.errors[0];
  }
}
