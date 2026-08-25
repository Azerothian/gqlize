import Sequelize, {Op, Model} from "sequelize";

import {
  GraphQLString,
  GraphQLNonNull,
  // GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLInt,
  type GraphQLResolveInfo,
} from "graphql";
import type { RequestContext } from "@azerothian/utilize/types/index";
import { Events } from "@azerothian/utilize/events";

import { SequelizeDefinition } from '../../../src/types/index';


function delay(ms = 1) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms);
  });
}

// `taskModel`'s own annotation below (`: SequelizeDefinition`) contextually
// types every hook/method/hook-map function nested in the literal from the
// contract's own parameter types (`Definition`'s `before`/`after`/
// `whereOperators`/`classMethods`/`instanceMethods`, `DefinitionOptions`'
// `classMethods`/`instanceMethods`/`hooks`), which are declared with `any` in
// several positions there (published in `@azerothian/utilize`, out of this
// package's scope). Leaving these parameters unannotated lets TypeScript
// infer those same contract types with no explicit `any` written here, rather
// than restating the contract's own permissiveness at every call site.
const taskModel: SequelizeDefinition = {
  name: "Task",
  define: {
    name: {
      type: Sequelize.STRING,
      allowNull: false,
      validate: {
        isAlphanumeric: {
          msg: "Your task name can only use letters and numbers",
        },
        len: {
          args: [1, 50],
          msg: "Your task name must be between 1 and 50 characters",
        },
      },
    },
    mutationCheck: {
      type: Sequelize.STRING,
      allowNull: true,
    },
    options: {
      type: Sequelize.STRING,
      allowNull: true,
    },
    options2: {
      type: Sequelize.STRING,
      allowNull: true,
    },
  },
  before(req) {
    if (req.type === Events.MUTATION_CREATE) {
      return Object.assign({}, req.params, {
        mutationCheck: "create",
      });
    }
    if (req.type === Events.MUTATION_UPDATE) {
      return Object.assign({}, req.params, {
        mutationCheck: "update",
      });
    }
    return req.params;
  },
  after(req) {
    return req.result;
  },
  override: {
    options: {
      type: {
        name: "TaskOptions",
        fields: {
          hidden: {type: GraphQLString},
          hidden2: {type: GraphQLString},
        },
      },
      // `Definition.override[…].output` is declared `any` in the contract (not
      // a function type), so — unlike the function-typed fields elsewhere in
      // this file — there is no contextual signature to infer these params
      // from; they are given real types instead: `result`/`model` are this
      // adapter's own Sequelize row (see `buildOverrideOutputResolver`/
      // `processInputs`'s real call sites), and `info` is a genuine GraphQL
      // resolver argument.
      output(result: Model, args: unknown, context: RequestContext, info: GraphQLResolveInfo) {
        return JSON.parse(result.get("options") as string);
      },
      input(field: unknown, args, context, info, model?: Model) {
        if (model) {
          const currOpts = model.get("options") as string | undefined;
          if (currOpts) {
            const opts = JSON.parse(currOpts);
            return JSON.stringify(Object.assign({}, opts, field as object));
          }
        }
        return JSON.stringify(field);
      },
    },
    options2: {
      type: GraphQLString,
      output(result: Model, args: unknown, context: RequestContext, info: GraphQLResolveInfo) {
        return JSON.parse(result.get("options2") as string);
      },
      input(field: unknown, args, context, info, model?: Model) {
        return JSON.stringify(field);
      },
    },
  },
  relationships: [{
    type: "hasMany",
    model: "TaskItem",
    name: "items",
    options: {
      foreignKey: "taskId",
    },
  }, {
    type: "hasOne",
    model: "Item",
    name: "item",
    options: {
      foreignKey: "taskId",
    },
  }, {
    type: "belongsToMany",
    model: "Item",
    name: "btmItems",
    options: {
      through: "btm-tasks",
      foreignKey: "taskId",
    },
  }],
  // Not `async`: neither operator awaits anything, and `WhereOperator`'s
  // return type (`Promise<any> | any`) accepts a plain return just as well.
  whereOperators: {
    hasNoItems(newWhere, findOptions) {
      return {
        id: {
          [Op.notIn]: Sequelize.literal(`(SELECT DISTINCT("taskId") FROM "task-items")`)
        }
      };
    },
    chainTest(newWhere, findOptions) {
      return {
        hasNoItems: true
      };
    }
  },
  expose: {
    instanceMethods: {
      query: {
        testInstanceMethod: {
          type: "Task[]",
          args: {
            input: {
              type: new GraphQLNonNull(new GraphQLInputObjectType({
                name: "TestInstanceMethodInput",
                fields: {
                  amount: {type: new GraphQLNonNull(GraphQLInt)},
                },
              })),
            },
          },
        },
      },
    },
    classMethods: {
      mutations: {
        reverseName: {
          type: "Task",
          args: {
            input: {
              type: new GraphQLNonNull(new GraphQLInputObjectType({
                name: "TaskReverseNameInput",
                fields: {
                  amount: {type: new GraphQLNonNull(GraphQLInt)},
                },
              })),
            },
          },
        },
        reverseName2: {
          type: "Task",
          args: {
            input: {
              type: new GraphQLNonNull(new GraphQLInputObjectType({
                name: "TaskReverseName2Input",
                fields: {
                  amount: {type: new GraphQLNonNull(GraphQLInt)},
                },
              })),
            },
          },
        },
      },
      query: {
        reverseNameArray: {
          type: "Task[]",
          args: undefined,
        },
        getHiddenData: {
          type: new GraphQLObjectType({
            name: "TaskHiddenData",
            fields: () => ({
              hidden: {type: GraphQLString},
            }),
          }),
          args: {},
        },
        getHiddenData2: {
          type: new GraphQLObjectType({
            name: "TaskHiddenData2",
            fields: () => ({
              hidden: {type: GraphQLString},
            }),
          }),
          args: {},
        },
      },
    },
  },
  options: {
    tableName: "tasks",
    // paranoid: true,
    classMethods: {
      reverseName({input: {amount}}, req) {
        return {
          id: 1,
          name: `reverseName${amount}`,
        };
      },
      reverseNameArray(args, req) {
        return [{
          id: 1,
          name: "reverseName4",
        }, {
          id: 2,
          name: "reverseName3",
        }];
      },
      // Kept `async`: `delay()` is genuinely awaited below.
      async getHiddenData(args, req) {
        await delay();
        return {
          hidden: "Hi",
        };
      },
      getHiddenData2(args, req) {
        return {
          hidden: "Hi2",
        };
      },
    },
    instanceMethods: {
      testInstanceMethod({input: {amount}}, req) {
        // `this` is a Task row; the definition has no typed instance interface
        // to type the parameter against (this fixture stays a plain
        // `SequelizeDefinition`), so narrow it locally instead.
        const row = this as unknown as { id: unknown; name: string };
        return [{
          id: row.id,
          name: `${row.name}${amount}`,
        }];
      },
    },
    hooks: {
      beforeFind(options) {
        return options;
      },
      beforeCreate(instance, options) {
        return instance;
      },
      beforeUpdate(instance, options) {
        return instance;
      },
      beforeDestroy(instance, options) {
        return instance;
      },
    },
    indexes: [
      // {unique: true, fields: ["name"]},
    ],
  },
};


export default taskModel;