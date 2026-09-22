import { computedOrderableFields as computedOrderableFieldsFor } from "@azerothian/utilize/exposed-methods";
import { clampPageSize, DEFAULT_PAGE_SIZE } from "@azerothian/utilize/utils/page-size";
import { globalKeyTargets, globalKeysFromFields } from "@azerothian/utilize/utils/global-keys";
import { relationshipAccessors } from "@azerothian/utilize/utils/relationship-accessors";
import { throughModelName } from "@azerothian/utilize/utils/join-keys";
import replaceIdDeep from "@azerothian/gqlize/utils/replace-id-deep";
import {
  getDefaultListArgs,
  getFilterGraphQLType,
  getIncludeGraphQLType,
  getOrderByGraphQLType,
} from "@azerothian/graphql-types/adapter-args";
import type {
  AdapterListOptions, AdapterListRequest, AdapterQueryOptions, AdapterRelationshipPage,
  AdapterRelationshipRequest, AdapterRow, AdapterWhere, Association, Definition, DeletedFilter,
  HookMap, IdTranslation, InitialiseOptions, OrderEntry, Permission, Relationship, Selection,
  WhereOperators,
} from "@azerothian/utilize/types/index";
import type { GqlizeAdapter } from "@azerothian/gqlize/types/gqlize-adapter";
import { discoverEntities, type DiscoveredEntity } from "./discover";
import { MikroModel, type MikroModelStatics, type RegisteredMikroModel } from "./model";
import {
  andWhere, buildPopulatePlan, findOptions, normaliseInclude, requiredCondition, resolveAliases,
  translateOrder, translateWhere,
} from "./query";
import { deletedOverlay, softDeleteColumn } from "./soft-delete";
import { aliasInput, readField, tagRow, tagRows, unwrapReference, type MikroRow } from "./rows";
import { createQueryConfig } from "./graphql";
import { mapDataType, toNativeType } from "./data-type-mapper";
import typeMapper from "./type-mapper";
import type {
  MikroAdapterOptions, MikroEntityManager, MikroORMInstance, MikroQueryOptions,
} from "./types/index";

export { MikroModel } from "./model";
export { CompositeKeyError, foreignKeyFieldName } from "./discover";
export type { DiscoveredEntity } from "./discover";
export type { MikroRow } from "./rows";
export type { RegisteredMikroModel, MikroModelStatics, MikroFieldMeta } from "./model";
export * from "./types/orm";
export type * from "./types/index";
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@azerothian/utilize/utils/page-size";

/**
 * MikroORM backend adapter for ormize.
 *
 * Unlike the other two adapters this one does not *build* models: it is handed a
 * MikroORM instance that already has its entities, and derives ormize
 * definitions from that instance's own metadata (`./discover`). So there is
 * nothing to `define()` — registering the adapter and calling `initialise()` is
 * the whole setup:
 *
 * ```ts
 * const mikro = await MikroORM.init({ entities: [User, Article] });
 * const db = new Ormize()
 *   .registerAdapter(new MikroAdapter<{ User: User; Article: Article }>(mikro));
 * await db.initialise();
 * ```
 *
 * `TEntities` is supplied rather than inferred because `typeof User` carries
 * `name: string`, not the literal `"User"` — there is nothing to key a map on.
 * See `./types/orm`.
 */
