// Relationship resolvers (resolveManyRelationship / resolveSingleRelationship) are
// GraphQL-layer methods on the gqlize binding; they wrap an ormize (Ormize) instance.
import { Ormize as Database } from "@azerothian/ormize";
import GqlizeBinding from "../src/manager";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { OrmAdapter } from "@azerothian/utilize/types/index";
import {test,describe, it, beforeAll, beforeEach, expect} from "@jest/globals";

test("manager - resolveManyRelationship - hasMany", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");

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
  const {total, models} = await new GqlizeBinding(db).resolveManyRelationship(itemDef.name, assoc, parent, {}, {});
  expect(total).toEqual(2);
  expect(models).toHaveLength(2);
});


test("manager - resolveManyRelationship - hasMany - with limit", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");

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
  const {total, models} = await new GqlizeBinding(db).resolveManyRelationship(itemDef.name, assoc, parent, {
    first: 1,
  }, {});
  expect(total).toEqual(2);
  expect(models).toHaveLength(1);
});




test("manager - resolveManyRelationship - belongsToMany", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");

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
  const {total, models} = await new GqlizeBinding(db).resolveManyRelationship(parentDef.name, assoc, parent, {}, {});
  expect(total).toEqual(2);
  expect(models).toHaveLength(2);
});


test("manager - resolveManyRelationship - belongsToMany - with limit", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");

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
  const {total, models} = await new GqlizeBinding(db).resolveManyRelationship(parentDef.name, assoc, parent, {first: 1}, {});
  expect(total).toEqual(2);
  expect(models).toHaveLength(1);
});

test("manager - resolveSingleRelationship - belongsTo", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");

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
  const model = await new GqlizeBinding(db).resolveSingleRelationship(itemDef.name, assoc, child, {}, {});
  expect(model).toBeDefined();
  expect((model as {id: number}).id).toEqual(parent.id);
});

test("manager - resolveSingleRelationship - hasOne", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }) as OrmAdapter, "sqlite");

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
  const model = await new GqlizeBinding(db).resolveSingleRelationship(itemDef.name, assoc, test, {}, {});
  expect(model).toBeDefined();
  expect((model as {id: number}).id).toEqual(parent.id);
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
