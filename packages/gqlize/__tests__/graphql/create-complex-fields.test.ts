import { Ormize as Database } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import createComplexFieldsFunc from "../../src/graphql/create-complex-fields";
import GqlizeBinding from "../../src/manager";
import {GraphQLObjectType, GraphQLInt, type GraphQLResolveInfo} from "graphql";
import createSchemaCache from "../../src/graphql/create-schema-cache";
import { Definition } from '../../src/types';
import {test,expect} from "@jest/globals";
test("createComplexFieldsFunc - empty define", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }), "sqlite");
  const itemDef: Definition = {
    name: "Item",
    define: {},
    relationships: [],
    expose: {
      instanceMethods: {
        query: {
          testInstanceMethod: {
            type: GraphQLInt,
          },
        },
      },
    },
    instanceMethods: {
      testInstanceMethod() {
        return 2;
      },
    },
  };
  await db.addDefinition(itemDef);
  await db.initialise();
  await db.sync();
  const schemaCache = createSchemaCache();
  schemaCache.types.Item = new GraphQLObjectType({
    name: "Item",
    fields: {}
  });
  const func = createComplexFieldsFunc(itemDef.name || "", new GqlizeBinding(db), itemDef, {}, schemaCache);
  expect(func).toBeInstanceOf(Function);
  const fields = func();
  expect(fields).toBeDefined();
  expect(fields.testInstanceMethod).toBeDefined();
  expect(fields.testInstanceMethod.resolve).toBeInstanceOf(Function);
  expect(fields.testInstanceMethod.type).toEqual(GraphQLInt);
});

test("createComplexFieldsFunc - before/after hooks", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }), "sqlite");
  const itemDef: Definition = {
    name: "Item",
    define: {},
    relationships: [],
    expose: {
      instanceMethods: {
        query: {
          testInstanceMethod: {
            type: GraphQLInt,
            // `ExposedMethod.before`/`.after` are typed `any` in the library — this
            // test knows exactly what it hands them, so a real (if minimal) shape
            // beats reaching for `any` here too.
            before(args: {amount: number}, context: unknown) {
              return {
                ...args,
                amount: args.amount + 1,
              };
            },
            after(result: number, context: unknown) {
              return result + 100;
            },
          },
        },
      },
    },
    instanceMethods: {
      testInstanceMethod(args) {
        return args.amount;
      },
    },
  };
  await db.addDefinition(itemDef);
  await db.initialise();
  await db.sync();
  const schemaCache = createSchemaCache();
  schemaCache.types.Item = new GraphQLObjectType({
    name: "Item",
    fields: {}
  });
  const func = createComplexFieldsFunc(itemDef.name || "", new GqlizeBinding(db), itemDef, {}, schemaCache);
  const fields = func();
  const source: {testInstanceMethod: (args: {amount: number}) => number} = {
    testInstanceMethod(args) {
      return args.amount;
    },
  };
  const result = await fields.testInstanceMethod.resolve!(source, {amount: 1}, {}, {} as GraphQLResolveInfo);
  expect(result).toEqual(102);
});