export default class MikroAdapter<TEntities extends Record<string, object> = Record<string, object>>
implements GqlizeAdapter {
  adapterName = "mikro-orm";
  mikro: MikroORMInstance;
  options: MikroAdapterOptions;
  models: { [name: string]: RegisteredMikroModel } = {};
  /** Discovery's output, kept so `createModel` can bind a definition back to its entity. */
  private discovered: { [name: string]: DiscoveredEntity } = {};

  /**
   * The typesystem base URI, read by `BaseOf<A>` so `ormize.models.*` resolves
   * through this adapter's registry entry rather than the default.
   */
  declare readonly __base?: import("./types/orm").IORMikroModel;
  /**
   * The models this adapter contributes without a `define()` call, read by
   * `ModelsOf<A>` in `registerAdapter`. Phantom — never present at runtime.
   */
  declare readonly __models?: { [K in keyof TEntities]: RegisteredMikroModel<TEntities[K]> };

  constructor(mikro: MikroORMInstance, adapterOptions: MikroAdapterOptions = {}) {
    if (!mikro || typeof mikro.getMetadata !== "function") {
      throw new Error("MikroAdapter: expected an initialised MikroORM instance "
        + "(the result of `MikroORM.init(...)`, or the synchronous `new MikroORM(...)`).");
    }
    this.mikro = mikro;
    this.options = adapterOptions;
  }

  getORM = () => this.mikro;

  /**
   * The EntityManager a call runs against.
   *
   * A transaction handle *is* a forked EntityManager — see `beginTransaction` —
   * so it is recognised here and nothing else has to know about transactions.
   * Otherwise `mikro.em`, which already resolves to the host application's
   * `RequestContext` fork when one is active and to the root manager when not;
   * forking behind the host's back would discard whatever it arranged.
   */
  emFor = (options?: AdapterQueryOptions): MikroEntityManager => {
    const handle = options?.transaction as MikroEntityManager | undefined;
    return handle && typeof handle.flush === "function" ? handle : this.mikro.em;
  };

  model(defName: string): RegisteredMikroModel {
    const model = this.models[defName];
    if (!model) {
      const known = Object.keys(this.models);
      throw new Error(`MikroAdapter: unknown model '${defName}'.${known.length
        ? ` Registered models: ${known.map((n) => `'${n}'`).join(", ")}.`
        : " No models have been registered - call ormize.initialise() first."}`);
    }
    return model;
  }

  hasModel = (defName: string): boolean => this.models[defName] !== undefined;

  // ---- discovery ----
  /**
   * Every entity of the MikroORM instance, as ormize definitions.
   *
   * Called by `Ormize.initialise()` after the `define()` queue has drained, so an
   * explicitly authored definition of the same name wins. Reads metadata only —
   * no connection is opened, which is what lets a schema be generated offline.
   */
  discoverDefinitions = (): Definition[] => {
    const entities = discoverEntities(this.mikro, this.options);
    for (const entity of entities) {
      this.discovered[entity.name] = entity;
    }
    return entities.map((entity) => entity.definition);
  };

  // ---- model registration ----
  // eslint-disable-next-line @typescript-eslint/require-await -- must stay async: satisfies the Promise-returning OrmAdapter.createModel contract
  createModel = async (def: Definition, _hooks?: HookMap): Promise<RegisteredMikroModel> => {
    const name = def.name as string;
    // Discovery normally runs first and has already put this entity here. A name
    // that is not in it came from a `define()` call, which this adapter cannot
    // serve: there is no entity to build, and inventing one would mean writing
    // into the MikroORM instance the caller asked us to leave alone.
    const discovered = this.discovered[name] || this.discover(name);
    if (!discovered) {
      throw new Error(`MikroAdapter: no MikroORM entity named '${name}'. This adapter binds to the `
        + `entities of the instance it was given, so a definition must name one of them - add the `
        + `entity to the MikroORM config, or define it against a different adapter.`);
    }
    const model = new MikroModel(discovered, def) as RegisteredMikroModel;
    this.models[name] = model;
    model.softDeleteColumn = softDeleteColumn(model);
    model.instanceMethods = { ...(def.instanceMethods || {}), ...(def.options?.instanceMethods || {}) };
    const classMethods = { ...(def.classMethods || {}), ...(def.options?.classMethods || {}) };
    for (const key of Object.keys(classMethods)) {
      model[key] = classMethods[key];
    }

    // Active-record-shaped statics, so `ormize.models.X.create(...)` works here
    // the way it does on the other backends. Each is a cast because the contract
    // types a row as `AdapterRow` (`unknown`) — no *caller* may assume a row's
    // shape, but this adapter knows every one of these returns its own entity.
    const statics: MikroModelStatics = {
      create: (values, options) => this.getCreateFunction(name)(values, options || {}) as Promise<object>,
      findAll: (options) => this.findAll(name, options || {}) as Promise<object[]>,
      findOne: async (options) => (await this.findAll(name, { ...(options || {}), limit: 1 }))[0] as object || null,
      findByPk: (id, options) => this.findByPk(name, id, options) as Promise<object | null>,
      count: (options) => this.count(name, options || {}),
      update: (values, options) => this.getUpdateFunction(name, undefined)(options?.where as AdapterWhere || {}, () => values, options || {}) as Promise<object[]>,
      destroy: (options) => this.getDeleteFunction(name, undefined)(options?.where as AdapterWhere || {}, options || {}) as Promise<object[]>,
    };
    Object.assign(model, statics);
    return model;
  };

  /** Re-run discovery for one name, for a `createModel` that arrived before `discoverDefinitions`. */
  private discover(name: string): DiscoveredEntity | undefined {
    for (const entity of discoverEntities(this.mikro, this.options)) {
      this.discovered[entity.name] = entity;
    }
    return this.discovered[name];
  }

  getModel = (name: string) => this.models[name];
  getModels = () => this.models;

   /**
   * Register an extra instance method on an already-registered model.
   *
   * ormize installs the accessors for a cross-adapter relationship this way,
   * because the target lives in another datastore and MikroORM has no relation
   * to walk to it. Rows pick them up in `tagRow`, alongside the definition's own
   * instance methods.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches OrmAdapter.addInstanceFunction exactly: no single call shape fits every instance method a caller might install
  addInstanceFunction = (modelName: string, name: string, fn: (...args: any[]) => any) => {
    const model = this.model(modelName);
    model.instanceMethods = { ...model.instanceMethods, [name]: fn };
  };

  getFields = (defName: string) => this.model(defName).fields;
  getPrimaryKeyNameForModel = (defName: string): string[] => [this.model(defName).primaryKey];
  getValueFromInstance = (row: AdapterRow, key: string) => {
    const entity = row as MikroRow | null;
    if (!entity) {
      return undefined;
    }
    // The row does not say which model it is; MikroORM's metadata does, and the
    // constructor is what every registered model was keyed on.
    const model = this.modelForRow(entity);
    return model ? readField(this, model, entity, key) : entity[key];
  };

  /** The registered model a returned entity belongs to, by its constructor. */
  private modelForRow(row: MikroRow): RegisteredMikroModel | undefined {
    const constructor = row?.constructor;
    for (const model of Object.values(this.models)) {
      if (model.entity === constructor || model.name === constructor?.name) {
        return model;
      }
    }
    return undefined;
  }

  getAssociations = (defName: string) => {
    const model = this.model(defName);
    const out: { [relName: string]: Association } = {};
    for (const relationship of model.relationships) {
      const name = relationship.options?.as || relationship.name;
      out[name] = {
        name,
        target: relationship.model,
        source: defName,
        // Resolved as far as this adapter can see. A relationship whose target is
        // on another adapter reports what discovery derived and ormize overlays
        // its own, fully resolved, association over ours.
        foreignKey: relationship.options?.foreignKey || "",
        sourceKey: relationship.options?.sourceKey || model.primaryKey,
        targetKey: relationship.options?.targetKey
          || (this.models[relationship.model]?.primaryKey ?? ""),
        associationType: String(relationship.type),
        // `through` is declared as a name or a descriptor object; the shared
        // helper is what reads the model name out of either.
        ...(throughModelName(relationship.options?.through) ? { through: throughModelName(relationship.options?.through) } : {}),
        ...(relationship.options?.otherKey ? { otherKey: relationship.options.otherKey } : {}),
        accessors: relationshipAccessors(name),
      };
    }
    return out;
  };

  getAssociation = (defName: string, relName: string) => this.getAssociations(defName)[relName];

  /**
   * A no-op that reports the association MikroORM already wired.
   *
   * Every other adapter *creates* the relationship here. On this backend it
   * exists before ormize is involved — discovery read it out of the metadata —
   * so there is nothing to create, and creating anything would mean writing into
   * an instance that belongs to the caller. ormize calls this only for a
   * same-adapter relationship; a cross-adapter one it resolves itself.
   */
  createRelationship = (defName: string, _targetModel: string, relName: string, _relType: string, _options: Relationship["options"] = {}) =>
    this.getAssociation(defName, relName);

  /**
   * Build the finder ormize wraps into a cross-adapter accessor: given the join
   * value read off the source row, query this adapter's model by `filterKey`.
   */
  createFunctionForFind = (modelName: string) =>
    (value: unknown, filterKey: string, singular: boolean) =>
      async (options: AdapterQueryOptions = {}) => {
        const where = this.mergeFilterStatement(filterKey, value, true, options.where);
        if (!singular) {
          return this.findAll(modelName, { ...options, where });
        }
        return (await this.findAll(modelName, { ...options, where, limit: 1 }))[0] || null;
      };

  mapDataType = mapDataType;
  toNativeType = toNativeType;

  // ---- GraphQL type-builder support (gqlize) ----
  meta: { [model: string]: { [key: string]: unknown } } = {};
  _buildPermission: Permission | undefined = undefined;
  setBuildPermission = (permission: Permission | undefined) => {
    if (permission !== this._buildPermission) {
      // These three are derived from the permission bag but cached by model name
      // alone, so a second build under a different permission would otherwise
      // reuse the previous build's (differently gated) types.
      Object.keys(this.meta).forEach((model) => {
        delete this.meta[model].queryType;
        delete this.meta[model].orderByType;
        delete this.meta[model].includeType;
      });
    }
    this._buildPermission = permission;
  };
  getMetaObj = (model: string, key: string) => this.meta[model]?.[key];
  setMetaObj = (model: string, key: string, value: unknown) => {
    (this.meta[model] = this.meta[model] || {})[key] = value;
  };
  getTypeMapper = () => typeMapper;

  // --- `AdapterArgsHost`: what the shared argument builders reach into. ---
  queryConfigFor = (defName: string, _definition?: Definition, permission?: Permission) =>
    createQueryConfig(this.model(defName), permission, this.options);
  orderableFields = (defName: string) => Object.keys(this.model(defName).fields);
  /** Computed sorts are declared on the definition; the shared builder stays definition-blind. */
  computedOrderableFields = (defName: string, permission?: Permission) =>
    computedOrderableFieldsFor(this.model(defName).definition, defName, permission !== undefined ? permission : this._buildPermission);
  relationshipsOf = (defName: string) => this.model(defName).relationships.map((relationship) => ({
    name: relationship.options?.as || relationship.name,
    model: relationship.model,
  }));
  /** A target that is not one of this adapter's models cannot be eager-loaded here. */
  targetOf = (modelName: string) => (this.models[modelName]
    ? { name: modelName, definition: this.models[modelName].definition }
    : undefined);
  softDeletes = (defName: string) => Boolean(this.models[defName]?.softDeleteColumn);
  /**
   * One include object keyed by relationship name, not a list.
   *
   * MikroORM populates by path and once per path — there is no alias under which
   * the same relation could be joined twice — so the key-value shape is the
   * accurate one, and it also selects the generated type's name.
   */
  readonly includeIsList = false;

  getFilterGraphQLType = (defName: string, definition: Definition, permission?: Permission) => getFilterGraphQLType(this, defName, definition, permission);
  getOrderByGraphQLType = (defName: string, permission?: Permission) => getOrderByGraphQLType(this, defName, permission);
  getIncludeGraphQLType = (defName: string, definition: Definition, permission?: Permission) => getIncludeGraphQLType(this, defName, definition, permission);
  getDefaultListArgs = (defName: string, definition: Definition, permission?: Permission) => getDefaultListArgs(this, defName, definition, permission);

  // ---- relay global-id rewriting ----
  getGlobalKeys = (defName: string): string[] => globalKeysFromFields(this.model(defName).fields);
  /**
   * `targets` is re-derived for `defName` rather than taken from the caller, so a
   * global id is only ever accepted for the type the field actually points at.
   */
  private idTranslation(defName: string, translation?: IdTranslation): IdTranslation {
    return { ...translation, defName, targets: globalKeyTargets(this.model(defName).fields, defName) };
  }
  replaceIdInWhere = (
    where: AdapterWhere | undefined, defName: string,
    variableValues?: { [name: string]: unknown }, translation?: IdTranslation,
  ) => replaceIdDeep(where, this.getGlobalKeys(defName), variableValues, this.idTranslation(defName, translation));
  /**
   * Decode the global ids inside an include plan's own `where` conditions, and
   * normalise the plan to the list shape the engine works in.
   *
   * Both shapes arrive. This adapter's `include` *argument* is one object keyed
   * by relationship name (`includeIsList = false`), because MikroORM populates
   * by path and there is no alias under which to repeat a join; the engine's own
   * plan is `IncludeMap[]`, one entry per level. One object is one level, so the
   * conversion is exact — and doing it here, at the boundary that declared the
   * argument shape, is what keeps every layer above working in the single shape
   * its types say it does.
   */
  replaceIdInInclude = (include: Selection["include"], defName: string,
    variableValues?: { [name: string]: unknown }, translation?: IdTranslation): Selection["include"] => {
    if (!include) {
      return include;
    }
    return normaliseInclude(include).map((level) => {
      const out: typeof level = {};
      for (const [relName, node] of Object.entries(level)) {
        const target = node.target || this.getAssociation(defName, relName)?.target;
        out[relName] = target && this.models[target]
          ? {
            ...node,
            // The engine reads `target` off each node; the GraphQL argument
            // carries only what the client wrote, so it is filled in here.
            target,
            where: node.where ? this.replaceIdInWhere(node.where, target, variableValues, translation) : node.where,
            include: node.include ? this.replaceIdInInclude(node.include, target, variableValues, translation) : node.include,
          }
          : node;
      }
      return out;
    });
  };
  /**
   * `OrmAdapter.replaceIdInArgs` declares `args` as an open bag since gqlize
   * passes it straight from resolver arguments; narrowing it here would fight the
   * interface it implements.
   */
  replaceIdInArgs = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc comment above
    args: { [name: string]: any }, defName: string,
    variableValues?: { [name: string]: unknown }, translation?: IdTranslation,
  ) => {
    if (!args) {
      return args;
    }
    const out = { ...args };
    if (args.where) {
      out.where = this.replaceIdInWhere(args.where, defName, variableValues, translation);
    }
    if (args.include) {
      // Also where the argument's object shape becomes the engine's list shape —
      // see `replaceIdInInclude`. This runs before anything else reads the bag.
      out.include = this.replaceIdInInclude(args.include, defName, variableValues, translation);
    }
    return out;
  };

  // ---- lifecycle ----
  /**
   * Schema DDL, and only when asked twice: `manageSchema` on the adapter *and*
   * `ddl !== false` on the call.
   *
   * The instance handed to this adapter belongs to the host application and its
   * schema is that application's business — an ormize call must not create
   * tables under it unasked. `ddl: false` is the offline schema-build path and
   * wins regardless.
   */
  initialise = async (options?: InitialiseOptions) => {
    if (options?.ddl === false || !this.options.manageSchema) {
      return;
    }
    await this.schema()?.create();
  };
  sync = async (_options?: AdapterQueryOptions) => {
    if (!this.options.manageSchema) {
      return;
    }
    await this.schema()?.update();
  };
  reset = async (_options?: AdapterQueryOptions) => {
    if (!this.options.manageSchema) {
      return;
    }
    await this.schema()?.refresh();
  };

  /**
   * MikroORM's schema generator, or `undefined` for a driver that has none
   * (MongoDB). Reached through `schema` on v7 and `getSchemaGenerator()` on v6,
   * since this package supports both.
   */
  private schema(): { create(): Promise<unknown>; update(): Promise<unknown>; refresh(): Promise<unknown> } | undefined {
    try {
      return this.mikro.schema || this.mikro.getSchemaGenerator?.();
    } catch {
      return undefined;
    }
  }

  /**
   * MikroORM applies no filter of its own below the engine, so §12's audit should
   * know an unannotated surface here has no runtime backstop under it.
   */
  enforcesRowScope = false;

  // ---- filters ----
  /**
   * Operator translation only — see {@link resolveAliases}.
   *
   * The contract hands this no model name (the engine's own call sites build the
   * options bag from a request context, which carries none), and a field name
   * cannot be resolved without one. So the rename happens here and the alias pass
   * happens in `findAll`/`count`, where the model is known.
   */
  processFilterArgument = (
    where: AdapterWhere | undefined, whereOperators: WhereOperators | undefined, _options: AdapterQueryOptions,
  ): AdapterWhere => translateWhere(undefined, where, whereOperators) || {};

  /**
   * Merge an equality (or, for a list, membership) filter into an existing
   * condition. `fieldName` is left as given: it may be a synthesized foreign key,
   * and the alias pass in `findAll` is what resolves it.
   */
  mergeFilterStatement = (fieldName: string, value: unknown, match = true, originalWhere?: AdapterWhere) => {
    const operator = Array.isArray(value) ? (match ? "$in" : "$nin") : (match ? "$eq" : "$ne");
    return andWhere(originalWhere, { [fieldName]: { [operator]: value } }) as AdapterWhere;
  };

  andFilterStatements = (a: AdapterWhere | undefined, b: AdapterWhere | undefined) => andWhere(a, b);

  // ---- reads ----
  /**
   * `false`, deliberately.
   *
   * MikroORM does have `findAndCount`, but the contract's shape is `findAll(…)`
   * followed by `getInlineCount(rows)` — and a total carried on the row array
   * does not survive ormize's `.filter(m => m != null)`, nor an offset past the
   * end, where the rows are empty and the total is not zero. So the count is its
   * own query.
   */
  hasInlineCountFeature = () => false;
  // eslint-disable-next-line @typescript-eslint/require-await -- must stay async: satisfies the Promise-returning OrmAdapter.getInlineCount contract
  getInlineCount = async (_models: AdapterRow[]) => 0;

  processListArgsToOptions = (defName: string, request: AdapterListRequest): AdapterListOptions => {
    const { args = {}, offset, selection, whereOperators, options = {}, selectedFields } = request;
    const model = this.model(defName);
    // An absent `first`/`last` must never mean "no limit" — see the same backstop
    // in the SQL adapter. A page size is clamped either way.
    const limit = (args.first != null || args.last != null)
      ? clampPageSize(args.first ?? args.last)
      : DEFAULT_PAGE_SIZE;
    const plan = buildPopulatePlan(
      model,
      (args.include as Parameters<typeof buildPopulatePlan>[1]) || selection?.include,
      (name) => this.models[name],
    );
    const where = andWhere(
      requiredCondition(plan.required),
      deletedOverlay(
        model,
        args.deleted as DeletedFilter | undefined,
        translateWhere(model, args.where as AdapterWhere | undefined, whereOperators),
      ),
    );
    const orderBy = translateOrder(model, args.orderBy as OrderEntry[] | undefined);
    const fields = this.selectedFields(model, selectedFields, plan.populate);
    // `options` first: it carries the transaction handle and whatever the engine
    // put there, and a later key of this adapter's own must win over a stale copy.
    const base: MikroQueryOptions = {
      ...options,
      ...(where && Object.keys(where).length ? { where } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(plan.populate.length ? { populate: plan.populate } : {}),
      ...(plan.populateWhere ? { populateWhere: plan.populateWhere } : {}),
      ...(Object.keys(plan.populateHints).length ? { populateHints: plan.populateHints } : {}),
    };
    return {
      getOptions: { ...base, limit, offset: offset || 0, ...(fields ? { fields } : {}) },
      countOptions: { ...base },
    };
  };

  /**
   * The column list for a partial load, or `undefined` for "everything".
   *
   * The primary key and every relation the populate plan walks are added back
   * whatever the selection said: a row without its key cannot be identified,
   * cursor-paged or written back, and a relation dropped from the select list
   * cannot then be populated.
   */
  private selectedFields(model: MikroModel, selected: string[] | undefined, populate: string[]): string[] | undefined {
    if (!selected || !selected.length) {
      return undefined;
    }
    const fields = new Set<string>([model.primaryKey]);
    for (const name of selected) {
      if (model.fields[name]) {
        fields.add(model.resolve(name));
      }
    }
    for (const path of populate) {
      fields.add(path.split(".")[0]);
    }
    return [...fields];
  }

  findAll = async (defName: string, options: AdapterQueryOptions = {}) => {
    const model = this.model(defName);
    const em = this.emFor(options);
    const { where, ...rest } = options as MikroQueryOptions;
    // The alias pass, not the operator one: a condition built by
    // `processFilterArgument` (a row scope, a cross-adapter join filter) is
    // already in MikroORM's vocabulary but still spelled with the synthesized
    // foreign-key names, and this is the first point that knows the model.
    return tagRows(this, model, await em.find(model.entity, resolveAliases(model, where) || {}, findOptions(rest))) as AdapterRow[];
  };

  count = async (defName: string, options: AdapterQueryOptions = {}) => {
    const model = this.model(defName);
    const em = this.emFor(options);
    const { where, ...rest } = options as MikroQueryOptions;
    // A count takes no window and no column list: `limit`/`offset`/`fields` would
    // cap the number it reports at the page size.
    const { limit: _limit, offset: _offset, fields: _fields, orderBy: _orderBy, ...countable } = findOptions(rest);
    return em.count(model.entity, resolveAliases(model, where) || {}, countable) as Promise<number>;
  };

  findByPk = async (defName: string, id: unknown, options?: AdapterQueryOptions) => {
    const model = this.model(defName);
    const em = this.emFor(options);
    const row = await em.findOne(model.entity, { [model.primaryKey]: id }, findOptions((options || {})));
    return (row ? tagRow(this, model, row) : null) as AdapterRow | null;
  };

  // ---- mutations ----
  getCreateFunction = (defName: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches AdapterCreateFunction's own permissive input bag
    async (input: { [field: string]: any }, options: AdapterQueryOptions = {}) => {
      const model = this.model(defName);
      const em = this.emFor(options);
      const row = em.create(model.entity, aliasInput(model, input)) as MikroRow;
      em.persist(row);
      await em.flush();
      return tagRow(this, model, row) as AdapterRow;
    };

  getUpdateFunction = (defName: string, whereOperators: WhereOperators | undefined) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `processInput`'s return type matches AdapterUpdateFunction's own contract signature: the patch shape belongs to whichever hook derives it
    async (where: AdapterWhere, processInput: (instance: AdapterRow) => Promise<{ [field: string]: any }> | { [field: string]: any }, options: AdapterQueryOptions = {}) => {
      const model = this.model(defName);
      const em = this.emFor(options);
      const rows = await this.findAll(defName, {
        ...options,
        where: deletedOverlay(model, options.deleted as DeletedFilter | undefined, translateWhere(model, where, whereOperators)),
        limit: typeof options.limit === "number" ? options.limit : undefined,
      }) as MikroRow[];
      for (const row of rows) {
        const input = await processInput(row);
        if (input && Object.keys(input).length) {
          em.assign(row, aliasInput(model, input));
        }
      }
      // One flush for the batch: the unit of work already has every change.
      await em.flush();
      return rows as AdapterRow[];
    };

  getDeleteFunction = (defName: string, whereOperators?: WhereOperators) =>
    this.rowVerbFunction(defName, whereOperators, "delete");

  getRestoreFunction = (defName: string, whereOperators?: WhereOperators) =>
    this.rowVerbFunction(defName, whereOperators, "restore");

  /**
   * The shared body of delete and restore.
   *
   * Serial and awaited, which is load-bearing: `before` and `after` are the
   * ormize hooks for this row, and they have to run in order around it.
   *
   * A soft-deleting model writes its column instead of removing the row, and a
   * restore is only ever that — a hard delete has nothing to come back from, so
   * restoring on a model that does not soft-delete matches nothing rather than
   * pretending to succeed.
   */
  private rowVerbFunction(defName: string, whereOperators: WhereOperators | undefined, verb: "delete" | "restore") {
    return async (
      where: AdapterWhere,
      options: AdapterQueryOptions = {},
      before?: (instance: AdapterRow) => Promise<AdapterRow> | AdapterRow,
      after?: (instance: AdapterRow) => Promise<AdapterRow> | AdapterRow,
    ) => {
      const model = this.model(defName);
      const em = this.emFor(options);
      const column = model.softDeleteColumn;
      if (verb === "restore" && !column) {
        return [];
      }
      const translated = translateWhere(model, where, whereOperators);
      const rows = await this.findAll(defName, {
        ...options,
        // A restore looks in the trash, a delete among the living.
        where: deletedOverlay(model, verb === "restore" ? "ONLY" : (options.deleted as DeletedFilter | undefined), translated),
      }) as MikroRow[];
      const done: AdapterRow[] = [];
      for (const row of rows) {
        const started = before ? await before(row) : row;
        if (column) {
          em.assign(row, { [column]: verb === "delete" ? new Date() : null });
        } else {
          em.remove(row);
        }
        await em.flush();
        done.push(after ? await after(started) : started);
      }
      return done;
    };
  }

  /** Single-row update, used by the nested relationship-mutation `update` branch. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches OrmAdapter.update's own permissive patch bag
  update = async (row: AdapterRow, input: { [field: string]: any }, options?: AdapterQueryOptions) => {
    const entity = row as MikroRow;
    const model = this.modelForRow(entity);
    if (!model) {
      throw new Error("MikroAdapter: update() requires a row this adapter returned");
    }
    const em = this.emFor(options);
    em.assign(entity, aliasInput(model, input));
    await em.flush();
    return tagRow(this, model, entity) as AdapterRow;
  };

  // ---- relationships (reads) ----
  /**
   * The one row on the far side of a `belongsTo`/`hasOne`.
   *
   * `defName` is the *target* model here, which is also where a row-level scope
   * for it was resolved: a singular relationship never reads `args.where` — the
   * accessor takes only the options bag — so the engine puts the scope on
   * `options.where`, and honouring it is this method's job.
   */
  resolveSingleRelationship = async (
    defName: string, association: Association, source: AdapterRow, request: AdapterRelationshipRequest,
  ): Promise<AdapterRow> => {
    const options = request.options || {};
    const row = source as MikroRow;
    const property = association.name;
    const target = this.models[defName] || this.models[association.target];
    // Always populate, rather than testing whether it is loaded first. Only a
    // `ref: true` property holds a `Reference` that can answer that question; a
    // plain one holds the entity itself, and an *uninitialised* entity carries no
    // marker this side of MikroORM's own internals — it looks like a loaded row
    // with every field but the key missing. `em.populate` makes that decision
    // itself and is a no-op on a relation that is already there, which is both
    // cheaper than guessing wrong and the only way to be right.
    await this.emFor(options).populate(row, [property]);
    // `unwrapReference` handles both shapes; `null` is an answer, not a miss.
    const value = unwrapReference(row[property]);
    if (value && target) {
      tagRow(this, target, value);
    }
    const scope = options.where as AdapterWhere | undefined;
    if (!value || !target || !scope || Object.keys(scope).length === 0) {
      return value;
    }
    // Re-read the row through the scope rather than filtering it here: the scope
    // is a backend condition, and deciding in memory whether it matches would be
    // a second, divergent implementation of every operator.
    const scoped = await this.emFor(options).findOne(
      target.entity,
      andWhere(resolveAliases(target, scope), { [target.primaryKey]: value[target.primaryKey] }),
    );
    return (scoped ? tagRow(this, target, scoped) : null);
  };

  /**
   * The rows on the far side of a `hasMany` or `belongsToMany`.
   *
   * An ordinary query on the target, filtered by the property that points back
   * (`em.find(Article, {author: 5})`), rather than `Collection.loadItems`.
   * A collection that is already initialised — which it is as soon as anything
   * touched it, and MikroORM's propagation touches it on every create — returns
   * what it is holding and ignores the `where`, `orderBy` and `limit` it was
   * given. A query cannot silently do that, and it is also what makes the total
   * and the page agree.
   */
  resolveManyRelationship = async (
    defName: string, association: Association, source: AdapterRow, request: AdapterRelationshipRequest,
  ): Promise<AdapterRelationshipPage> => {
    const { args = {}, offset, whereOperators, options = {}, countOnly } = request;
    const row = source as MikroRow;
    const targetName = this.models[defName] ? defName : association.target;
    const target = this.model(targetName);
    const joinFilter = this.joinFilter(association, row);
    if (!joinFilter) {
      // No property on the target points back, so there is nothing to filter on.
      return this.collectionPage(target, row, association, request);
    }
    const where = andWhere(
      joinFilter,
      deletedOverlay(
        target,
        args.deleted as DeletedFilter | undefined,
        translateWhere(target, args.where as AdapterWhere | undefined, whereOperators),
      ),
    );
    const total = await this.count(targetName, { ...options, where });
    if (countOnly) {
      return { total, models: [] };
    }
    const limit = (args.first != null || args.last != null) ? clampPageSize(args.first ?? args.last) : undefined;
    const models = await this.findAll(targetName, {
      ...options,
      where,
      ...(translateOrder(target, args.orderBy as OrderEntry[] | undefined) ? { orderBy: translateOrder(target, args.orderBy as OrderEntry[] | undefined) } : {}),
      ...(limit != null ? { limit } : {}),
      ...(offset ? { offset } : {}),
    });
    return { total, models };
  };

  /**
   * The condition selecting a to-many relationship's rows, from the target's
   * side: `{<the property that points back>: <the source's key>}`.
   *
   * `undefined` when the other side was never declared — MikroORM allows a
   * one-directional `m:n`, and then there is no property to filter on.
   */
  private joinFilter(association: Association, source: MikroRow): AdapterWhere | undefined {
    const sourceModel = this.models[association.source];
    const inverse = sourceModel?.inverseProperties[association.name];
    if (!inverse) {
      return undefined;
    }
    const sourceKey = sourceModel.primaryKey;
    return { [inverse]: source[sourceKey] };
  }

  /** The `Collection` fallback, for a relationship with no inverse property to query through. */
  private async collectionPage(
    target: RegisteredMikroModel, row: MikroRow, association: Association, request: AdapterRelationshipRequest,
  ): Promise<AdapterRelationshipPage> {
    const { args = {}, offset, whereOperators, countOnly } = request;
    const collection = row?.[association.name];
    if (!isCollectionLike(collection)) {
      return { total: 0, models: [] };
    }
    const where = deletedOverlay(
      target,
      args.deleted as DeletedFilter | undefined,
      translateWhere(target, args.where as AdapterWhere | undefined, whereOperators),
    );
    const filtered = where && Object.keys(where).length ? { where } : undefined;
    const total = await collection.loadCount(filtered || true);
    if (countOnly) {
      return { total, models: [] };
    }
    const limit = (args.first != null || args.last != null) ? clampPageSize(args.first ?? args.last) : undefined;
    const orderBy = translateOrder(target, args.orderBy as OrderEntry[] | undefined);
    const models = await collection.loadItems({
      ...(filtered || {}),
      ...(orderBy ? { orderBy } : {}),
      ...(limit != null ? { limit } : {}),
      ...(offset ? { offset } : {}),
      // Without this an initialised collection returns what it is holding, and
      // the `where`/`orderBy`/`limit` above would be silently dropped.
      refresh: true,
    });
    return { total, models: tagRows(this, target, models) };
  }

  countRelationship = async (association: Association, source: AdapterRow, where?: AdapterWhere) => {
    const target = this.model(association.target);
    const joinFilter = this.joinFilter(association, source as MikroRow);
    if (joinFilter) {
      return this.count(association.target, { where: andWhere(joinFilter, translateWhere(target, where)) });
    }
    const collection = (source as MikroRow)?.[association.name];
    if (!isCollectionLike(collection)) {
      return 0;
    }
    const translated = translateWhere(target, where);
    return collection.loadCount(translated && Object.keys(translated).length ? { where: translated } : true);
  };

  // ---- transactions ----
  /**
   * The handle is a forked EntityManager, which is exactly what `emFor` looks
   * for — so a nested mutation on this adapter joins the transaction with no
   * further plumbing, and ormize's cross-adapter handle swap keeps working.
   */
  beginTransaction = async () => {
    const fork = this.mikro.em.fork() as MikroEntityManager;
    await fork.begin();
    return { handle: fork, commit: () => fork.commit(), rollback: () => fork.rollback() };
  };
  transaction = async <T>(cb: (handle: MikroEntityManager) => Promise<T>): Promise<T> =>
    this.mikro.em.transactional((fork: MikroEntityManager) => cb(fork)) as Promise<T>;

}

/** A structural `Collection` test, kept here so the read paths above stay readable. */
function isCollectionLike(value: unknown): value is {
  loadItems(options?: object): Promise<MikroRow[]>;
  loadCount(options?: object | boolean): Promise<number>;
} {
  const c = value as { loadItems?: unknown; loadCount?: unknown } | null | undefined;
  return !!c && typeof c.loadItems === "function" && typeof c.loadCount === "function";
}

export { MikroAdapter };
