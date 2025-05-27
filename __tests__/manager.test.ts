import Database from "../src/manager";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/gqlize-adapter-sequelize";
// import ItemDef from "./models/item";
import TaskDef from "./helper/models/task";
import { GqlizeAdapter } from "../src/types";
// import TaskItemDef from "./models/task-item";
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";


test("manager - registerAdapter", () => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");
  expect(db.adapters.sqlite).not.toBeUndefined();
});

test("manager - registerAdapter - check default adapter", () => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");
  expect(db.defaultAdapter).toEqual("sqlite");
});

test("manager - registerAdapter - multi adapters", () => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite2");
  expect(db.defaultAdapter).toEqual("sqlite");
  expect(db.adapters.sqlite).not.toBeUndefined();
  expect(db.adapters.sqlite2).not.toBeUndefined();
});

test("manager - addDefinition", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");
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
  }) as GqlizeAdapter;
  db.registerAdapter(adapter, "sqlite");
  await db.addDefinition(TaskDef);
  const name = TaskDef.name || "";
  expect(db.getModelAdapter(name)).toEqual(adapter);
});


test("manager - processRelationship - hasMany - single adapter", async() => {
  const db = new Database();
  const sqlite = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter;

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
  }) as GqlizeAdapter;
  const sqlite2 = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter;
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
  }) as GqlizeAdapter;

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
  }) as GqlizeAdapter;
  const sqlite2 = new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter;
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


test("manager - resolveManyRelationship - hasMany", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");

  const itemDef = {
    name: "Item",
    define: {},
    relationships: [{
      type: "belongsTo",
      model: "Item",
      name: "parent",
      options: {
        as: "parent",
        foreignKey: "parentId",
      },
    }, {
      type: "hasMany",
      model: "Item",
      name: "children",
      options: {
        as: "children",
        foreignKey: "parentId",
      },
    }],
  };

  await db.addDefinition(itemDef);
  await db.initialise();
  await db.sync();
  const Item = db.getModel("Item");
  const parent = await Item.create({});
  await Item.create({
    parentId: parent.id,
  });
  await Item.create({
    parentId: parent.id,
  });
  const assoc = db.getAssociations(itemDef.name).children;
  const {total, models} = await db.resolveManyRelationship(itemDef.name, assoc, parent, {}, {}, {} as any);
  expect(total).toEqual(2);
  expect(models).toHaveLength(2);
});


test("manager - resolveManyRelationship - hasMany - with limit", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");

  const itemDef = {
    name: "Item",
    define: {},
    relationships: [{
      type: "belongsTo",
      model: "Item",
      name: "parent",
      options: {
        as: "parent",
        foreignKey: "parentId",
      },
    }, {
      type: "hasMany",
      model: "Item",
      name: "children",
      options: {
        as: "children",
        foreignKey: "parentId",
      },
    }],
  };

  await db.addDefinition(itemDef);
  await db.initialise();
  await db.sync();
  const Item = db.getModel("Item");
  const parent = await Item.create({});
  await Item.create({
    parentId: parent.id,
  });
  await Item.create({
    parentId: parent.id,
  });
  const assoc = db.getAssociations(itemDef.name).children;
  const {total, models} = await db.resolveManyRelationship(itemDef.name, assoc, parent, {
    first: 1,
  }, {}, {} as any);
  expect(total).toEqual(2);
  expect(models).toHaveLength(1);
});




