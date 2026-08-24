import Database from "../src/manager";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
// import ItemDef from "./models/item";
import TaskDef from "./helper/models/task";
import { Definition, OrmAdapter } from "../src/types";
// import TaskItemDef from "./models/task-item";
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";


test("manager - registerAdapter", () => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");
  expect(db.adapters.sqlite).not.toBeUndefined();
});

test("manager - registerAdapter - check default adapter", () => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");
  expect(db.defaultAdapter).toEqual("sqlite");
});

test("manager - registerAdapter - multi adapters", () => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite2");
  expect(db.defaultAdapter).toEqual("sqlite");
  expect(db.adapters.sqlite).not.toBeUndefined();
  expect(db.adapters.sqlite2).not.toBeUndefined();
});

test("manager - addDefinition", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");
  await db.addDefinition(TaskDef);
  const name = TaskDef.name || "";
  expect(db.defs[name]).not.toBeUndefined();
  expect(db.defsAdapters[name]).toEqual("sqlite");
  expect(db.models[name]).not.toBeUndefined();
  expect(db.adapters.sqlite.getModel(name)).not.toBeUndefined();
});

test("manager - getModelAdapter", async() => {
  const db = new Database();
  const adapter = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter;
  db.registerAdapter(adapter, "sqlite");
  await db.addDefinition(TaskDef);
  const name = TaskDef.name || "";
  expect(db.getModelAdapter(name)).toEqual(adapter);
});


test("manager - processRelationship - hasMany - single adapter", async() => {
  const db = new Database();
  const sqlite = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter;

  db.registerAdapter(sqlite, "sqlite");
  const def = {
    name: "TestItem",
    define: {},
    relationships: [{
      type: "hasMany",
      model: "TestItem",
      name: "items",
      options: {
        foreignKey: "taskId",
      },
    }],
  };
  await db.addDefinition(def);
  await db.processRelationship(def, db.getModelAdapter("TestItem"), def.relationships[0]);
  expect(db.relationships.TestItem).not.toBeUndefined();
  expect(db.relationships.TestItem.items).not.toBeUndefined();
  expect(db.relationships.TestItem.items.internal).toEqual(true);
  expect(db.relationships.TestItem.items.sourceAdapter).toEqual(sqlite);
  expect(db.relationships.TestItem.items.targetAdapter).toEqual(sqlite);
});

test("manager - processRelationship - hasMany - multi adapter", async() => {
  const db = new Database();
  const sqlite = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter;
  const sqlite2 = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter;
  db.registerAdapter(sqlite, "sqlite");
  db.registerAdapter(sqlite2, "sqlite2");
  const parentDef = {
    name: "Parent",
    define: {},
    relationships: [{
      type: "hasMany",
      model: "Child",
      name: "children",
      options: {
        foreignKey: "parentId",
      },
    }],
  };
  const childDef = {
    name: "Child",
    define: {},
    relationships: [{
      type: "belongsTo",
      model: "Parent",
      name: "parent",
      options: {
        foreignKey: "taskId",
        sourceKey: "id",
      },
    }],
  };
  await db.addDefinition(parentDef, "sqlite");
  await db.addDefinition(childDef, "sqlite2");
  await db.processRelationship(parentDef, db.getModelAdapter("Parent"), parentDef.relationships[0]);
  const ParentModel = db.getModel("Parent") as any;
  expect(db.relationships.Parent).toBeDefined();
  expect(db.relationships.Parent.children).toBeDefined();
  expect(db.relationships.Parent.children.internal).toEqual(false);
  expect(db.relationships.Parent.children.sourceAdapter).toEqual(sqlite);
  expect(db.relationships.Parent.children.targetAdapter).toEqual(sqlite2);
  expect(ParentModel.prototype.getChildren).toBeDefined();
  const test = new ParentModel();
  expect(test.getChildren).toBeDefined();
});


test("manager - processRelationship - belongsTo - single adapter", async() => {
  const db = new Database();
  const sqlite = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter;

  db.registerAdapter(sqlite, "sqlite");
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
        foreignKey: "parentId",
      },
    }],
  };
  const childDef = {
    name: "Child",
    define: {
      parentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
    },
    relationships: [{
      type: "belongsTo",
      model: "Parent",
      name: "parent",
      options: {
        foreignKey: "parentId",
      },
    }],
  };
  await db.addDefinition(parentDef);
  await db.addDefinition(childDef);
  await db.processRelationship(parentDef, db.getModelAdapter("Parent"), parentDef.relationships[0]);
  await db.processRelationship(childDef, db.getModelAdapter("Child"), childDef.relationships[0]);
  expect(db.relationships.Child).not.toBeUndefined();
  expect(db.relationships.Child.parent).not.toBeUndefined();
  expect(db.relationships.Child.parent.internal).toEqual(true);
  expect(db.relationships.Child.parent.sourceAdapter).toEqual(sqlite);
  expect(db.relationships.Child.parent.targetAdapter).toEqual(sqlite);
});




test("manager - processRelationship - belongsTo - multi adapter", async() => {
  const db = new Database();

  const sqlite = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter;
  const sqlite2 = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter;
  db.registerAdapter(sqlite, "sqlite");
  db.registerAdapter(sqlite2, "sqlite2");

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
        foreignKey: "parentId",
      },
    }],
  };
  const childDef = {
    name: "Child",
    define: {
      parentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
    },
    relationships: [{
      type: "belongsTo",
      model: "Parent",
      name: "parent",
      options: {
        foreignKey: "parentId",
      },
    }],
  };
  await db.addDefinition(parentDef);
  await db.addDefinition(childDef, "sqlite2");
  await db.processRelationship(parentDef, db.getModelAdapter("Parent"), parentDef.relationships[0]);
  await db.processRelationship(childDef, db.getModelAdapter("Child"), childDef.relationships[0]);

  const ChildModel = db.getModel("Child") as any;
  expect(db.relationships.Child).toBeDefined();
  expect(db.relationships.Child.parent).toBeDefined();
  expect(db.relationships.Child.parent.internal).toEqual(false);
  expect(db.relationships.Child.parent.sourceAdapter).toEqual(sqlite2);
  expect(db.relationships.Child.parent.targetAdapter).toEqual(sqlite);
  expect(ChildModel.prototype.getParent).toBeDefined();
  const test = new ChildModel();
  expect(test.getParent).toBeDefined();
});


test("manager - processSelect without input returns rows instead of throwing", async() => {
  // `select` doubles as a find when no `input` is supplied. Every matched row is
  // still walked for nested relationship mutations, and that walk used to index
  // the absent input per association.
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");
  const parentDef: Definition = {
    name: "SelectParent",
    define: {
      name: {type: Sequelize.STRING, allowNull: false},
    },
    relationships: [{
      type: "hasMany",
      model: "SelectChild",
      name: "children",
      options: {foreignKey: "parentId"},
    }],
  };
  const childDef: Definition = {
    name: "SelectChild",
    define: {
      name: {type: Sequelize.STRING, allowNull: true},
    },
    relationships: [{
      type: "belongsTo",
      model: "SelectParent",
      name: "parent",
      options: {foreignKey: "parentId"},
    }],
  };
  await db.addDefinition(parentDef);
  await db.addDefinition(childDef);
  await db.initialise();
  await db.sync({force: true});
  await db.processCreate("SelectParent", null, {input: {name: "a"}}, {});

  const rows = await db.processSelect("SelectParent", null, {where: {name: "a"}}, {});
  expect(rows.length).toEqual(1);
});
