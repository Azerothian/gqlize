import Sequelize, {Op} from "sequelize";

import {
  GraphQLString,
  GraphQLNonNull,
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLInt,
} from "graphql";

import events from "../../../src/events";
import { Definition } from '../../../src/types/index';


function delay(ms = 1) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms);
  });
}

// `const x: Definition = {...}` rather than `{...} as Definition`: contextual
// typing threads through to every nested hook/method/hatch below, so each one
// picks up its real parameter types from `Definition` instead of needing its
// own `any` annotations.
const taskDefinition: Definition = {
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
    nullCheck: {
      type: Sequelize.STRING,
      allowNull: true,
    },
    intZeroCheck: {
      type: Sequelize.INTEGER,
      allowNull: true,
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
    if (req.type === events.MUTATION_CREATE) {
      return Object.assign({}, req.params, {
        mutationCheck: "create",
      });
    }
    if (req.type === events.MUTATION_UPDATE) {
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
      // `Definition.override[field].output` is `any` — this is one field's
      // resolved row, so a real (if minimal) type beats reaching back for `any`.
      output(result: {get: (key: string) => string}, args: unknown, context: unknown, info: unknown) {
        return JSON.parse(result.get("options"));
      },
      input(field, args, context, info, model) {
        if (model) {
          const currOpts = model.get("options");
          if (currOpts) {
            const opts = JSON.parse(currOpts);
            return JSON.stringify(Object.assign({}, opts, field));
          }
        }
        return JSON.stringify(field);
      },
    },
    options2: {
      type: GraphQLString,
      output(result: {get: (key: string) => string}, args: unknown, context: unknown, info: unknown) {
        return JSON.parse(result.get("options2"));
      },
      input(field, args, context, info, model) {
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
  whereOperatorTypes: {
    hasNoItems: GraphQLBoolean,
    chainTest: GraphQLBoolean,
  },
  expose: {
    instanceMethods: {
      query: {
        testInstanceMethod: {
          type: "Task[]",
          // Reads `this.name`, which the selection set need not have asked for.
          fields: ["name"],
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
      mutations: {
        appendSuffix: {
          args: {
            suffix: {type: new GraphQLNonNull(GraphQLString)},
          },
        },
        markChecked: {},
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
        return [{
          id: this.id,
          name: `${this.name}${amount}`,
        }];
      },
      // Pre-commit transform, direct-write flavour: mutates `this`, returns nothing.
      appendSuffix({suffix}) {
        this.name = `${this.name}${suffix}`;
      },
      // Pre-commit transform, returned-values flavour. Runs after `before`, so
      // this wins over the `mutationCheck` that hook sets.
      markChecked() {
        return {mutationCheck: "applied"};
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

export default taskDefinition;
