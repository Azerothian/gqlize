import { Ormize as Database } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { createClassMethodFields } from "../../src/graphql/create-class-methods";
import GqlizeBinding from "../../src/manager";
import {GraphQLObjectType, GraphQLInt, type GraphQLResolveInfo} from "graphql";
import createSchemaCache from "../../src/graphql/create-schema-cache";
import { Definition } from '../../src/types';
import {test, expect} from "@jest/globals";

test("createClassMethodFields - mutations before/after hooks", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }), "sqlite");
  const itemDef: Definition = {
    name: "Item",
    define: {},
    relationships: [],
    expose: {
      classMethods: {
        mutations: {
          testClassMethod: {
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
    options: {
      classMethods: {
        testClassMethod(args) {
          return args.amount;
        },
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
  const mutations = itemDef.expose?.classMethods?.mutations || {};
  // The builders take the binding, not the raw backend — it is a transparent
  // wrapper, so this is the same object the live schema build passes.
  const fields = await createClassMethodFields(new GqlizeBinding(db), itemDef.name || "", itemDef, mutations, {}, schemaCache, "mutations");
  // `createClassMethodFields` is typed as returning a `GqlFieldMap`, on which
  // `resolve` is optional — every field this builder emits has one, but the type
  // cannot say so, hence the assertion before the call.
  const {resolve} = fields.testClassMethod;
  expect(resolve).toBeDefined();
  const result = await resolve!({}, {amount: 1}, {}, {} as GraphQLResolveInfo);
  expect(result).toEqual(102);
});
