import Sequelize, {Op} from "sequelize";
import { SequelizeDefinition } from '../../../src/types/index';

// A direct annotation (`: SequelizeDefinition`), not an `as` cast, so every
// hook/method function nested in the literal is contextually typed from the
// contract's own parameter types (`DefinitionOptions`' `classMethods`/
// `instanceMethods`/`hooks`, all declared with `any` there — published in
// `@azerothian/utilize`, out of this package's scope) instead of restating
// that permissiveness with explicit `any` at every call site here.
const taskItemModel: SequelizeDefinition = {
  name: "TaskItem",
  define: {
    name: {
      type: Sequelize.STRING,
      allowNull: false,
      validate: {
        isAlphanumeric: {
          msg: "Your task item name can only use letters and numbers",
        },
        len: {
          args: [8, 50],
          msg: "Your task item name must be between 8 and 50 characters",
        },
      },
    },
  },
  relationships: [{
    type: "belongsTo",
    model: "Task",
    name: "task",
    options: {
      foreignKey: "taskId",
    },
  }],
  expose: {
    instanceMethods: {
      query: {
        testInstanceMethodArray: {
          type: "TaskItem[]",
          args: {},
        },
        testInstanceMethodSingle: {
          type: "TaskItem",
          args: {},
        },
      },
    },
    classMethods: {
      query: {
        getTaskItemsArray: {
          type: "TaskItem[]",
          args: {},
        },
        getTaskItemsSingle: {
          type: "TaskItem",
          args: {},
        },
      },
      mutations: {
        getTaskItemsArray: {
          type: "TaskItem[]",
          args: {},
        },
        getTaskItemsSingle: {
          type: "TaskItem",
          args: {},
        },
      },
    },
  },
  options: {
    tableName: "task-items",
    instanceMethods: {
      testInstanceMethodArray(args, {instance}) {
        return instance.models.TaskItem.findAll();
      },
      testInstanceMethodSingle(args, {instance}) {
        return instance.models.TaskItem.findOne({where: {id: 1}});
      },
    },
    classMethods: {
      getTaskItemsArray(args, {instance}) {
        return instance.models.TaskItem.findAll();
      },
      getTaskItemsSingle(args, {instance}) {
        return instance.models.TaskItem.findOne({where: {id: 1}});
      },
    },
    hooks: {
      beforeFind(options = {}) {
        if (options.getGraphQLArgs) {
          const graphqlArgs = options.getGraphQLArgs();
          if (graphqlArgs.info.rootValue) {
            const {filterName} = graphqlArgs.info.rootValue;
            if (filterName) {
              options.where = {
                name: {
                  [Op.ne]: filterName,
                },
              };
            }
          }
        }
        return options;
      },
      beforeCreate(instance, options, cb) {
        return undefined;
      },
      beforeUpdate(instance, options, cb) {
        return undefined;
      },
      beforeDestroy(instance, options, cb) {
        return undefined;
      },
    },
    indexes: [
      {unique: true, fields: ["name"]},
    ],
  },
};

export default taskItemModel;
