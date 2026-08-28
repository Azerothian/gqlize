import replaceIdDeep from "./utils/replace-id-deep";
import { defaultIdCodec } from "./codecs/id";
import { defaultCursorCodec } from "./codecs/cursor";
import { globalKeyTargets } from "@azerothian/utilize/utils/global-keys";
import { GraphQLResolveInfo } from "graphql";
import type { FieldNode } from "graphql";
import logger from "@azerothian/utilize/utils/logger";
import buildIncludeFromSelection, { mergeIncludeMaps, getChildSelectionSet, flattenFieldNodes, isConnectionRowsSelected } from "./graphql/utils/build-include-from-selection";
import { methodOptionHooks, methodProjection, queryInstanceMethods, type MethodSelection } from "@azerothian/utilize/exposed-methods";
import { getArgumentValues, type GraphQLObjectType } from "graphql";
import type { MutationFilter, MutationInputTree } from "@azerothian/ormize";
import { AdapterRow, AnyOrmize, Association, DeclaredIncludeMap, FindAllArgs, GlobalKeyTargets, GqlizeAdapter, GqlizeOptions, IncludeMap, NativeDataType, Permission, RequestContext, Selection } from './types';

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
 *
 * The pass-through forwarders take their signature from the engine by indexed
 * access (`Ormize["getFields"]`) rather than restating it. A forwarder that
 * changes nothing should not be able to drift from what it forwards to, and the
 * ones that *do* change something — `getModelAdapter` narrowing to a
 * {@link GqlizeAdapter} — are written out so the difference is visible.
 */
export default class GqlizeBinding {
  orm: AnyOrmize;
  /**
   * The options the schema was built with. Only the two codecs are read here —
   * every other option is a builder concern — but they have to be, because this
   * class is where a request's ids and cursors are translated on the way to the
   * engine, and it is constructed once per schema rather than per request.
   */
  options: GqlizeOptions;
  constructor(orm: AnyOrmize, options: GqlizeOptions = {}) {
    this.orm = orm;
    this.options = options;
  }
  /** `options.id`, or the base64 `Type:id` default. */
  get idCodec() { return this.options.id || defaultIdCodec; }
  /** `options.cursor`, or the base64 `[connection, index]` default. */
  get cursorCodec() { return this.options.cursor || defaultCursorCodec; }
  /**
   * What each of a model's global keys points at. Swallows a missing definition
   * for the same reason the decode path tolerates one: an untyped decode is the
   * behaviour this always had, and losing a cross-type check is not worth failing
   * a request over.
   */
  private globalKeyTargetsFor(defName: string): GlobalKeyTargets | undefined {
    try {
      return globalKeyTargets(this.getFields(defName), defName);
    } catch {
      return undefined;
    }
  }
  get models() { return this.orm.models; }
  getDefinition: AnyOrmize["getDefinition"] = (...a) => this.orm.getDefinition(...a);
  getDefinitions: AnyOrmize["getDefinitions"] = (...a) => this.orm.getDefinitions(...a);
  getModels = () => this.orm.models;
  getModel: AnyOrmize["getModel"] = (...a) => this.orm.getModel(...a);
  getFields: AnyOrmize["getFields"] = (...a) => this.orm.getFields(...a);
  getAssociations: AnyOrmize["getAssociations"] = (...a) => this.orm.getAssociations(...a);
  getGlobalKeys: AnyOrmize["getGlobalKeys"] = (...a) => this.orm.getGlobalKeys(...a);
  /**
   * Narrower than the engine's: every adapter registered on a gqlize instance has
   * to be a {@link GqlizeAdapter}, because the schema builders below call the
   * graphql-typed half of the contract (`getTypeMapper`, `getFilterGraphQLType`,
   * `replaceIdInArgs`) that plain `OrmAdapter` does not declare.
   */
  getModelAdapter = (modelName: string): GqlizeAdapter => this.orm.getModelAdapter(modelName) as GqlizeAdapter;
  getValueFromInstance: AnyOrmize["getValueFromInstance"] = (...a) => this.orm.getValueFromInstance(...a);
  isTypeOf: AnyOrmize["isTypeOf"] = (...a) => this.orm.isTypeOf(...a);
  resolveClassMethod: AnyOrmize["resolveClassMethod"] = (...a) => this.orm.resolveClassMethod(...a);
  auditExtendSurfaces: AnyOrmize["auditExtendSurfaces"] = (...a) => this.orm.auditExtendSurfaces(...a);
  applyEagerAfterFind: AnyOrmize["applyEagerAfterFind"] = (...a) => this.orm.applyEagerAfterFind(...a);
  runHook: AnyOrmize["runHook"] = (...a) => this.orm.runHook(...a);
  getDefinitionHooks: AnyOrmize["getDefinitionHooks"] = (...a) => this.orm.getDefinitionHooks(...a);
  // Backend lifecycle forwarders so the binding is a transparent wrapper (useful
  // for tests/tools that drive both setup and schema building through one object).
  registerAdapter: AnyOrmize["registerAdapter"] = (...a) => this.orm.registerAdapter(...a);
  addDefinition: AnyOrmize["addDefinition"] = (...a) => this.orm.addDefinition(...a);
  define: AnyOrmize["define"] = (...a) => this.orm.define(...a);
  initialise: AnyOrmize["initialise"] = (...a) => this.orm.initialise(...a);
  sync: AnyOrmize["sync"] = (...a) => this.orm.sync(...a);
  reset: AnyOrmize["reset"] = (...a) => this.orm.reset(...a);
  getGraphQLOutputType = (modelName: string, fieldName: string, type: NativeDataType) => {
    const adapter = this.getModelAdapter(modelName);
    const typeMapper = adapter.getTypeMapper();
    return typeMapper(type, modelName, fieldName);
  }
  getGraphQLInputType = (modelName: string, fieldName: string, type: NativeDataType) => {
    const adapter = this.getModelAdapter(modelName);
    const typeMapper = adapter.getTypeMapper();
    return typeMapper(type, modelName, `${fieldName}Input`);
  }
  getDefaultListArgs = (defName: string, permission?: Permission) => {
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    return adapter.getDefaultListArgs(defName, definition, permission);
  }

