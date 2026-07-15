import waterfall from "@azerothian/gqlize-shared/utils/waterfall";
import {fromGlobalId} from "graphql-relay";
import replaceIdDeep from "./utils/replace-id-deep";
import events from "./events";
import Events from "./events";
import { GraphQLResolveInfo } from "graphql";
import logger from "@azerothian/gqlize-shared/utils/logger";
import buildIncludeFromSelection, { mergeIncludeMaps, getChildSelectionSet, flattenFieldNodes, isConnectionRowsSelected } from "./graphql/utils/build-include-from-selection";
import { Model, Association } from './types';

/**
 * GraphQL binding that composes an `Ormize` backend instance. The schema builders
 * call `instance.X`; backend concerns are delegated to the composed `orm` via the
 * forwarders below, GraphQL-typed concerns are implemented as methods here.
 */
export default class GqlizeBinding {
  orm: any;
  constructor(orm: any) {
    this.orm = orm;
  }
  get models() { return this.orm.models; }
  getDefinition = (...a: any[]) => this.orm.getDefinition(...a);
  getDefinitions = (...a: any[]) => this.orm.getDefinitions(...a);
  getModels = () => this.orm.models;
  getModel = (...a: any[]) => this.orm.getModel(...a);
  getFields = (...a: any[]) => this.orm.getFields(...a);
  getAssociations = (...a: any[]) => this.orm.getAssociations(...a);
  getGlobalKeys = (...a: any[]) => this.orm.getGlobalKeys(...a);
  getModelAdapter = (...a: any[]) => this.orm.getModelAdapter(...a);
  getValueFromInstance = (...a: any[]) => this.orm.getValueFromInstance(...a);
  isTypeOf = (...a: any[]) => this.orm.isTypeOf(...a);
  resolveClassMethod = (...a: any[]) => this.orm.resolveClassMethod(...a);
  applyEagerAfterFind = (...a: any[]) => this.orm.applyEagerAfterFind(...a);
  runHook = (...a: any[]) => this.orm.runHook(...a);
  getDefinitionHooks = (...a: any[]) => this.orm.getDefinitionHooks(...a);
  // Backend lifecycle forwarders so the binding is a transparent wrapper (useful
  // for tests/tools that drive both setup and schema building through one object).
  registerAdapter = (...a: any[]) => this.orm.registerAdapter(...a);
  addDefinition = (...a: any[]) => this.orm.addDefinition(...a);
  define = (...a: any[]) => this.orm.define(...a);
  initialise = (...a: any[]) => this.orm.initialise(...a);
  sync = (...a: any[]) => this.orm.sync(...a);
  reset = (...a: any[]) => this.orm.reset(...a);
  getGraphQLOutputType = (modelName: string, fieldName: string, type: any) => {
    const adapter = this.getModelAdapter(modelName);
    const typeMapper = adapter.getTypeMapper();
    return typeMapper(type, modelName, fieldName);
  }
  getGraphQLInputType = (modelName: string, fieldName: string, type: any) => {
    const adapter = this.getModelAdapter(modelName);
    const typeMapper = adapter.getTypeMapper();
    return typeMapper(type, modelName, `${fieldName}Input`);
  }
  getDefaultListArgs = (defName: string) => {
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    return adapter.getDefaultListArgs(defName, definition);
  }