test("manager - resolveManyRelationship - belongsToMany", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");

  const parentDef = {
    name: "Parent",
    define: {},
    relationships: [{
      type: "belongsToMany",
      model: "Child",
      name: "children",
      options: {
        as: "children",
        foreignKey: "parentId",
        through: {
          model: "Mapping",
        },
      },
    }],
  };
  const mappingDef = {
    name: "Mapping",
    define: {},
    relationships: [{
      type: "belongsTo",
      model: "Parent",
      name: "parent",
      options: {
        as: "parent",
        foreignKey: "parentId",
      },
    }, {
      type: "belongsTo",
      model: "Child",
      name: "child",
      options: {
        as: "child",
        foreignKey: "childId",
      },
    }],
  };
  const childDef = {
    name: "Child",
    define: {},
    relationships: [{
      type: "belongsToMany",
      model: "Parent",
      name: "parent",
      options: {
        as: "parent",
        through: {
          model: "Mapping",
        },
        foreignKey: "childId",
      },
    }],
  };

  await db.addDefinition(parentDef);
  await db.addDefinition(childDef);
  await db.addDefinition(mappingDef);
  await db.initialise();
  await db.sync();
  const Parent = db.getModel("Parent");
  const Child = db.getModel("Child");
  const parent = await Parent.create({});
  await parent.addChild(await Child.create({}));
  await parent.addChild(await Child.create({}));

  const assoc = db.getAssociations(parentDef.name).children;
  const {total, models} = await db.resolveManyRelationship(parentDef.name, assoc, parent, {}, {}, {} as any);
  expect(total).toEqual(2);
  expect(models).toHaveLength(2);
});


test("manager - resolveManyRelationship - belongsToMany - with limit", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");

  const parentDef = {
    name: "Parent",
    define: {},
    relationships: [{
      type: "belongsToMany",
      model: "Child",
      name: "children",
      options: {
        as: "children",
        foreignKey: "parentId",
        through: {
          model: "Mapping",
        },
      },
    }],
  };
  const mappingDef = {
    name: "Mapping",
    define: {},
    relationships: [{
      type: "belongsTo",
      model: "Parent",
      name: "parent",
      options: {
        as: "parent",
        foreignKey: "parentId",
      },
    }, {
      type: "belongsTo",
      model: "Child",
      name: "child",
      options: {
        as: "child",
        foreignKey: "childId",
      },
    }],
  };
  const childDef = {
    name: "Child",
    define: {},
    relationships: [{
      type: "belongsToMany",
      model: "Parent",
      name: "parent",
      options: {
        as: "parent",
        through: {
          model: "Mapping",
        },
        foreignKey: "childId",
      },
    }],
  };

  await db.addDefinition(parentDef);
  await db.addDefinition(childDef);
  await db.addDefinition(mappingDef);
  await db.initialise();
  await db.sync();
  const Parent = db.getModel("Parent");
  const Child = db.getModel("Child");
  const parent = await Parent.create({});
  await parent.addChild(await Child.create({}));
  await parent.addChild(await Child.create({}));

  const assoc = db.getAssociations(parentDef.name).children;
  const {total, models} = await db.resolveManyRelationship(parentDef.name, assoc, parent, {first: 1}, {}, {} as any);
  expect(total).toEqual(2);
  expect(models).toHaveLength(1);
});

test("manager - resolveSingleRelationship - belongsTo", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");

  const itemDef = {
    name: "Item",
    define: {},
    relationships: [{
      type: "belongsTo",
      model: "Item",
      name: "parent",
      options: {
        as: "parent",
        foreignKey: "parentId",
      },
    }, {
      type: "hasMany",
      model: "Item",
      name: "children",
      options: {
        as: "children",
        foreignKey: "parentId",
      },
    }],
  };

  await db.addDefinition(itemDef);
  await db.initialise();
  await db.sync();
  const Item = db.getModel("Item");
  const parent = await Item.create({});
  const child = await Item.create({
    parentId: parent.id,
  });
  const assoc = db.getAssociations(itemDef.name).parent;
  const model = await db.resolveSingleRelationship(itemDef.name, assoc, child, {}, {}, {});
  expect(model).toBeDefined();
  expect(model.id).toEqual(parent.id);
});