  /**
   * Whether a model soft-deletes. `false` for an adapter that has no soft delete
   * at all (the member is optional on the contract), which is what keeps the
   * `deleted` argument and the `restore` mutation out of those schemas.
   */
  softDeletes = (defName: string): boolean => {
    const adapter = this.getModelAdapter(defName);
    return Boolean(adapter.softDeletes?.(defName));
  }

  getOrderByGraphQLType = (defName: string, permission?: Permission) => {
    const adapter = this.getModelAdapter(defName);
    return adapter.getOrderByGraphQLType(defName, permission);
  }
  getFilterGraphQLType = (defName: string, permission?: Permission) => {
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    return adapter.getFilterGraphQLType(defName, definition, permission);
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
  /**
   * A cross-adapter relationship is resolved by a second query keyed off a column
   * on this side of the join — but that column is only in the selection set if the
   * caller happened to ask for it, and adapters project `selection.fields` down to
   * the attributes they load. Add the join keys of any selected cross-adapter
   * relationship so the resolver has a value to join on.
   */
  private withCrossAdapterJoinKeys(defName: string, fields?: string[]): string[] | undefined {
    if (!fields?.length) {
      return fields;
    }
    let associations: {[relName: string]: Association};
    try {
      associations = this.getAssociations(defName);
    } catch (e) {
      return fields;
    }
    const out = [...fields];
    for (const fieldName of fields) {
      const association: Association | undefined = associations[fieldName];
      if (!association?.crossAdapter) {
        continue;
      }
      const joinKey = association.associationType === "belongsTo" ? association.foreignKey : association.sourceKey;
      if (joinKey && !out.includes(joinKey)) {
        out.push(joinKey);
      }
    }
    return out;
  }
  /**
   * The exposed query instance methods this selection set actually asks for, one
   * entry per occurrence with the args it was selected with.
   *
   * Occurrences rather than names: the same method aliased twice with different
   * args is two contributions to the query, and its `input` gets to see each.
   */
  private selectedMethods(defName: string, nodes: FieldNode[] | undefined, info: GraphQLResolveInfo | undefined): MethodSelection[] {
    if (!nodes?.length || !info) {
      return [];
    }
    let methods;
    try {
      methods = queryInstanceMethods(this.getDefinition(defName));
    } catch (e) {
      return [];
    }
    if (Object.keys(methods).length === 0) {
      return [];
    }
    const out: MethodSelection[] = [];
    // The output type is only needed to coerce args; a selection reaching here
    // without one in the schema simply contributes its declarations without them.
    const type = info.schema?.getType(defName) as GraphQLObjectType | undefined;
    const typeFields = typeof type?.getFields === "function" ? type.getFields() : undefined;
    for (const node of nodes) {
      const name = node.name.value;
      if (!methods[name]) {
        continue;
      }
      let args: MethodSelection["args"] = undefined;
      try {
        const fieldDef = typeFields?.[name];
        if (fieldDef) {
          args = getArgumentValues(fieldDef, node, info.variableValues);
        }
      } catch (e) {
        args = undefined;
      }
      out.push({ name, args });
    }
    return out;
  }

  /**
   * Fill in what an author's declared `include` map leaves implicit.
   *
   * A declaration names the relations the method reads (`{items: {}}`); the
   * `target`/`associationType` an {@link IncludeDescriptor} carries are facts
   * about the association, not choices the author should have to restate. A key
   * naming no association is dropped rather than sent to the adapter as a
   * relation it cannot resolve.
   */
  private normalizeDeclaredInclude(defName: string, declared: DeclaredIncludeMap | undefined): IncludeMap | undefined {
    if (!declared) {
      return undefined;
    }
    let associations: {[relName: string]: Association};
    try {
      associations = this.getAssociations(defName);
    } catch (e) {
      return undefined;
    }
    const out: IncludeMap = {};
    for (const relName of Object.keys(declared)) {
      const association = associations[relName];
      if (!association) {
        logger("gqlize::manager").warn(`instance-method include declares "${defName}.${relName}", which is not a relationship — ignoring`);
        continue;
      }
      out[relName] = {
        ...declared[relName],
        target: declared[relName].target || association.target,
        associationType: declared[relName].associationType || association.associationType,
      };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private buildSelection(defName: string, info: GraphQLResolveInfo | undefined, a?: FindAllArgs): Selection {
    const nodes = (info && Array.isArray(info.fieldNodes)) ? getSelectionFieldNodes(info.fieldNodes[0], info) : undefined;
    const selectedNames = nodes?.map((f) => f.name.value);
    const methods = this.selectedMethods(defName, nodes, info);
    // An exposed method is a *field name*, not a column, so the columns it reads
    // off `this` are absent from the selection set and would be projected away.
    // Widening here — next to `withCrossAdapterJoinKeys`, which widens for
    // exactly this class of reason — is what makes the declaration mean anything.
    const declared = methods.length > 0 ? methodProjection(this.getDefinition(defName), selectedNames) : {};
    const fields = declared.fields === "*"
      ? undefined // opted out of narrowing: load every column
      : this.withCrossAdapterJoinKeys(defName, declared.fields?.length
        ? [...new Set([...(selectedNames || []), ...declared.fields])]
        : selectedNames);
    const idTargets = this.globalKeyTargetsFor(defName);
    const selection: Selection = {
      raw: info,
      variableValues: info?.variableValues,
      fields,
      countOnly: wantsCountOnly(info),
      // `targets` comes from the engine, which knows which model's keys it is
      // handing over — a relationship sub-mutation translates its *target's*
      // filter through this same closure, so baking `defName` in here would type
      // the wrong model's keys.
      translateFilter: (w, keys, targets) => replaceIdDeep(w, keys, info?.variableValues, {
        codec: this.idCodec,
        targets,
      }),
      /**
       * Guarded, unlike the `fromGlobalId(v).id` this replaces. That call does not
       * fail on input that is not a global id — it turns a raw `"42"` into `""` —
       * so a client passing a raw primary key in a mutation input had it silently
       * written away. A codec that does not recognise a value says so, and the
       * value is left exactly as it arrived.
       */
      translateId: (v, fieldName) => {
        if (typeof v !== "string" && typeof v !== "number") {
          return v;
        }
        const decoded = this.idCodec.decode({
          value: `${v}`,
          type: fieldName ? idTargets?.[fieldName] : undefined,
          defName,
          fieldName,
        });
        return decoded ? decoded.id : v;
      },
    };
    if (a && info && Array.isArray(info.fieldNodes)) {
      const definition = this.getDefinition(defName);
      if (definition.options?.autoInclude !== false) {
        const adapter = this.getModelAdapter(defName);
        try {
          let astInclude = buildIncludeFromSelection(this, defName, info.fieldNodes[0], info, undefined, this.cursorCodec);
          if (astInclude) {
            astInclude = adapter.replaceIdInInclude(astInclude, defName, info.variableValues, {codec: this.idCodec});
          }
          // `include` is one of the open keys on the args bag — see {@link FindAllArgs}.
          const explicit = a.include as IncludeMap[] | undefined;
          if (astInclude && explicit) {
            a.include = [mergeIncludeMaps(explicit[0] || {}, astInclude[0] || {})];
          } else if (astInclude) {
            a.include = astInclude;
          }
        } catch (e) {
          logger("gqlize::manager").warn("auto-include build failed, falling back to per-relation resolution", e);
        }
      }
      // Declared relations merge on top of whatever plan exists — a method's
      // `include` adds to a client-supplied one rather than clobbering it — and
      // apply whether or not auto-include is on: they are an explicit request by
      // the definition's author, not an inference from the selection set.
      const methodInclude = this.normalizeDeclaredInclude(defName, declared.include);
      if (methodInclude) {
        const existing = a.include as IncludeMap[] | undefined;
        a.include = [mergeIncludeMaps(existing?.[0] || {}, methodInclude)];
      }
      selection.include = a.include as IncludeMap[] | undefined;
    }
    if (methods.length > 0) {
      const definition = this.getDefinition(defName);
      const optionHooks = methodOptionHooks(definition, methods, { info, modelDefinition: definition });
      if (optionHooks) {
        selection.optionHooks = optionHooks;
      }
    }
    return selection;
  }

  /**
   * `info` is optional on both relationship resolvers: `buildSelection` treats an
   * absent execution context as "no selection hints", which is what a caller
   * driving a relationship hop outside a GraphQL request has.
   */
  resolveManyRelationship = async(defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, info?: GraphQLResolveInfo) => {
    const adapter = this.getModelAdapter(defName);
    // Relay-translate the (top-level) list args before the engine; the engine's
    // internal filter translations use `selection.translateFilter`.
    const a = await adapter.replaceIdInArgs(args, defName, info?.variableValues, {codec: this.idCodec});
    return this.orm.resolveManyRelationship(defName, association, source, a, context, this.buildSelection(defName, info));
  }
  resolveSingleRelationship = async(defName: string, association: Association, source: AdapterRow, args: FindAllArgs, context: RequestContext, info?: GraphQLResolveInfo) => {
    return this.orm.resolveSingleRelationship(defName, association, source, args, context, this.buildSelection(defName, info));
  }
  // `info` is optional for the same reason it is on the relationship resolvers:
  // `node(id:)` fetches through this path deliberately without one, so the
  // interface-level selection cannot narrow which columns are loaded.
  resolveFindAll = async(defName: string, source: AdapterRow, args: FindAllArgs, context: RequestContext, info?: GraphQLResolveInfo) => {
    const adapter = this.getModelAdapter(defName);
    const a = await adapter.replaceIdInArgs(args, defName, info?.variableValues, {codec: this.idCodec});
    const selection = this.buildSelection(defName, info, a);
    return this.orm.resolveFindAll(defName, source, a, context, selection);
  }
  processInputs = (defName: string, input: MutationInputTree, args: unknown, context: RequestContext, info: unknown, model?: AdapterRow) => {
    return this.orm.processInputs(defName, input, args, context, info, model);
  }
  processRelationshipMutation = (defName: string, source: AdapterRow, input: MutationInputTree | undefined, context: RequestContext, info: GraphQLResolveInfo) => {
    return this.orm.processRelationshipMutation(defName, source, input, context, this.buildSelection(defName, info));
  }
  processCreate = (defName: string, source: AdapterRow, args: { input: MutationInputTree; apply?: { [methodName: string]: unknown } }, context: RequestContext, info: GraphQLResolveInfo) => {
    return this.orm.processCreate(defName, source, args, context, this.buildSelection(defName, info));
  }
  processUpdate = (defName: string, source: AdapterRow, args: { input: MutationInputTree; where: MutationFilter; limit?: number; apply?: { [methodName: string]: unknown } }, context: RequestContext, info: GraphQLResolveInfo) => {
    return this.orm.processUpdate(defName, source, args, context, this.buildSelection(defName, info));
  }
  processSelect = (defName: string, source: AdapterRow, args: { input?: MutationInputTree; where?: MutationFilter; limit?: number }, context: RequestContext, info: GraphQLResolveInfo) => {
    return this.orm.processSelect(defName, source, args, context, this.buildSelection(defName, info));
  }
  processDelete = (defName: string, source: AdapterRow, args: MutationFilter, context: RequestContext, info: GraphQLResolveInfo) => {
    return this.orm.processDelete(defName, source, args, context, this.buildSelection(defName, info));
  }
  processRestore = (defName: string, source: AdapterRow, args: MutationFilter, context: RequestContext, info: GraphQLResolveInfo) => {
    return this.orm.processRestore(defName, source, args, context, this.buildSelection(defName, info));
  }
}

function getSelectionFieldNodes(startNode: FieldNode | undefined, info?: GraphQLResolveInfo) {
  if (!startNode || !info) {
    return undefined;
  }
  // Descend the relay connection (edges { node { … } }) to the node selection set,
  // then collect the requested fields — expanding inline/named fragments. The
  // nodes rather than their names, because an exposed method's own args live on
  // them and the same method may appear more than once under different aliases.
  const nodeSelectionSet = getChildSelectionSet(startNode.selectionSet, true, info);
  if (!nodeSelectionSet) {
    return undefined;
  }
  return flattenFieldNodes(nodeSelectionSet, info);
}

// A relay connection field that selects `total` but not `edges`/rows can be
// served by a count instead of a findAll.
function wantsCountOnly(info: GraphQLResolveInfo | undefined) {
  return Boolean(info && Array.isArray(info.fieldNodes) && !isConnectionRowsSelected(info.fieldNodes[0], info));
}