  getOrderByGraphQLType = (defName: string) => {
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    return adapter.getOrderByGraphQLType(defName, definition);
  }
  getFilterGraphQLType = (defName: string) => {
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    return adapter.getFilterGraphQLType(defName, definition);
  }
  resolveManyRelationship = async(defName: string, association: Association, source: Model, args: any, context: any, info: GraphQLResolveInfo) => {

    const options = createGetGraphQLArgsFunc(context, info, source);

    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    const a = await adapter.replaceIdInArgs(args, defName, info.variableValues);
    const offset = cursorOffset(args);
    // Count-only: the nested connection selects `total` but not `edges`/rows — the
    // adapter runs a count instead of a findAll (fires beforeCount natively); fire
    // afterCount here.
    const countOnly = wantsCountOnly(info);
    const result = await adapter.resolveManyRelationship(defName, association, source, a, offset, definition.whereOperators, info, options, countOnly);
    if (countOnly && result) {
      result.total = await this.runHook(defName, "afterCount", result.total, options);
    }
    // afterFind for JOIN-eager loads is fired centrally by resolveFindAll's
    // post-pass (which knows JOIN vs separate authoritatively). A fresh accessor
    // query and the separate path both fire it natively.
    return result;
  }
  resolveSingleRelationship = async(defName: string, association: Association, source: any, args: any, context: any, info: any) => {
    const adapter = this.getModelAdapter(defName);
    const options = createGetGraphQLArgsFunc(context, info, source);
    // afterFind for JOIN-eager single relations is fired by resolveFindAll's post-pass.
    return adapter.resolveSingleRelationship(defName, association, source, args, context, info, options);
  }
  resolveFindAll = async(defName: any, source: any, args: { after: { index: number; }; before: { index: number; }; limit: any; }, context: any, info:  GraphQLResolveInfo) => {
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const options = createGetGraphQLArgsFunc(context, info, source);
    const a = await adapter.replaceIdInArgs(args, defName, info.variableValues);

    let selectedFields = [];
    if (info) {
      if (Array.isArray(info.fieldNodes)) {
        selectedFields = getSelectionFields(info.fieldNodes[0], info);
      }
    }
    // Auto-generate a combined include tree from the GraphQL selection set (merged
    // with any explicit `include` arg) so same-adapter relations are pulled at the
    // root level in a single query. Cross-adapter relations are skipped here and
    // resolved as their own root queries by the nested field resolvers.
    if (info && Array.isArray(info.fieldNodes) && (definition.options?.autoInclude !== false)) {
      try {
        let astInclude = buildIncludeFromSelection(this, defName, info.fieldNodes[0], info);
        if (astInclude) {
          astInclude = (adapter as any).replaceIdInInclude(astInclude, defName, info.variableValues);
        }
        const explicit = (a as any).include;
        if (astInclude && explicit) {
          (a as any).include = [mergeIncludeMaps(explicit[0] || {}, astInclude[0] || {})];
        } else if (astInclude) {
          (a as any).include = astInclude;
        }
      } catch (e) {
        logger("gqlize::manager").warn("auto-include build failed, falling back to per-relation resolution", e);
      }
    }
    const offset = cursorOffset(args);
    const {getOptions, countOptions} = await adapter.processListArgsToOptions(defName, a, offset, info, definition.whereOperators, options, selectedFields, this.runHook);
    if (definition.before) {
      await definition.before({
        params: getOptions, args, context, info,
        modelDefinition: definition,
        type: Events.QUERY,
      });
    }
    // Count-only: the connection selects `total` but not `edges`/rows — skip the
    // findAll and run a count (fires beforeCount natively + afterCount manually).
    if (wantsCountOnly(info)) {
      const countOnlyOptions = countOptions || {
        where: getOptions.where,
        include: (getOptions.include || []).filter((i: any) => i.required && !i.separate),
        getGraphQLArgs: getOptions.getGraphQLArgs,
      };
      let total = await adapter.count(defName, countOnlyOptions);
      total = await this.runHook(defName, "afterCount", total, countOnlyOptions);
      return { total, models: [] };
    }
    let models = (await adapter.findAll(defName, getOptions)).filter((m: any) => (m !== undefined && m !== null));

    // Sequelize does not fire a child model's afterFind for JOIN-loaded includes.
    // Walk the built include plan and fire afterFind for each JOIN (non-separate)
    // relation on the loaded instances before the nested field resolvers read them;
    // separate/cross-adapter relations fire it natively via their own query.
    const plan = (a as any).include && (a as any).include[0];
    if (plan) {
      await this.applyEagerAfterFind(plan, models, options);
    }

    let total;
    if (adapter.hasInlineCountFeature()) {
      total = await adapter.getInlineCount(models);
    } else {
      total = await adapter.count(defName, countOptions);
    }
    return {
      total, models,
    };
  }
  processInputs = async(defName: any, input: { [x: string]: any; }, args: any, context: any, info: any, model?: any) => {
    const definition = this.getDefinition(defName);
    let i = Object.keys(this.getFields(defName)).reduce((o, key) => {
      if (input[key] !== undefined) {
        o[key] = input[key];
      }
      return o;
    }, {} as any);

    if (definition.override) {
      i = await waterfall(Object.keys(definition.override), async(key: string | number, o: { [x: string]: any; }) => {
        if (definition.override) {
          const input = definition.override[key].input;
          if (input) {
            const val = await input(o[key], args, context, info, model);
            if (val !== undefined) {
              o[key] = val;
            }
          }
        }
        return o;
      }, i);
    }
    return i;
  }
  processRelationshipMutation = async(defName: any, source: any, input: any, context: any, info: { variableValues: any; }) => {
    const associations = this.getAssociations(defName);
    const defaultOptions = createGetGraphQLArgsFunc(context, info, source);
    await waterfall(Object.keys(associations), async(key: string, o: any) => {
      const association = associations[key];
      const targetName = association.target;
      const targetAdapter = this.getModelAdapter(targetName);
      const targetGlobalKeys = this.getGlobalKeys(targetName);
      const targetDef = this.getDefinition(targetName);
      if (input[key]) {
        const args = input[key];
        const singular = association.associationType === "belongsTo" || association.associationType === "hasOne";
        const isBtm = association.associationType === "belongsToMany";
        if (args.create) {
          await waterfall(args.create, async(arg: any) => {
            if (targetDef.before) {
              arg = await targetDef.before({
                params: arg, args, context, info,
                modelDefinition: targetDef,
                type: events.MUTATION_CREATE,
              });
            }

            const [result] = await this.processCreate(targetName, source, {input: arg}, context, info);
            // const targetAdapter = this.getModelAdapter(targetName);
            // const k = this.getValueFromInstance(targetName, result, targetAdapter.getPrimaryKeyNameForModel(targetName));
            
            switch (association.associationType) {
              case "hasMany":
              case "belongsToMany":
                await source[association.accessors.add](result, defaultOptions);
                break;
              default:
                await source[association.accessors.set](result, defaultOptions);
                break;
            }

            // await this.processRelationshipMutation(targetDef, result, input, context, info);
          });
        }
        if (args.update) {
          await waterfall(args.update, async(arg: { where: any; limit: any; input: any; }) => {
            const {where, limit, input} = arg;
            // const [result] = await this.processUpdate(targetName, source, {input: arg}, context, info);
            const whereObj = await targetAdapter.processFilterArgument(replaceIdDeep(where, targetGlobalKeys, info.variableValues), targetDef.whereOperators, defaultOptions);
            const targets = await source[association.accessors.get]({
              limit,
              where: whereObj,
              ...defaultOptions
            });
            let i = await this.processInputs(targetName, input, source, args, context, info);
            if (targetDef.before) {
              i = await targetDef.before({
                params: input, args, context, info,
                modelDefinition: targetDef,
                type: events.MUTATION_UPDATE,
              });
            }
            await Promise.all(targets.map(async(model: any) => {
              let m = await targetAdapter.update(model, i, defaultOptions);
              // if (targetDef.after) {
              //   m = await targetDef.after({
              //     result: m, args, context, info,
              //     modelDefinition: targetDef,
              //     type: events.MUTATION_UPDATE,
              //   });
              // }
              const defName = targetDef.name;
              await this.processRelationshipMutation(defName, m, input, context, info);
              return m;
            }));
          });
        }
        if (args.delete) {
          await waterfall(args.delete, async(arg: any) => {
            const targets = await source[association.accessors.get](Object.assign({
              where: await targetAdapter.processFilterArgument(replaceIdDeep(arg, targetGlobalKeys, info.variableValues), targetDef.whereOperators, defaultOptions),
            }, defaultOptions));
            // let i = await this.processInputs(targetName, input, source, args, context, info);
            await Promise.all(targets.map(async(model: any) => {
              const defName = targetDef.name;
              await this.processRelationshipMutation(defName, model, input, context, info);
              if (targetDef.before) {
                await targetDef.before({
                  params: model, args, context, info,
                  model, modelDefinition: targetDef,
                  type: events.MUTATION_DELETE,
                });
              }
              await this.processDelete(defName, source, arg, context, info);
              // if (targetDef.after) {
              //   await targetDef.after({
              //     result: model, args, context, info,
              //     modelDefinition: targetDef,
              //     type: events.MUTATION_DELETE,
              //   });
              // }
              return model;
            }));
          });
        }
        if (args.remove !== undefined && args.remove !== null) {
          if (singular) {
            // belongsTo/hasOne: disassociate by nulling the relationship.
            if (args.remove === true) {
              await source[association.accessors.set](null, defaultOptions);
            }
          } else {
            await waterfall(args.remove, async(arg: any) => {
              const where = await targetAdapter.processFilterArgument(replaceIdDeep(arg, targetGlobalKeys, info.variableValues), targetDef.whereOperators, defaultOptions);
              const results = await targetAdapter.findAll(targetName, Object.assign({
                where,
              }, defaultOptions));
              if (results.length > 0) {
                return source[association.accessors.removeMultiple](results, defaultOptions);
              }
              return undefined;
            });
          }
        }

        if (args.add) {
          await waterfall(args.add, async(arg: any) => {
            // belongsToMany add entries are `{ where, through }`; other collections
            // pass the filter directly.
            const filter = isBtm ? (arg || {}).where : arg;
            const through = isBtm ? (arg || {}).through : undefined;
            const where = await targetAdapter.processFilterArgument(replaceIdDeep(filter, targetGlobalKeys, info.variableValues), targetDef.whereOperators, defaultOptions);
            const results = await targetAdapter.findAll(targetName, Object.assign({
              where,
            }, defaultOptions));
            if (results.length > 0) {
              return source[association.accessors.addMultiple](results, through !== undefined ? Object.assign({through}, defaultOptions) : defaultOptions);
            }
            return undefined;
          });
        }

        if (args.set !== undefined && args.set !== null) {
          if (singular) {
            // belongsTo/hasOne: associate one existing record found by filter.
            const where = await targetAdapter.processFilterArgument(replaceIdDeep(args.set, targetGlobalKeys, info.variableValues), targetDef.whereOperators, defaultOptions);
            const found = await targetAdapter.findAll(targetName, Object.assign({where, limit: 1}, defaultOptions));
            await source[association.accessors.set](found[0] || null, defaultOptions);
          } else {
            // Collections: replace the entire set with all matching existing records.
            const all: any[] = [];
            let through: any;
            await waterfall(args.set, async(arg: any) => {
              const filter = isBtm ? (arg || {}).where : arg;
              if (isBtm && (arg || {}).through !== undefined) {
                through = arg.through;
              }
              const where = await targetAdapter.processFilterArgument(replaceIdDeep(filter, targetGlobalKeys, info.variableValues), targetDef.whereOperators, defaultOptions);
              const results = await targetAdapter.findAll(targetName, Object.assign({where}, defaultOptions));
              all.push(...results);
              return undefined;
            });
            await source[association.accessors.set](all, through !== undefined ? Object.assign({through}, defaultOptions) : defaultOptions);
          }
        }

        if (args.restore !== undefined && args.restore !== null) {
          // Restore soft-deleted (paranoid) related records scoped to this relationship.
          const restoreByFilter = async(arg: any) => {
            const where = await targetAdapter.processFilterArgument(replaceIdDeep(arg, targetGlobalKeys, info.variableValues), targetDef.whereOperators, defaultOptions);
            const res = await source[association.accessors.get](Object.assign({where, paranoid: false}, defaultOptions));
            const records = Array.isArray(res) ? res : (res ? [res] : []);
            await Promise.all(records
              .filter((r: any) => r && r.deletedAt)
              .map((r: any) => r.restore(defaultOptions)));
          };
          if (singular) {
            await restoreByFilter(args.restore);
          } else {
            await waterfall(args.restore, restoreByFilter);
          }
        }

        if (args.select !== undefined && args.select !== null) {
          // Find related records (scoped to this relationship via the get accessor,
          // so beforeFind/afterFind fire) and run further relationship mutations on
          // them via `arg.input`. The selected records themselves are NOT modified —
          // no field write, no create/update/delete; scalar fields in `input` are
          // ignored (only relationship sub-mutations are applied).
          const selectByFilter = async(arg: any) => {
            const where = await targetAdapter.processFilterArgument(replaceIdDeep(arg.where, targetGlobalKeys, info.variableValues), targetDef.whereOperators, defaultOptions);
            const res = await source[association.accessors.get](Object.assign({where}, defaultOptions));
            const records = Array.isArray(res) ? res : (res ? [res] : []);
            await waterfall(records, async(m: any) => {
              await this.processRelationshipMutation(targetDef.name, m, arg.input, context, info);
            });
          };
          if (singular) {
            await selectByFilter(args.select);
          } else {
            await waterfall(args.select, selectByFilter);
          }
        }
      }
    });
    return source;
  }
  processCreate = async(defName: any, source: any, args: { input: any; }, context: any, info: { variableValues: any; }) => {
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    const processCreate = adapter.getCreateFunction(defName);
    const globalKeys = this.getGlobalKeys(defName);
    let i = await this.processInputs(defName, args.input, args, context, info);
    let input = replaceIdDeep(i, globalKeys, info.variableValues);
    if (definition.before) {
      input = await definition.before({
        params: input, args, context, info,
        modelDefinition: definition,
        type: events.MUTATION_CREATE,
      });
    }
    let result;
    if (Object.keys(input).length > 0) {
      result = await processCreate(input, createGetGraphQLArgsFunc(context, info, source));
      // if (definition.after) {
      //   result = definition.after({
      //     result, args, context, info,
      //     modelDefinition: definition,
      //     type: events.MUTATION_CREATE,
      //   });
      // }

      if (result !== undefined && result !== null) {
        result = await this.processRelationshipMutation(defName, result, args.input, context, info);
        return [result];
      }

    }
    return [];
  }

