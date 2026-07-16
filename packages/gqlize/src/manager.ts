import {fromGlobalId} from "graphql-relay";
import replaceIdDeep from "./utils/replace-id-deep";
import { GraphQLResolveInfo } from "graphql";
import logger from "@azerothian/utilize/utils/logger";
import buildIncludeFromSelection, { mergeIncludeMaps, getChildSelectionSet, flattenFieldNodes, isConnectionRowsSelected } from "./graphql/utils/build-include-from-selection";
import { Model, Association, Selection } from './types';

/**
 * GraphQL binding that composes an `Ormize` backend instance. The schema builders
 * call `instance.X`; backend concerns are delegated to the composed `orm` via the
 * forwarders below, GraphQL-typed concerns are implemented as methods here.
 *
 * The resolution engine (find/create/update/delete/select + relationship
 * resolution) now lives on `Ormize` and is graphql-free. This binding adapts the
 * GraphQL execution `info` into a backend-agnostic `Selection` (via `buildSelection`)
 * and injects relay global-id translation, then delegates to the engine — so
 * behaviour is identical while the engine can be shared with non-GraphQL callers.
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

  /**
   * Adapt a GraphQL execution `info` into a backend-agnostic `Selection` for the
   * ormize engine. Carries the raw `info` (for hooks), the requested scalar fields
   * and count-only flag, and injects relay global-id translation. When the
   * (already relay-translated) list args `a` are supplied, it also reproduces the
   * root-level auto-include: a combined include tree built from the selection set,
   * merged with any explicit `include` arg, exposed via `selection.include` (and
   * mutated back onto `a.include` so the engine's afterFind post-pass sees it).
   */
  private buildSelection(defName: string, info: any, a?: any): Selection {
    const selection: Selection = {
      raw: info,
      variableValues: info?.variableValues,
      fields: (info && Array.isArray(info.fieldNodes)) ? getSelectionFields(info.fieldNodes[0], info) : undefined,
      countOnly: wantsCountOnly(info),
      translateFilter: (w: any, keys: string[]) => replaceIdDeep(w, keys, info?.variableValues),
      translateId: (v: any) => fromGlobalId(v).id,
    };
    if (a && info && Array.isArray(info.fieldNodes)) {
      const definition = this.getDefinition(defName);
      if (definition.options?.autoInclude !== false) {
        const adapter = this.getModelAdapter(defName);
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
      selection.include = (a as any).include;
    }
    return selection;
  }

  resolveManyRelationship = async(defName: string, association: Association, source: Model, args: any, context: any, info: GraphQLResolveInfo) => {
    const adapter = this.getModelAdapter(defName);
    // Relay-translate the (top-level) list args before the engine; the engine's
    // internal filter translations use `selection.translateFilter`.
    const a = await adapter.replaceIdInArgs(args, defName, info?.variableValues);
    return this.orm.resolveManyRelationship(defName, association, source, a, context, this.buildSelection(defName, info));
  }
  resolveSingleRelationship = async(defName: string, association: Association, source: any, args: any, context: any, info: any) => {
    return this.orm.resolveSingleRelationship(defName, association, source, args, context, this.buildSelection(defName, info));
  }
  resolveFindAll = async(defName: any, source: any, args: { after: { index: number; }; before: { index: number; }; limit: any; }, context: any, info: GraphQLResolveInfo) => {
    const adapter = this.getModelAdapter(defName);
    const a = await adapter.replaceIdInArgs(args, defName, info?.variableValues);
    const selection = this.buildSelection(defName, info, a);
    return this.orm.resolveFindAll(defName, source, a, context, selection);
  }
  processInputs = (defName: any, input: { [x: string]: any; }, args: any, context: any, info: any, model?: any) => {
    return this.orm.processInputs(defName, input, args, context, info, model);
  }
  processRelationshipMutation = (defName: any, source: any, input: any, context: any, info: { variableValues: any; }) => {
    return this.orm.processRelationshipMutation(defName, source, input, context, this.buildSelection(defName, info));
  }
  processCreate = (defName: any, source: any, args: { input: any; }, context: any, info: { variableValues: any; }) => {
    return this.orm.processCreate(defName, source, args, context, this.buildSelection(defName, info));
  }
  processUpdate = (defName: any, source: any, args: { input: { [x: string]: any; }; where: any; limit: any; }, context: any, info: { variableValues: any; }) => {
    return this.orm.processUpdate(defName, source, args, context, this.buildSelection(defName, info));
  }
  processSelect = (defName: any, source: any, args: { input: any; where: any; limit: any; }, context: any, info: { variableValues: any; }) => {
    return this.orm.processSelect(defName, source, args, context, this.buildSelection(defName, info));
  }
  processDelete = (defName: any, source: any, args: any, context: any, info: { variableValues: any; }) => {
    return this.orm.processDelete(defName, source, args, context, this.buildSelection(defName, info));
  }
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

// A relay connection field that selects `total` but not `edges`/rows can be
// served by a count instead of a findAll.
function wantsCountOnly(info: GraphQLResolveInfo) {
  return Boolean(info && Array.isArray(info.fieldNodes) && !isConnectionRowsSelected(info.fieldNodes[0], info));
}
