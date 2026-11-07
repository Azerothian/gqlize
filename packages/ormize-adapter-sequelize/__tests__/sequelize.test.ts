// Core adapter lifecycle, model creation, field and relationship introspection.
// Query building, resolution, and write operations are in `sequelize-query.test.ts`.

import SequelizeAdapter from "../src";
import ItemModel from "./helper/models/item";
import TaskModel from "./helper/models/task";
import TaskItemModel from "./helper/models/task-item";
import waterfall from "@azerothian/utilize/utils/waterfall";
import Sequelize, { Model } from "sequelize";
import type { Definition } from "@azerothian/utilize/types/index";
import type { SequelizeDefinition } from "../src/types";

/** The runtime-only descriptor branch of `classMethods` — see the comment at its one use below. */
type ClassMethodFn = NonNullable<Definition["classMethods"]>[string];


import { describe, expect, it } from "@jest/globals";
import { dialectConfig, trackConnection, testDialect } from "@azerothian/test-fixtures/dialect";

describe("core adapter", () => {
  it("adapter - getORM", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    expect(adapter.getORM()).not.toBeUndefined();
  });

  it("adapter - initialize", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.initialise();
    expect(adapter.getORM()).not.toBeUndefined();
  });

  it("adapter - reset", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.reset();
    expect(adapter.getORM()).not.toBeUndefined();
  });

  it("adapter - createModel", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.createModel(TaskModel);

    await adapter.reset();
    expect(adapter.getORM().models.Task).not.toBeUndefined();
  });
  it("adapter - getModel", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.createModel(TaskModel);
    await adapter.reset();
    expect(adapter.getModel("Task")).not.toBeUndefined();
  });
  it("adapter - getModels", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.createModel(TaskModel);
    await adapter.reset();
    expect(adapter.getModels().Task).not.toBeUndefined();
  });
  it("adapter - addInstanceFunction", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.createModel(TaskModel);
    adapter.addInstanceFunction("Task", "it", function(this: Model) {
      expect(this).toBeInstanceOf(adapter.getModel("Task"));
      return true;
    });
    await adapter.reset();
    const Task = adapter.getModel("Task");
    // `it` is installed dynamically by `addInstanceFunction` above, so it has
    // no place in `Task`'s own (Sequelize-generated) instance type.
    const task = new Task() as unknown as { it: () => boolean };
    expect(task.it()).toEqual(true);
  });

  it("adapter - addStaticFunction", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.createModel(TaskModel);
    adapter.addStaticFunction("Task", "it", function() {
      return true;
    });
    await adapter.reset();
    // `it` is installed dynamically by `addStaticFunction` above, so it has no
    // place in `Task`'s own (Sequelize-generated) static type.
    const Task = adapter.getModel("Task") as unknown as { it: () => boolean };
    expect(Task.it()).toEqual(true);
  });

  it("adapter - createRelationship", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.createModel(TaskModel);
    await adapter.createModel(TaskItemModel);
    await adapter.createModel(ItemModel);

    await waterfall([TaskModel, TaskItemModel, ItemModel], async(model) => {
      // `Definition.name` is optional on the type — a definition can be named by
      // the key it is registered under instead — but every fixture here declares
      // one, and `createRelationship` wants a `string`.
      const defName = model.name!;
      return waterfall(model.relationships, (rel) => {
        return adapter.createRelationship(defName, rel.model, rel.name, rel.type, rel.options);
      });
    });

    await adapter.reset();
    expect(adapter.getORM().models.Task).not.toBeUndefined();
    expect(adapter.getORM().models.TaskItem).not.toBeUndefined();
    expect(adapter.getORM().models.Item).not.toBeUndefined();
  });
  // The DDL and the call are Postgres (plpgsql): on Postgres both run for real
  // and the function's rows are asserted; SQLite has no stored procedures, so
  // there the query function is stubbed and only the wiring is checked.
  it("adapter - creaitoredProcedure", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));

    const itemDef: SequelizeDefinition = {
      name: "Item",
      define: {
        "name": {
          type: Sequelize.STRING,
          comment: "This is the name!",
          defaultValue: "it",
          allowNull: false,
        },
      },
      queries: {
        selectOne: {
          drop: `DROP FUNCTION IF EXISTS public."selectOne";`,
          create: `
          -- Note this drop function only works on PGSQL >=10
          -- PGSQL <= 9 needs argument definition to drop function

          -- FOR PGSQL 9 <=
          -- select format('DROP FUNCTION %s(%s);', p.oid::regproc, pg_get_function_identity_arguments(p.oid))
          -- FROM pg_catalog.pg_proc p LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          -- WHERE p.oid::regproc::text ilike '%selectOne%';


          CREATE OR REPLACE FUNCTION public."selectOne"(
            "start" int)
              RETURNS TABLE(id integer)
              LANGUAGE 'plpgsql'
              COST 15
              VOLATILE
          AS $BODY$

          BEGIN
            RETURN QUERY (SELECT "start");
          END
          $BODY$;`,
        },
      },
      classMethods: {
        // The stored-procedure descriptor form (`SqlClassMethod`, see
        // `installClassMethods`) is a runtime-only convention this adapter
        // branches on: the shared `Definition.classMethods` contract type
        // (published in `@azerothian/utilize`, out of this package's scope)
        // only describes the function form, so there is no way to express
        // this branch without an escape hatch. Cast narrowly to just this
        // property, referencing the contract's own function type rather than
        // restating its permissiveness with a literal `any` here.
        newStoredProcedure: {
          type: "sqlfunction",
          functionName: `selectOne`,
          // Bind names, in parameter order: each becomes `:name`, filled from
          // the call's argument of that name. This said `number` while the
          // call passes `start`, unnoticed for as long as the query was stubbed.
          args: ["start"],
        } as unknown as ClassMethodFn,
      },
    };
    await adapter.createModel(itemDef);
    const postgres = testDialect() === "postgres";
    if (!postgres) {
      // `Sequelize.query` is heavily overloaded; this replaces it wholesale with
      // a stub (stored procedures are not supported by sqlite) rather than
      // calling through, which only needs the one shape actually used below.
      (adapter.sequelize as unknown as { query: (q: unknown, options: unknown) => Promise<void> }).query =
        // eslint-disable-next-line @typescript-eslint/require-await -- must return `Promise<void>` to match `.query`'s real signature; there is nothing to await
        async() => undefined;
    }
    await adapter.reset();
    // `newStoredProcedure` is installed dynamically by `installClassMethods`
    // from the `SqlClassMethod` descriptor above, so it has no place in the
    // model's own (Sequelize-generated) static type.
    const result = await (adapter.getORM().models.Item as unknown as {
      newStoredProcedure: (args: unknown) => Promise<unknown>
    }).newStoredProcedure({
      start: 1,
    });
    expect(adapter.getORM().models.Item).not.toBeUndefined();
    // On Postgres the function really ran: `selectOne(1)` returns one row. The
    // SQLite stub returns nothing, so there only the wiring above is checked.
    const expected = postgres ? [{ id: 1 }] : result;
    expect(result).toEqual(expected);
  });



  it("adapter - createRelationship - belongsToMany", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    const itemDef = {
      name: "Item",
      define: {
        "name": {
          type: Sequelize.STRING,
          comment: "This is the name!",
          defaultValue: "it",
          allowNull: false,
        },
      },
      relationships: [{
        type: "belongsToMany",
        model: "ItemChild",
        name: "children",
        options: {
          through: {
            model: "ItemChildMap",
          },
          as: "children",
          foreignKey: "itemId",
        },
      }],
    };
    const itemChildMapDef = {
      name: "ItemChildMap",
      define: {},
      relationships: [{
        type: "belongsTo",
        model: "Item",
        name: "item",
        options: {
          as: "item",
          foreignKey: "itemId",
        },
      }],
    };
    const itemChildDef = {
      name: "ItemChild",
      define: {},
      relationships: [{
        type: "belongsToMany",
        model: "Item",
        name: "parents",
        options: {
          through: {
            model: "ItemChildMap",
          },
          as: "parents",
          foreignKey: "itemChildId",
        },
      }],
    };

    await adapter.createModel(itemDef);
    await adapter.createModel(itemChildMapDef);
    await adapter.createModel(itemChildDef);

    await waterfall([itemDef, itemChildMapDef, itemChildDef], async(model) => {
      return waterfall(model.relationships, (rel) => {
        return adapter.createRelationship(model.name, rel.model, rel.name, rel.type, rel.options);
      });
    });

    await adapter.reset();
    const {models} = adapter.getORM();
    expect(models.Item).toBeDefined();
    expect(models.ItemChildMap).toBeDefined();
    expect(models.ItemChild).toBeDefined();
  });

  it("adapter - createFunctionForFind", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.createModel(TaskModel);
    await adapter.reset();
    const Task = adapter.getModel("Task");
    const task = await Task.create({
      name: "ttttttttttttttt",
    });
    // `Model<any, any>`'s attributes aren't narrowed to this fixture's real
    // columns (a bare model handle, not the typed-generic form other tests
    // use), so read the id back through a local, narrowly-scoped shape.
    const taskId = (task as unknown as { id: unknown }).id;

    // `createFunctionForFind` and the function it returns are both
    // synchronous (they only return a promise, they don't await one).
    const func = adapter.createFunctionForFind("Task");
    const proxyFunc = func(taskId, "id", false);
    // `singular: false` above means this resolves the `findAll` branch, not
    // the `findOne` one — narrow to that instead of the two-branch union.
    const result = await proxyFunc() as unknown as Array<{ id: unknown }>;
    expect(result).not.toBeUndefined();
    expect(result).toHaveLength(1);
    expect(result[0].id).toEqual(taskId);
  });
  it("adapter - getPrimaryKeyNameForModel", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.createModel(TaskModel);
    await adapter.reset();
    const primaryKeyName = adapter.getPrimaryKeyNameForModel("Task");
    expect(primaryKeyName[0]).toEqual("id");
  });
  it("adapter - getValueFromInstance", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.createModel(TaskModel);
    await adapter.reset();
    const model = await adapter.getModel("Task").create({
      name: "111111111111111111",
    });
    expect(adapter.getValueFromInstance(model, "name")).toEqual("111111111111111111");
  });



  it("adapter - getFields - primary key", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    const itemDef = {
      name: "Item",
      define: {
        id: {type: Sequelize.UUID, allowNull: false, unique: true, primaryKey: true,
          defaultValue: Sequelize.UUIDV4,
        },
      },
      relationships: [],
    };
    await adapter.createModel(itemDef);
    await adapter.reset();
    const ItemFields = adapter.getFields("Item");
    expect(ItemFields).toBeDefined();
    expect(ItemFields.id).toBeDefined();
    expect(ItemFields.id.primaryKey).toEqual(true);
    expect(ItemFields.id.autoPopulated).toEqual(true);
    expect(ItemFields.id.allowNull).toEqual(false);
    expect(ItemFields.id.type).toBeInstanceOf(Sequelize.UUID);
  });

  it("adapter - getFields - define field", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    const itemDef = {
      name: "Item",
      define: {
        "name": {
          type: Sequelize.STRING,
          comment: "This is the name!",
          defaultValue: "it",
          allowNull: false,
        },
      },
      relationships: [],
    };
    await adapter.createModel(itemDef);
    await adapter.reset();
    const ItemFields = adapter.getFields("Item");
    expect(ItemFields).toBeDefined();
    expect(ItemFields.name).toBeDefined();
    expect(ItemFields.name.type).toBeInstanceOf(Sequelize.STRING);
    expect(ItemFields.name.allowNull).toEqual(false);
    expect(ItemFields.name.description).toEqual(itemDef.define.name.comment);
    expect(ItemFields.name.defaultValue).toEqual(itemDef.define.name.defaultValue);
  });

  it("adapter - getFields - relationship foreign keys", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    const itemDef = {
      name: "Item",
      define: {},
      relationships: [{
        type: "hasMany",
        model: "ItemChild",
        name: "children",
        options: {
          as: "children",
          foreignKey: "parentId",
        },
      }],
    };
    const itemChildDef = {
      name: "ItemChild",
      define: {},
      relationships: [{
        type: "belongsTo",
        model: "Item",
        name: "parent",
        options: {
          as: "parent",
          foreignKey: "parentId",
        },
      }],
    };
    await adapter.createModel(itemDef);
    await adapter.createModel(itemChildDef);
    await waterfall(itemDef.relationships, (rel) => {
      return adapter.createRelationship(itemDef.name, rel.model, rel.name, rel.type, rel.options);
    });
    await waterfall(itemChildDef.relationships, (rel) => {
      return adapter.createRelationship(itemChildDef.name, rel.model, rel.name, rel.type, rel.options);
    });
    await adapter.reset();
    const fields = adapter.getFields("ItemChild");
    expect(fields).toBeDefined();
    expect(fields.parentId).toBeDefined();
    expect(fields.parentId.foreignKey).toEqual(true);
    expect(fields.parentId.foreignTarget).toEqual("Item");
    expect(fields.parentId.type).toBeInstanceOf(Sequelize.INTEGER);
  });


  it("adapter - getFields - relationship not null foreign keys", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    const itemDef = {
      name: "Item",
      define: {
        "parentId": {
          type: Sequelize.INTEGER,
          comment: "This is the foreign key!",
          allowNull: false,
        },
      },
      relationships: [{
        type: "hasMany",
        model: "Item",
        name: "children",
        options: {
          as: "children",
          foreignKey: "parentId",
        },
      }, {
        type: "belongsTo",
        model: "Item",
        name: "parent",
        options: {
          as: "parent",
          foreignKey: "parentId",
        },
      }],
    };
    await adapter.createModel(itemDef);
    await waterfall(itemDef.relationships, (rel) => {
      return adapter.createRelationship(itemDef.name, rel.model, rel.name, rel.type, rel.options);
    });
    await adapter.reset();
    const ItemFields = adapter.getFields("Item");
    expect(ItemFields).toBeDefined();
    expect(ItemFields.parentId).toBeDefined();
    expect(ItemFields.parentId.allowNull).toEqual(false);
    expect(ItemFields.parentId.foreignKey).toEqual(true);
    expect(ItemFields.parentId.foreignTarget).toEqual("Item");
    expect(ItemFields.parentId.description).toEqual(itemDef.define.parentId.comment);
    expect(ItemFields.parentId.type).toBeInstanceOf(Sequelize.INTEGER);
  });


  it("adapter - getFields - timestamp fields", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    const itemDef = {
      name: "Item",
      define: {
        "name": {
          type: Sequelize.STRING,
          comment: "This is the name!",
          defaultValue: "it",
          allowNull: false,
        },
      },
      relationships: [{
        type: "hasMany",
        model: "Item",
        name: "children",
        options: {
          as: "children",
          foreignKey: "parentId",
        },
      }, {
        type: "belongsTo",
        model: "Item",
        name: "parent",
        options: {
          as: "parent",
          foreignKey: "parentId",
        },
      }],
    };
    await adapter.createModel(itemDef);
    await waterfall(itemDef.relationships, (rel) => {
      return adapter.createRelationship(itemDef.name, rel.model, rel.name, rel.type, rel.options);
    });
    await adapter.reset();
    const ItemFields = adapter.getFields("Item");
    expect(ItemFields).toBeDefined();
    expect(ItemFields.createdAt).toBeDefined();
    expect(ItemFields.createdAt.type).toBeInstanceOf(Sequelize.DATE);
    expect(ItemFields.createdAt.allowNull).toEqual(false);
    expect(ItemFields.createdAt.autoPopulated).toEqual(true);
  });



  it("adapter - getRelationships - hasMany", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    const itemDef = {
      name: "Item",
      define: {},
      relationships: [{
        type: "hasMany",
        model: "Item",
        name: "children",
        options: {
          as: "children",
          foreignKey: "parentId",
        },
      }, {
        type: "belongsTo",
        model: "Item",
        name: "parent",
        options: {
          as: "parent",
          foreignKey: "parentId",
        },
      }],
    };
    await adapter.createModel(itemDef);
    await waterfall(itemDef.relationships, (rel) => {
      return adapter.createRelationship(itemDef.name, rel.model, rel.name, rel.type, rel.options);
    });
    await adapter.reset();
    const rels = adapter.getAssociations("Item");
    expect(rels).toBeDefined();
    expect(rels.parent).toBeDefined();
    expect(rels.parent.name).toEqual("parent");
    expect(rels.parent.target).toEqual("Item");
    expect(rels.parent.source).toEqual("Item");
    expect(rels.parent.associationType).toEqual("belongsTo");
    expect(rels.parent.foreignKey).toEqual("parentId");
    expect(rels.parent.targetKey).toEqual("id");
    expect(rels.parent.accessors).toBeDefined();
    expect(rels.parent.accessors.get).toBeDefined();
    expect(rels.parent.accessors.set).toBeDefined();
    expect(rels.parent.accessors.create).toBeDefined();
  });


  it("adapter - getRelationships - belongsTo", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    const itemDef = {
      name: "Item",
      define: {},
      relationships: [{
        type: "hasMany",
        model: "Item",
        name: "children",
        options: {
          as: "children",
          foreignKey: "parentId",
        },
      }, {
        type: "belongsTo",
        model: "Item",
        name: "parent",
        options: {
          as: "parent",
          foreignKey: "parentId",
        },
      }],
    };
    await adapter.createModel(itemDef);
    await waterfall(itemDef.relationships, (rel) => {
      return adapter.createRelationship(itemDef.name, rel.model, rel.name, rel.type, rel.options);
    });
    await adapter.reset();
    const rels = adapter.getAssociations("Item");
    expect(rels).toBeDefined();
    expect(rels.children).toBeDefined();
    expect(rels.children.name).toEqual("children");
    expect(rels.children.target).toEqual("Item");
    expect(rels.children.source).toEqual("Item");
  });
});