  processUpdate = async(defName: any, source: any, args: { input: { [x: string]: any; }; where: any; limit: any; }, context: any, info: { variableValues: any; }) => {
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const processUpdate = adapter.getUpdateFunction(defName, definition.whereOperators);
    const globalKeys = this.getGlobalKeys(defName);

    let i = Object.keys(args.input).reduce((o, k) => {
      if (globalKeys.indexOf(k) > -1) {
        let v = args.input[k];
        if (typeof args.input[k] === "function") {
          v = args.input[k](info.variableValues);
        }
        if (v === null || v === undefined) {
          o[k] = null;
        } else {
          o[k] = fromGlobalId(v).id;
        }
        //o[k] = fromGlobalId(v).id;
      } else {
        o[k] = args.input[k];
      }
      return o;
    }, {} as any);
    const where = replaceIdDeep(args.where, globalKeys, info.variableValues);
    if (definition.before) {
      i = await definition.before({
        params: i, args, context, info,
        modelDefinition: definition,
        type: events.MUTATION_UPDATE,
      });
    }
    const results = await processUpdate(where, (model: any) => {
      return this.processInputs(defName, i, args, context, info, model);
    }, createGetGraphQLArgsFunc(context, info, source, {limit: args.limit}));

    await waterfall(results, async(r: any) => {
      await this.processRelationshipMutation(defName, r, args.input, context, info);
      // if (definition.after) {
      //   await definition.after({
      //     result: r, args, context, info,
      //     modelDefinition: definition,
      //     type: events.MUTATION_UPDATE,
      //   });
      // }
    });

    return results;
  }
  processSelect = async(defName: any, source: any, args: { input: any; where: any; limit: any; }, context: any, info: { variableValues: any; }) => {
    // Find matching elements and run relationship mutations on them via `args.input`
    // WITHOUT modifying the elements themselves (no field write / lifecycle change);
    // scalar fields in `input` are ignored. Returns the found rows so the caller can
    // select fields back.
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const globalKeys = this.getGlobalKeys(defName);
    const options = createGetGraphQLArgsFunc(context, info, source, {limit: args.limit});
    const where = await adapter.processFilterArgument(
      replaceIdDeep(args.where, globalKeys, info.variableValues),
      definition.whereOperators,
      options,
    );
    const results = await adapter.findAll(defName, Object.assign({where, limit: args.limit}, options));
    await waterfall(results, async(r: any) => {
      await this.processRelationshipMutation(defName, r, args.input, context, info);
    });
    return results;
  }
  processDelete = async(defName: any, source: any, args: any, context: any, info: { variableValues: any; }) => {
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const processDelete = adapter.getDeleteFunction(defName, definition.whereOperators);
    const globalKeys = this.getGlobalKeys(defName);
    const where = replaceIdDeep(args, globalKeys, info.variableValues);
    const before = (model: any) => {
      if (!definition.before) {
        return model;
      }
      return definition.before({
        params: model, args, context, info,
        model, modelDefinition: definition,
        type: events.MUTATION_DELETE,
      });
    };
    const after = (model: any) => {
      return model;
      // if (!definition.after) {
       
      // }
      // return definition.after({
      //   result: model, args, context, info,
      //   modelDefinition: definition,
      //   type: events.MUTATION_DELETE,
      // });
    };
    return processDelete(where, createGetGraphQLArgsFunc(context, info, source), before, after);
  }
}