test("manager - resolveSingleRelationship - hasOne", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as GqlizeAdapter, "sqlite");

  const itemDef = {
    name: "Item",
    define: {},
    relationships: [{
      type: "hasOne",
      model: "Item",
      name: "test",
      options: {
        as: "test",
        foreignKey: "testId",
      },
    }],
  };

  await db.addDefinition(itemDef);
  await db.initialise();
  await db.sync();
  const Item = db.getModel("Item");
  const test = await Item.create({});
  const parent = await Item.create({
    testId: test.id,
  });
  const assoc = db.getAssociations(itemDef.name).test;
  const model = await db.resolveSingleRelationship(itemDef.name, assoc, test, {}, {}, {});
  expect(model).toBeDefined();
  expect(model.id).toEqual(parent.id);
});



//TODO: need to work on cross adapter relations
// test("manager - belongsTo - multi adapter", async() => {
//   const db = new Database();
//   const sqlite = new SequelizeAdapter({}, {
//     dialect: "sqlite",
//   });
//   const sqlite2 = new SequelizeAdapter({}, {
//     dialect: "sqlite",
//   });
//   db.registerAdapter(sqlite, "sqlite");
//   db.registerAdapter(sqlite2, "sqlite2");
//   const parentDef = {
//     name: "Parent",
//     define: {
//       name: {
//         type: Sequelize.STRING,
//         allowNull: false,
//       },
//     },
//     relationships: [{
//       type: "hasMany",
//       model: "Child",
//       name: "children",
//       options: {
//         foreignKey: "parentId",
//       },
//     }],
//   };
//   const childDef = {
//     name: "Child",
//     define: {
//       parentId: {
//         type: Sequelize.INTEGER,
//         allowNull: false,
//       },
//     },
//     relationships: [{
//       type: "belongsTo",
//       model: "Parent",
//       name: "parent",
//       options: {
//         foreignKey: "parentId",
//       },
//     }],
//   };
//   await db.addDefinition(parentDef, "sqlite");
//   await db.addDefinition(childDef, "sqlite2");
//   await db.initialise();
//   const ParentModel = db.getModel("Parent");
//   const ChildModel = db.getModel("Child");
//   const parentModel = await ParentModel.create({
//     name: "parent",
//   });
//   const childModel = await ChildModel.create({
//     parentId: parentModel.id,
//     name: "childModel",
//   });
//   const parent = await childModel.getParent();
//   expect(Array.isArray(parent)).toEqual(false);
//   expect(parent.name).toEqual(parentModel.name);
// });



// TODO - need to work on cross adapater relations
// test("manager - hasMany - multi adapter", async() => {
//   const db = new Database();
//   const sqlite = new SequelizeAdapter({}, {
//     dialect: "sqlite",
//   });
//   const sqlite2 = new SequelizeAdapter({}, {
//     dialect: "sqlite",
//   });
//   db.registerAdapter(sqlite, "sqlite");
//   db.registerAdapter(sqlite2, "sqlite2");
//   const parentDef = {
//     name: "Parent",
//     define: {
//       name: {
//         type: Sequelize.STRING,
//         allowNull: false,
//       },
//     },
//     relationships: [{
//       type: "hasMany",
//       model: "Child",
//       name: "children",
//       options: {
//         foreignKey: "parentId",
//       },
//     }],
//   };
//   const childDef = {
//     name: "Child",
//     define: {
//       parentId: {
//         type: Sequelize.INTEGER,
//         allowNull: false,
//       },
//     },
//     relationships: [],
//   };
//   await db.addDefinition(parentDef, "sqlite");
//   await db.addDefinition(childDef, "sqlite2");
//   await db.initialise();
//   const ParentModel = db.getModel("Parent");
//   const ChildModel = db.getModel("Child");
//   const parentModel = await ParentModel.create({
//     name: "parent",
//   });
//   const childModel = await ChildModel.create({
//     parentId: parentModel.id,
//     name: "childModel",
//   });
//   const children = await parentModel.getChildren();
//   expect(children).toHaveLength(1);
//   expect(children[0].name).toEqual(childModel.name);
// });
