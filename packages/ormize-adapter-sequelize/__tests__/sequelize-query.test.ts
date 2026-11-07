// Query building, inline count, relationship resolution, and write operations.
// Split from `sequelize.test.ts` to keep each file well under 1000 lines.

import SequelizeAdapter from "../src";
import TaskModel from "./helper/models/task";
import TaskItemModel from "./helper/models/task-item";
import Sequelize from "sequelize";
import { GraphQLList } from "graphql";

import { describe, expect, it } from "@jest/globals";
import { dialectConfig, trackConnection, testDialect } from "@azerothian/test-fixtures/dialect";

describe("query and resolution", () => {
  it("adapter - getDefaultListArgs", async() => {
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
    const defaultArgs = adapter.getDefaultListArgs(itemDef.name, itemDef);
    expect(defaultArgs).toBeDefined();
    expect(defaultArgs.where).toBeDefined();
  });

  it("adapter - include - getDefaultListArgs", async() => {
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
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
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
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
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
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
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
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
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

  it("adapter - hasInlineCountFeature - sqlite", async() => {
    const adapter = trackConnection(new SequelizeAdapter({
      disableInlineCount: false,
    }, await dialectConfig()));
    const result = adapter.hasInlineCountFeature();
    expect(result).toEqual(true);
  });
  it("adapter - hasInlineCountFeature - disable inline count", async() => {
    const adapter = trackConnection(new SequelizeAdapter({
      disableInlineCount: true,
    }, await dialectConfig()));
    const result = adapter.hasInlineCountFeature();
    expect(result).toEqual(false);
  });

  // Sqlite-only unit tests: they construct an adapter on sqlite and then
  // override dialect.name to test the adapter's internal branching logic.
  // On a real postgres adapter the override is redundant.
  it("adapter - hasInlineCountFeature - postgres", () => {
    if (testDialect() !== "sqlite") return;
    const adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
    (adapter.sequelize as unknown as { dialect: { name: string } }).dialect.name = "postgres";
    const result = adapter.hasInlineCountFeature();
    expect(result).toEqual(true);
  });

  it("adapter - hasInlineCountFeature - mssql", () => {
    if (testDialect() !== "sqlite") return;
    const adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
    (adapter.sequelize as unknown as { dialect: { name: string } }).dialect.name = "mssql";
    const result = adapter.hasInlineCountFeature();
    expect(result).toEqual(true);
  });


  it("adapter - processListArgsToOptions - hasInlineCount", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
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
    // Postgres uses COUNT(*), sqlite/mssql use COUNT(1).
    const expectedCount = testDialect() === "postgres" ? "COUNT(*) OVER()" : "COUNT(1) OVER()";
    expect(getOptions.attributes[getOptions.attributes.length - 1][0].val).toEqual(expectedCount);
    expect(getOptions.attributes[getOptions.attributes.length - 1][1]).toEqual("full_count");
  });

  it("adapter - processListArgsToOptions - hasInlineCount - full_count args already exist", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
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
    // The seeded literal is always `COUNT(1)` — the adapter recognised the
    // existing `full_count` alias and kept the original, regardless of dialect.
    expect(countColumns[0][0].val).toEqual("COUNT(1) OVER()");
  });

  // Sqlite-only unit test: overrides dialect.name to "mssql" to test the
  // adapter's internal branching logic for that dialect.
  it("adapter - processListArgsToOptions - hasInlineCount - mssql", async() => {
    if (testDialect() !== "sqlite") return;
    const adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
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

  // Sqlite-only unit test: overrides getDialect() to "postgres" to test the
  // adapter's internal branching. On a real postgres adapter, getDialect()
  // already returns "postgres".
  it("adapter - processListArgsToOptions - hasInlineCount - postgres", async() => {
    if (testDialect() !== "sqlite") return;
    const adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
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

  // Sqlite-only unit test: overrides getDialect() to "unknown" to test the
  // fallback path (separate count query).
  it("adapter - processListArgsToOptions - no inlineCount", async() => {
    if (testDialect() !== "sqlite") return;
    const adapter = new SequelizeAdapter({}, { dialect: "sqlite" });
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

  // Real-postgres assertion: the inline count (COUNT(*) OVER()) works against
  // PGlite with correct totals. The sqlite-only tests above validate the
  // branching logic by faking the dialect; this one proves the generated SQL
  // runs and returns the right number on a real Postgres engine.
  it("adapter - processListArgsToOptions - real postgres inline count", async() => {
    if (testDialect() !== "postgres") return;
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    await adapter.createModel({
      name: "CountMe",
      define: { label: { type: Sequelize.STRING } },
    });
    await adapter.reset();
    const Model = adapter.getModel("CountMe");
    await Model.create({ label: "a" });
    await Model.create({ label: "b" });
    await Model.create({ label: "c" });

    const { getOptions, countOptions } = await adapter.processListArgsToOptions("CountMe", {
      args: { first: 2 },
    });
    expect(countOptions).toBeUndefined();
    expect(getOptions.limit).toEqual(2);
    // The last attribute is [literal("COUNT(*) OVER()"), "full_count"].
    expect(getOptions.attributes[getOptions.attributes.length - 1][0].val).toEqual("COUNT(*) OVER()");

    // Execute the query to prove the SQL runs and full_count is correct.
    const rows = await Model.findAll(getOptions) as unknown as Array<{ get(k: string): unknown }>;
    expect(rows).toHaveLength(2);
    // full_count reflects the total matching rows (3), not the page size (2).
    expect(Number(rows[0].get("full_count"))).toEqual(3);
  });

  it("adapter - resolveManyRelationship - fires beforeFind for a JOIN include", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
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

  it("adapter - getTypeMapper", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
    const typeMapper = adapter.getTypeMapper();
    expect(typeMapper).toBeDefined();
    expect(typeMapper).toBeInstanceOf(Function);
  });

  it("adapter - deleteFunction", async() => {
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
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
    const adapter = trackConnection(new SequelizeAdapter({}, await dialectConfig()));
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