function createGetGraphQLArgsFunc(context: any, info: any, source: any, options = {}) {
  return Object.assign({
    getGraphQLArgs() {
      return {
        context,
        info,
        source,
      };
    },
  }, options);
}

function getSelectionFields(startNode: any, info?: GraphQLResolveInfo) {
  if (!startNode || !info) {
    return undefined;
  }
  // Descend the relay connection (edges { node { … } }) to the node selection set,
  // then collect the requested field names — expanding inline/named fragments.
  const nodeSelectionSet = getChildSelectionSet(startNode.selectionSet, true, info);
  if (!nodeSelectionSet) {
    return undefined;
  }
  return flattenFieldNodes(nodeSelectionSet, info).map((f: any) => f.name.value);
}

// Cursor-based offset from decoded `after`/`before` args (shared by the top-level
// list resolver and the relationship resolver).
function cursorOffset(args: any) {
  if (args.after) {
    return args.after.index + 1;
  }
  if (args.before) {
    let offset = args.before.index + 1;
    if (args.limit) {
      offset -= Number(args.limit);
    }
    return offset;
  }
  return undefined;
}

// A relay connection field that selects `total` but not `edges`/rows can be
// served by a count instead of a findAll.
function wantsCountOnly(info: GraphQLResolveInfo) {
  return Boolean(info && Array.isArray(info.fieldNodes) && !isConnectionRowsSelected(info.fieldNodes[0], info));
}



// function generateHooks(hooks = [], schemaName) {
//   return hooks.reduce((o, h) => {
//     Object.keys(h).forEach((hookName) => {
//       if (!o[hookName]) {
//         o[hookName] = createHookQueue(hookName, hooks, schemaName);
//       }
//     });
//     return o;
//   }, {});
// }

// function createHookQueue(hookName, hooks, schemaName) {
//   return function(init, options, error) {
//     return hooks.reduce((promise, targetHooks) => {
//       return promise.then(async(val) => {
//         if (targetHooks[hookName]) {
//           let result;
//           if (Array.isArray(targetHooks[hookName])) {
//             result = await waterfall(targetHooks[hookName], (hook, prevResult) => {
//               return hook(prevResult, options, error, schemaName, hookName);
//             }, val);
//           } else {
//             result = await targetHooks[hookName](val, options, error, schemaName, hookName);
//           }
//           if (result) {
//             return result;
//           }
//         }
//         return val;
//       });
//     }, Promise.resolve(init));
//   };
// }
