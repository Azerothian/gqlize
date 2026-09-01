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
import { GraphQLList } from "graphql";

describe("tests", () => {
  it("adapter - getORM", () => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    expect(adapter.getORM()).not.toBeUndefined();
  });

  it("adapter - initialize", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    await adapter.initialise();
    expect(adapter.getORM()).not.toBeUndefined();
  });

  it("adapter - reset", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    await adapter.reset();
    expect(adapter.getORM()).not.toBeUndefined();
  });

  it("adapter - createModel", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    await adapter.createModel(TaskModel);

    await adapter.reset();
    expect(adapter.getORM().models.Task).not.toBeUndefined();
  });
  it("adapter - getModel", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    await adapter.createModel(TaskModel);
    await adapter.reset();
    expect(adapter.getModel("Task")).not.toBeUndefined();
  });
  it("adapter - getModels", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    await adapter.createModel(TaskModel);
    await adapter.reset();
    expect(adapter.getModels().Task).not.toBeUndefined();
  });
  it("adapter - addInstanceFunction", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
  it("adapter - creaitoredProcedure", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });

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
          args: ["number"],
        } as unknown as ClassMethodFn,
      },
    };
    await adapter.createModel(itemDef);
    // `Sequelize.query` is heavily overloaded; this replaces it wholesale with
    // a stub (stored procedures are not supported by sqlite) rather than
    // calling through, which only needs the one shape actually used below.
    (adapter.sequelize as unknown as { query: (q: unknown, options: unknown) => Promise<void> }).query =
      // eslint-disable-next-line @typescript-eslint/require-await -- must return `Promise<void>` to match `.query`'s real signature; there is nothing to await
      async(q, options) => {
        //stop from writing to sqlite
        //as stored procedures are not supported
        console.log("q", {q, options});
      };
    await adapter.reset();
    // `newStoredProcedure` is installed dynamically by `installClassMethods`
    // from the `SqlClassMethod` descriptor above, so it has no place in the
    // model's own (Sequelize-generated) static type.
    await (adapter.getORM().models.Item as unknown as {
      newStoredProcedure: (args: unknown) => Promise<unknown>
    }).newStoredProcedure({
      start: 1,
    });
    expect(adapter.getORM().models.Item).not.toBeUndefined();
  });



  it("adapter - createRelationship - belongsToMany", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    await adapter.createModel(TaskModel);
    await adapter.reset();
    const primaryKeyName = adapter.getPrimaryKeyNameForModel("Task");
    expect(primaryKeyName[0]).toEqual("id");
  });
  it("adapter - getValueFromInstance", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    await adapter.createModel(TaskModel);
    await adapter.reset();
    const model = await adapter.getModel("Task").create({
      name: "111111111111111111",
    });
    expect(adapter.getValueFromInstance(model, "name")).toEqual("111111111111111111");
  });



  it("adapter - getFields - primary key", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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


  it("adapter - getDefaultListArgs", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
    const defaultArgs = adapter.getDefaultListArgs(itemDef.name, itemDef);
    expect(defaultArgs).toBeDefined();
    expect(defaultArgs.where).toBeDefined();
  });

  it("adapter - include - getDefaultListArgs", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
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
          foreignKey: "itemId",
        },
      }, {
        type: "belongsTo",
        model: "Item",
        name: "parent",
        options: {
          as: "parent",
          foreignKey: "itemId",
        },
      }],
    };
    await adapter.createModel(itemDef);
    const defaultArgs = adapter.getDefaultListArgs(itemDef.name, itemDef);
    expect(defaultArgs).toBeDefined();
    expect(defaultArgs.where).toBeDefined();
    expect(defaultArgs.include).toBeDefined();
    expect(defaultArgs.include.type).toBeDefined();
    expect(defaultArgs.include).toBeDefined();
  });

  it("adapter - include - all relationships denied omits the include type", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    const itemDef = {
      name: "Item",
      define: {
        "name": {
          type: Sequelize.STRING,
          allowNull: false,
        },
      },
      relationships: [{
        type: "hasMany",
        model: "Item",
        name: "children",
        options: {
          as: "children",
          foreignKey: "itemId",
        },
      }],
    };
    await adapter.createModel(itemDef);
    const permission = {
      relationship: () => false,
    };
    // An input object with no fields is invalid GraphQL — the type must not exist
    // at all, and the `include` arg must be dropped along with it.
    expect(adapter.getIncludeGraphQLType(itemDef.name, itemDef, permission)).not.toBeDefined();
    const defaultArgs = adapter.getDefaultListArgs(itemDef.name, itemDef, permission);
    expect(defaultArgs.where).toBeDefined();
    expect(defaultArgs.include).not.toBeDefined();
  });

  it("adapter - include - relationships to denied models are excluded", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    const secretDef = {
      name: "Secret",
      define: {
        "value": {
          type: Sequelize.STRING,
        },
      },
      relationships: [],
    };
    const itemDef = {
      name: "Item",
      define: {
        "name": {
          type: Sequelize.STRING,
        },
      },
      relationships: [{
        type: "hasMany",
        model: "Item",
        name: "children",
        options: {
          as: "children",
          foreignKey: "itemId",
        },
      }, {
        type: "hasMany",
        model: "Secret",
        name: "secrets",
        options: {
          as: "secrets",
          foreignKey: "itemId",
        },
      }],
    };
    await adapter.createModel(secretDef);
    await adapter.createModel(itemDef);
    const includeType = adapter.getIncludeGraphQLType(itemDef.name, itemDef, {
      model: (modelName: string) => modelName !== "Secret",
    });
    expect(includeType).toBeDefined();
    // A to-many relationship's include type is a list; narrow with a real
    // instance check rather than casting.
    if (!(includeType instanceof GraphQLList)) {
      throw new Error("expected a GraphQLList include type");
    }
    const includeFields = includeType.ofType.getFields();
    expect(includeFields.children).toBeDefined();
    // A denied datatype has no output type either, so it must not be joinable.
    expect(includeFields.secrets).not.toBeDefined();
  });

  it("adapter - orderBy - all fields denied omits the orderBy enum", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    // `isFieldAllowed` hard-allows a field literally named `id`, so an all-denied
    // orderBy is only reachable on a model with a differently named primary key.
    const codeDef = {
      name: "Coded",
      define: {
        "code": {
          type: Sequelize.STRING,
          primaryKey: true,
        },
        "label": {
          type: Sequelize.STRING,
        },
      },
      relationships: [],
    };
    await adapter.createModel(codeDef);
    expect(adapter.getOrderByGraphQLType(codeDef.name, {
      field: () => false,
    })).not.toBeDefined();
  });

  it("adapter - orderBy - allowed fields still produce an enum", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    const codeDef = {
      name: "Coded",
      define: {
        "code": {
          type: Sequelize.STRING,
          primaryKey: true,
        },
        "label": {
          type: Sequelize.STRING,
        },
      },
      relationships: [],
    };
    await adapter.createModel(codeDef);
    const orderBy = adapter.getOrderByGraphQLType(codeDef.name, {
      field: (_modelName: string, fieldName: string) => fieldName === "label",
    });
    expect(orderBy).toBeDefined();
    const valueNames = orderBy?.ofType.getValues().map((v) => v.name);
    expect(valueNames).toEqual(["labelASC", "labelDESC"]);
  });

  it("adapter - hasInlineCountFeature - sqlite", () => {
    const adapter = new SequelizeAdapter({
      disableInlineCount: false,
    }, {
      dialect: "sqlite",
    });
    const result = adapter.hasInlineCountFeature();
    expect(result).toEqual(true);
  });
  it("adapter - hasInlineCountFeature - disable inline count", () => {
    const adapter = new SequelizeAdapter({
      disableInlineCount: true,
    }, {
      dialect: "sqlite",
    });
    const result = adapter.hasInlineCountFeature();
    expect(result).toEqual(false);
  });

  it("adapter - hasInlineCountFeature - postgres", () => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    // Sequelize's own types don't publicly declare `.dialect` as an instance
    // property (only on the *Options* config type) — a genuine untyped
    // internal, narrowed here rather than casting the whole adapter.
    (adapter.sequelize as unknown as { dialect: { name: string } }).dialect.name = "postgres";
    const result = adapter.hasInlineCountFeature();
    expect(result).toEqual(true);
  });

  it("adapter - hasInlineCountFeature - mssql", () => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    (adapter.sequelize as unknown as { dialect: { name: string } }).dialect.name = "mssql";
    const result = adapter.hasInlineCountFeature();
    expect(result).toEqual(true);
  });


  it("adapter - processListArgsToOptions - hasInlineCount", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    const itemDef = {
      name: "Item",
      define: {},
      relationships: [],
    };
    await adapter.createModel(itemDef);

    const {getOptions, countOptions} = await adapter.processListArgsToOptions("Item", {
      args: {first: 1},
    });
    expect(countOptions).toBeUndefined();
    expect(getOptions).toBeDefined();
    expect(getOptions.limit).toEqual(1);
    expect(getOptions.attributes).toHaveLength(4);
    expect(getOptions.attributes[getOptions.attributes.length - 1]).toHaveLength(2);
    expect(getOptions.attributes[getOptions.attributes.length - 1][0].val).toEqual("COUNT(1) OVER()");
    expect(getOptions.attributes[getOptions.attributes.length - 1][1]).toEqual("full_count");
  });

  it("adapter - processListArgsToOptions - hasInlineCount - full_count args already exist", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    const itemDef = {
      name: "Item",
      define: {},
      relationships: [],
    };

    await adapter.createModel(itemDef);
    // The seeded column goes in on `options`. Under the old positional form it
    // was passed third, i.e. as `offset`, so this test never reached the branch
    // it names — the kind of silent misalignment the request object removes.
    const {getOptions, countOptions} = await adapter.processListArgsToOptions("Item", {
      args: {first: 1},
      options: {
        attributes: [[
          adapter.sequelize.literal("COUNT(1) OVER()"),
          "full_count",
        ]],
      },
    });
    expect(countOptions).toBeUndefined();
    expect(getOptions).toBeDefined();
    expect(getOptions.limit).toEqual(1);
    // One count column, not two: the alias pair is recognised, so the adapter
    // does not add a second.
    const countColumns = getOptions.attributes.filter((a: unknown) => Array.isArray(a) && a[1] === "full_count");
    expect(countColumns).toHaveLength(1);
    expect(countColumns[0][0].val).toEqual("COUNT(1) OVER()");
  });

  it("adapter - processListArgsToOptions - hasInlineCount - mssql", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    const itemDef = {
      name: "Item",
      define: {},
      relationships: [],
    };

    await adapter.createModel(itemDef);
    (adapter.sequelize as unknown as { dialect: { name: string } }).dialect.name = "mssql";
    const {getOptions, countOptions} = await adapter.processListArgsToOptions("Item", {
      args: {first: 1},
    });
    expect(countOptions).toBeUndefined();
    expect(getOptions).toBeDefined();
    expect(getOptions.limit).toEqual(1);
    expect(getOptions.attributes).toHaveLength(4);
    expect(getOptions.attributes[getOptions.attributes.length - 1]).toHaveLength(2);
    expect(getOptions.attributes[getOptions.attributes.length - 1][0].val).toEqual("COUNT(1) OVER()");
    expect(getOptions.attributes[getOptions.attributes.length - 1][1]).toEqual("full_count");
  });

  it("adapter - processListArgsToOptions - hasInlineCount - postgres", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    adapter.sequelize.getDialect = () => "postgres";
    const itemDef = {
      name: "Item",
      define: {},
      relationships: [],
    };

    await adapter.createModel(itemDef);
    const {getOptions, countOptions} = await adapter.processListArgsToOptions("Item", {
      args: {first: 1},
    });
    expect(countOptions).toBeUndefined();
    expect(getOptions).toBeDefined();
    expect(getOptions.limit).toEqual(1);
    expect(getOptions.attributes).toHaveLength(4);
    expect(getOptions.attributes[getOptions.attributes.length - 1]).toHaveLength(2);
    expect(getOptions.attributes[getOptions.attributes.length - 1][0].val).toEqual("COUNT(*) OVER()");
    expect(getOptions.attributes[getOptions.attributes.length - 1][1]).toEqual("full_count");
  });

  it("adapter - processListArgsToOptions - no inlineCount", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    const itemDef = {
      name: "Item",
      define: {},
      relationships: [],
    };

    await adapter.createModel(itemDef);
    adapter.sequelize.getDialect = () => "unknown";
    const {getOptions, countOptions} = await adapter.processListArgsToOptions("Item", {
      args: {first: 1},
    });
    expect(countOptions).toBeDefined();
    expect(countOptions?.limit).toBeUndefined();
    expect(getOptions).toBeDefined();
    expect(getOptions.limit).toEqual(1);
    expect(getOptions.attributes).toHaveLength(3);
  });

  it("adapter - resolveManyRelationship - fires beforeFind for a JOIN include", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    await adapter.createModel(TaskModel);
    await adapter.createModel(TaskItemModel);
    // Only `items` and its inverse `task` — the include under test is TaskItem
    // JOINing back to Task.
    adapter.createRelationship("Task", "TaskItem", "items", "hasMany", {foreignKey: "taskId"});
    adapter.createRelationship("TaskItem", "Task", "task", "belongsTo", {foreignKey: "taskId"});
    await adapter.initialise();
    await adapter.reset();

    const task = await adapter.getModel("Task").create({name: "parenttask"});
    // `Model<any, any>`'s attributes aren't narrowed to this fixture's real
    // columns, so read `id` back through a local, narrowly-scoped shape.
    const taskId = (task as unknown as { id: unknown }).id;
    await adapter.getModel("TaskItem").create({name: "childitem", taskId});

    // Sequelize does not fire a JOIN-loaded child's beforeFind, so the adapter
    // fires it by hand — but only if `runHook` reaches it. It used to be dropped
    // on this path: the internal call passed six of eight positional arguments.
    const hookCalls: string[] = [];
    // Kept `async`: `AdapterRelationshipRequest.runHook` is declared
    // `Promise<any>`-returning, and a plain `unknown` return isn't assignable
    // to that — but nothing here awaits, since the stub has nothing to do but
    // record the call and hand the value back.
    // eslint-disable-next-line @typescript-eslint/require-await -- must stay async: see comment above
    const runHook = async(defName: string, hookName: string, value: unknown) => {
      hookCalls.push(`${defName}.${hookName}`);
      return value;
    };
    // `defName` is the relationship's *target* — the model whose rows come back.
    const {models} = await adapter.resolveManyRelationship(
      "TaskItem",
      adapter.getAssociations("Task").items,
      task,
      {args: {include: [{task: {}}]}, runHook},
    );
    expect(hookCalls).toEqual(["Task.beforeFind"]);
    expect(models.map((m) => (m as { name: unknown }).name)).toEqual(["childitem"]);
  });

  it("adapter - getTypeMapper", () => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    const typeMapper = adapter.getTypeMapper();
    expect(typeMapper).toBeDefined();
    expect(typeMapper).toBeInstanceOf(Function);
  });

  it("adapter - deleteFunction", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    await adapter.createModel(TaskModel);
    await adapter.reset();
    const Task = adapter.getModel("Task");
    await Task.create({
      name: "ttttttttttttttt",
    });

    const func = adapter.getDeleteFunction("Task", undefined);
    await func({}, {}, (i) => i, (i) => i);
    // const result = await proxyFunc();
    // expect(result).not.toBeUndefined();
    // expect(result).toHaveLength(1);
    // expect(result[0].id).toEqual(task.id);
    const result = await Task.findAll({
      where: {},
    });
    expect(result).toBeDefined();
    expect(result).toHaveLength(0);
  });



  it("adapter - processIncludeStatement", async() => {
    const adapter = new SequelizeAdapter({}, {
      dialect: "sqlite",
    });
    await adapter.createModel(TaskModel);
    await adapter.reset();
    const Task = adapter.getModel("Task");
    await Task.create({
      name: "ttttttttttttttt",
    });

    const results = await adapter.processIncludeStatement("Task", [], [["createdAt", "DESC"]], {});
    expect(results.include).toBeDefined();
    expect(results.order).toHaveLength(1);
  });
});