import { randomUUID } from "node:crypto";
import pluralize from "pluralize";
import {clampPageSize, DEFAULT_PAGE_SIZE} from "@azerothian/utilize/utils/page-size";
import {globalKeysFromFields} from "@azerothian/utilize/utils/global-keys";
import {relationshipAccessors} from "@azerothian/utilize/utils/relationship-accessors";
import {capitalize, lowercase} from "@azerothian/utilize/utils/word";
import type {
  AdapterQueryOptions, AdapterRow, AdapterWhere, Association, Definition, HookMap, Model,
  OrmAdapter, Permission, Relationship, Selection, WhereOperators,
} from "@azerothian/utilize/types/index";
import { Keys } from "./keys";
import { ValkeyModel } from "./model";
import { DirectExecutor, Executor, ValkeyTransaction, type ValkeyClient } from "./transaction";
import { serialize, deserialize } from "./serialize";
import { planIndexes, addToIndexes, removeFromIndexes, reindex } from "./indexes";
import { executeQuery, processFilterArgument, matchWhere } from "./query";
import { ttlToScore, getExpiry, setExpiry } from "./expiry";
import { mapDataType, toNativeType } from "./data-type-mapper";
import typeMapper from "./type-mapper";
import replaceIdDeep from "@azerothian/gqlize/utils/replace-id-deep";
import * as G from "./graphql";
import type { GqlizeAdapter } from "@azerothian/gqlize/types/gqlize-adapter";



function looksLikeClient(x: unknown): x is ValkeyClient {
  const c = x as Partial<ValkeyClient> | null | undefined;
  return !!c && typeof c.get === "function" && typeof c.set === "function" && typeof c.multi === "function";
}

/**
 * A row as this adapter makes them: the deserialized object, decorated by
 * {@link ValkeyAdapter.tag} with a hidden model tag and the instance API.
 *
 * Parameters below are typed with this rather than the contract's opaque
 * {@link AdapterRow} deliberately — see the note on {@link OrmAdapter}: no
 * *caller* may assume a row's shape, but the adapter that produced it knows
 * exactly what it is and re-narrows on the way back in.
 */
export type ValkeyRow = { [field: string]: any };

/**
 * What this adapter itself reads out of its first constructor argument. Closed,
 * not an open bag: `prefix` is the only option there is, so a misspelled one
 * should be a compile error rather than a silently unprefixed keyspace.
 */
export type ValkeyAdapterOptions = { prefix?: string };

/**
 * What the constructor takes in place of a ready client: whatever `ioredis`'s
 * own constructor takes — a URL or its options object. Opaque on purpose:
 * `ioredis` is required lazily so a caller injecting a client need not install
 * it, and the value is passed straight through unread either way.
 */
export type ValkeyConnection = string | { [option: string]: unknown };

/**
 * An {@link Association} as this adapter reports it, plus the two join-model
 * keys a `belongsToMany` is resolved through (`fkA` points at the source record,
 * `fkB` at the target). Sequelize carries those inside its own association
 * object; here the join is an ordinary indexed record, so they ride along.
 */
export type ValkeyAssociation = Association & { fkA?: string; fkB?: string };

/** Sequelize-style accessor name parts for a relation: capitalized name + singular. */
function relNames(name: string): { nameCap: string; singCap: string } {
  return { nameCap: capitalize(name), singCap: capitalize(pluralize.singular(name)) };
}

/**
 * Valkey/Redis backend adapter for ormize. Objects are typed JSON; retrieval is
 * driven exclusively by index/mapping structures (never a keyspace scan). See the
 * package README + docs/guide.md.
 */
export default class ValkeyAdapter implements GqlizeAdapter {
  adapterName = "valkey";
  client: ValkeyClient;
  options: ValkeyAdapterOptions;
  keys: Keys;
  models: { [name: string]: ValkeyModel } = {};
  private ownsClient = false;

  constructor(adapterOptions: ValkeyAdapterOptions = {}, clientOrOptions?: ValkeyClient | ValkeyConnection) {
    this.options = adapterOptions;
    this.keys = new Keys(adapterOptions.prefix || "ormize");
    if (looksLikeClient(clientOrOptions)) {
      this.client = clientOrOptions;
    } else {
      // Lazily require ioredis so consumers that always inject a client need not install it.
      const IORedis = require("ioredis");
      this.client = new (IORedis.default || IORedis)(clientOrOptions);
      this.ownsClient = true;
    }
  }

  getORM = () => this.client;

  // ---- executor selection ----
  private execFor(options?: AdapterQueryOptions): { ex: Executor; finish: () => Promise<void> } {
    const tx = options?.transaction;
    if (tx instanceof ValkeyTransaction) {
      return { ex: tx, finish: async () => {} };
    }
    const ex = new DirectExecutor(this.client);
    return { ex, finish: () => ex.flush() };
  }

  model(defName: string): ValkeyModel {
    const m = this.models[defName];
    if (!m) throw new Error(`ValkeyAdapter: unknown model "${defName}"`);
    return m;
  }

  // ---- GraphQL type-builder support (gqlize) ----
  meta: { [model: string]: { [key: string]: unknown } } = {};
  _buildPermission: Permission | undefined = undefined;
  setBuildPermission = (permission: Permission | undefined) => {
    if (permission !== this._buildPermission) {
      // These three types are derived from the permission bag but cached by
      // model name alone — a second schema build under a different permission
      // would otherwise reuse the previous build's (differently gated) types.
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
  getFilterGraphQLType = (defName: string, definition: Definition, permission?: Permission) => G.getFilterGraphQLType(this, defName, definition, permission);
  getOrderByGraphQLType = (defName: string, permission?: Permission) => G.getOrderByGraphQLType(this, defName, permission);
  getIncludeGraphQLType = (defName: string, definition: Definition, permission?: Permission) => G.getIncludeGraphQLType(this, defName, definition, permission);
  getDefaultListArgs = (defName: string, definition: Definition, permission?: Permission) => G.getDefaultListArgs(this, defName, definition, permission);

  // ---- relay global-id rewriting (gqlize passes global ids for id/fk fields) ----
  getGlobalKeys = (defName: string): string[] => globalKeysFromFields(this.model(defName).fields);
  replaceIdInWhere = (where: AdapterWhere | undefined, defName: string) => replaceIdDeep(where, this.getGlobalKeys(defName));
  replaceIdInInclude = (include: Selection["include"], _defName: string) => include;
  replaceIdInArgs = async (args: { [name: string]: any }, defName: string) => {
    if (args?.where) {
      return { ...args, where: this.replaceIdInWhere(args.where, defName) };
    }
    return args;
  };

  // ---- lifecycle ----
  initialise = async () => { /* ioredis connects lazily */ };
  sync = async (_options?: AdapterQueryOptions) => { /* indexes are lazy; nothing to migrate */ };
  reset = async (_options?: AdapterQueryOptions) => {
    // Scoped clear (no KEYS/SCAN): walk each model's `ids` and drop everything it references.
    const { ex, finish } = this.execFor({});
    for (const name of Object.keys(this.models)) {
      const model = this.models[name];
      const members = await ex.zMembers(this.keys.ids(name));
      for (const [id] of members) {
        await removeFromIndexes(ex, this.keys, model, id);
        ex.delObj(this.keys.obj(name, id));
      }
      ex.delObj(this.keys.ids(name));
      ex.delObj(this.keys.seq(name));
    }
    await finish();
  };

  // ---- model definition ----
  createModel = async (def: Definition, _hooks?: HookMap) => {
    // The model is a `ValkeyModel` plus the statics installed just below and the
    // user's own class methods — dynamic by nature, which is exactly what
    // {@link Model}'s index signature describes. The constructor is also what
    // rejects an unnamed definition, so `name` is a resolved string from here on.
    const model = new ValkeyModel(def) as ValkeyModel & Model;
    const name = model.name;
    this.models[name] = model;
    const adapter = this;

    // Sequelize-style static CRUD on the model object (so `orm.models.X.create(...)` works).
    model.create = (values: { [field: string]: any }, options?: AdapterQueryOptions) => adapter.getCreateFunction(name)(values, options);
    model.findAll = (options?: AdapterQueryOptions) => adapter.findAll(name, options || {});
    model.findOne = async (options?: AdapterQueryOptions) => (await adapter.findAll(name, { ...(options || {}), limit: 1 }))[0] || null;
    model.findByPk = (id: string | number, options?: AdapterQueryOptions) => adapter.getById(name, id, options);
    model.count = (options?: AdapterQueryOptions) => adapter.count(name, options || {});
    model.update = (values: { [field: string]: any }, options?: AdapterQueryOptions) => adapter.getUpdateFunction(name, undefined)(options?.where || {}, () => values, options);
    model.destroy = (options?: AdapterQueryOptions) => adapter.getDeleteFunction(name, undefined)(options?.where || {}, options);

    // Wire user-declared class/instance methods (top-level + options.*), matching
    // the Sequelize adapter. Class methods → statics; instance methods → stashed
    // for `tag()` to attach to each returned record.
    const classMethods = { ...(def.classMethods || {}), ...(def.options?.classMethods || {}) };
    const instanceMethods = { ...(def.instanceMethods || {}), ...(def.options?.instanceMethods || {}) };
    for (const k of Object.keys(classMethods)) model[k] = classMethods[k];
    model.__instanceMethods = instanceMethods;

    return model;
  };
  getModel = (name: string) => this.models[name];
  getModels = () => this.models;

  /**
   * Register an extra instance method on an already-defined model. Records pick it
   * up in {@link tag}, alongside the user-declared instance methods. Ormize uses
   * this to install the accessors for a cross-adapter relationship, which it has
   * to implement itself because the target lives in another datastore — a Valkey
   * "model" is a plain descriptor, so there is no prototype to hang them on.
   */
  addInstanceFunction = (modelName: string, name: string, fn: (...args: any[]) => any) => {
    const model = this.model(modelName) as ValkeyModel & Model;
    model.__instanceMethods = { ...(model.__instanceMethods || {}), [name]: fn };
  };

  getFields = (defName: string) => this.model(defName).fields;

  getPrimaryKeyNameForModel = (defName: string): string[] => [this.model(defName).primaryKey];

  getValueFromInstance = (data: ValkeyRow, key: string) => (data ? data[key] : undefined);

  getAssociations = (defName: string) => {
    const model = this.model(defName);
    const out: { [rel: string]: ValkeyAssociation } = {};
    for (const rel of model.relationships) {
      const type = rel.type;
      const fk = rel.options?.foreignKey;
      const join = rel.__join;
      out[rel.name] = {
        name: rel.name,
        target: rel.model,
        source: defName,
        // An {@link Association} reports *resolved* join keys, and the three
        // below are resolved as far as this adapter can see. The source is
        // always one of our models, so its key falls back to that model's
        // primary key — the same fallback every read below applies. The other
        // two can be genuinely unresolvable here: a target on another adapter is
        // not one of our models (ormize overlays its own, fully resolved,
        // association over ours for exactly those), and a relationship declared
        // without a foreign key was never wired at all — `createRelationship`
        // skips it. Both report the empty string rather than a guessed column
        // name: it is falsy, so the `if (key)` guards that already exist around
        // these behave as they did when the value was absent, and nothing can
        // quietly query the wrong field.
        foreignKey: fk || "",
        sourceKey: rel.options?.sourceKey || model.primaryKey,
        targetKey: rel.options?.targetKey || this.models[rel.model]?.primaryKey || "",
        associationType: type,
        // belongsToMany join descriptor (through model + the two foreign keys).
        through: join?.through,
        fkA: join?.fkA,
        fkB: join?.fkB,
        // Sequelize-style accessor names (singular for the -one variants, plural
        // for the -many). `tag()` defines exactly these on returned records.
        accessors: relationshipAccessors(rel.name),
      };
    }
    return out;
  };

  getAssociation = (defName: string, relName: string) => this.getAssociations(defName)[relName];

  createRelationship = (defName: string, targetModel: string, relName: string, relType: string, options: Relationship["options"] = {}) => {
    const source = this.model(defName);
    const fk = options.foreignKey;
    // Ensure the foreign key is an indexed field on whichever model owns it, so
    // relationship reads are index-driven.
    // Auto-created relationship FK fields are writable by default — in a KV store
    // setting the foreign key IS how you associate, so they must not be stripped
    // by the mass-assignment guard.
    if (relType === "belongsTo") {
      if (fk) { source.ensureField(fk, { foreignKey: true, foreignTarget: targetModel, writable: true }); source.addIndex(fk); }
    } else if (relType === "hasMany" || relType === "hasOne") {
      const target = this.models[targetModel];
      if (target && fk) { target.ensureField(fk, { foreignKey: true, foreignTarget: defName, writable: true }); target.addIndex(fk); }
    } else if (relType === "belongsToMany") {
      // Model the through/join as a normal indexed record with two foreign keys.
      const throughName = typeof options.through === "string" ? options.through : options.through?.model;
      const fkA = fk;
      const fkB = options.otherKey || this.deriveOtherKey(targetModel, throughName, options.through) || `${lowercase(targetModel)}Id`;
      if (throughName && fkA && fkB) {
        this.ensureJoinModel(throughName, fkA, fkB);
        const relObj = source.relationships.find((r) => r.name === relName);
        if (relObj) relObj.__join = { through: throughName, fkA, fkB };
      }
    }
    return this.getAssociation(defName, relName);
  };

  /**
   * Find the reciprocal belongsToMany's foreign key (the "other" join key).
   * `throughName` may be absent — a `belongsToMany` declared without a `through`
   * has no join model to match a reciprocal against, and no key comes back.
   */
  private deriveOtherKey(targetModel: string, throughName: string | undefined, through: Relationship["options"]["through"]): string | undefined {
    if (through && typeof through === "object" && through.otherKey) return through.otherKey;
    const t = this.models[targetModel];
    if (!t) return undefined;
    const recip = (t.relationships || []).find((r) => {
      const rt = typeof r.options?.through === "string" ? r.options.through : r.options?.through?.model;
      return r.type === "belongsToMany" && rt === throughName;
    });
    return recip?.options?.foreignKey;
  }

  /** Ensure a join model exists for a belongsToMany, with both FKs indexed. */
  private ensureJoinModel(throughName: string, fkA: string, fkB: string): void {
    let jm = this.models[throughName];
    if (!jm) {
      jm = new ValkeyModel({ name: throughName, define: {}, options: {} });
      this.models[throughName] = jm;
    }
    for (const fk of [fkA, fkB]) {
      jm.ensureField(fk, { foreignKey: true, writable: true, index: true });
      jm.addIndex(fk);
    }
  };

  /**
   * Build the finder ormize wraps into a cross-adapter accessor: given the join
   * value read off the source record, query this adapter's model by `filterKey`.
   * `filterKey` must be indexed — Valkey never scans the keyspace.
   */
  createFunctionForFind = (modelName: string) => {
    return (value: unknown, filterKey: string, singular: boolean) => {
      return async (options: AdapterQueryOptions = {}) => {
        const opts = Object.assign({}, options, {
          where: this.mergeFilterStatement(filterKey, value, true, options.where),
        });
        if (!singular) {
          return this.findAll(modelName, opts);
        }
        return (await this.findAll(modelName, { ...opts, limit: 1 }))[0] || null;
      };
    };
  };

  mapDataType = mapDataType;
  toNativeType = toNativeType;

  // ---- helpers ----
  private applyDefaults(model: ValkeyModel, input: any): any {
    const obj: any = { ...input };
    for (const key of Object.keys(model.fields)) {
      if (key === model.primaryKey) continue; // pk is assigned by the pk strategy
      if (obj[key] === undefined) {
        const dv = model.fields[key].defaultValue;
        if (dv !== undefined && (typeof dv !== "object" || dv === null)) {
          obj[key] = typeof dv === "function" ? (dv as any)() : dv;
        }
      }
    }
    return obj;
  }

  private async enforceUnique(ex: Executor, model: ValkeyModel, obj: any, id: any): Promise<void> {
    for (const field of model.uniques) {
      if (!(field in obj)) continue;
      const existing = await ex.getStr(this.keys.unique(model.name, field, obj[field]));
      if (existing && existing !== String(id)) {
        throw new Error(`ValkeyAdapter: unique constraint violation on ${model.name}.${field}`);
      }
    }
  }

  private sortObjects(objs: any[], order?: any[]): any[] {
    if (!order || !order.length) return objs;
    return [...objs].sort((a, b) => {
      for (const [field, dir] of order) {
        const av = a[field], bv = b[field];
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return String(dir).toUpperCase() === "DESC" ? -cmp : cmp;
      }
      return 0;
    });
  }

  private async getById(defName: string, id: any, options?: any): Promise<any> {
    const model = this.model(defName);
    const { ex, finish } = this.execFor(options);
    const raw = await ex.getObj(this.keys.obj(defName, id));
    await finish();
    return raw == null ? null : this.tag(deserialize(model.fields, raw), defName);
  }

  /** Single-object patch (fetch → merge → reindex → write), transaction-aware. */
  private async persistPatch(modelName: string, id: any, patch: any, options?: any): Promise<any> {
    const model = this.model(modelName);
    const { ex, finish } = this.execFor(options);
    const now = Date.now();
    const raw = await ex.getObj(this.keys.obj(modelName, id));
    if (raw == null) { await finish(); return null; }
    const oldObj = deserialize(model.fields, raw);
    const newObj = { ...oldObj, ...patch };
    await this.enforceUnique(ex, model, newObj, id);
    const currentTtl = await ex.pttl(this.keys.obj(modelName, id));
    const ttlMs = currentTtl > 0 ? currentTtl : undefined;
    const score = ttlToScore(ttlMs, now);
    ex.putObj(this.keys.obj(modelName, id), serialize(model.fields, newObj), ttlMs);
    reindex(ex, this.keys, model, id, oldObj, newObj, score, ttlMs);
    await finish();
    return this.tag(newObj, modelName);
  }

  private tagAll(records: any[], modelName: string): any[] {
    for (const r of records) this.tag(r, modelName);
    return records;
  }

  /**
   * Decorate a returned record with a hidden model tag + the Sequelize-style
   * instance API: CRUD (save/update/destroy/reload/get/toJSON), user-declared
   * instance methods, and relationship finders/mutators (get/set/add/remove/
   * count/has, singular + plural). All are non-enumerable, so they never leak
   * into serialized output. The relationship names match `getAssociations`'
   * `accessors`, so the manager's processRelationshipMutation uses them too.
   */
  private tag(record: any, modelName: string): any {
    if (!record || typeof record !== "object") return record;
    Object.defineProperty(record, "__valkeyModel", { value: modelName, enumerable: false, configurable: true });
    const adapter = this;
    const model: any = this.model(modelName);
    const pk = model.primaryKey;
    const arr = (v: any) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    const tpk = (t: string) => adapter.model(t).primaryKey;
    const plain = () => ({ ...record });
    const def = (names: string | string[], fn: any) => {
      for (const name of Array.isArray(names) ? names : [names]) {
        if (record[name] === undefined) {
          Object.defineProperty(record, name, { value: fn, enumerable: false, configurable: true });
        }
      }
    };

    // Instance CRUD.
    def("save", async (options: any) => { await adapter.persistPatch(modelName, record[pk], plain(), options); return record; });
    def("update", async (values: any, options: any) => { Object.assign(record, values); await adapter.persistPatch(modelName, record[pk], values, options); return record; });
    def("destroy", async (options: any) => adapter.getDeleteFunction(modelName, undefined)({ [pk]: record[pk] }, options));
    def("reload", async (options: any) => { const fresh = await adapter.getById(modelName, record[pk], options); if (fresh) Object.assign(record, fresh); return record; });
    def("get", (key?: any) => (key === undefined || typeof key === "object" ? plain() : record[key]));
    def("toJSON", () => plain());

    // User-declared instance methods.
    for (const [k, fn] of Object.entries(model.__instanceMethods || {})) def(k, fn);

    // Relationship finders / mutators.
    for (const assoc of Object.values(this.getAssociations(modelName)) as any[]) {
      const { name: rel, associationType: type, target, foreignKey: fk } = assoc;
      // A relationship whose target lives on another adapter has no model here and
      // cannot be walked with a Valkey lookup. Ormize installs its own accessors
      // for it (they arrive via `__instanceMethods` above), so skip it rather than
      // shadowing them with ones that would throw on an unknown model.
      if (!this.models[target]) {
        continue;
      }
      const srcKey = assoc.sourceKey || pk;
      const { nameCap, singCap } = relNames(rel);
      if (type === "belongsTo") {
        def(`get${nameCap}`, async (options: any) => (record[fk] == null ? null : adapter.getById(target, record[fk], options)));
        def(`set${nameCap}`, async (t: any, options: any) => {
          const val = t ? t[tpk(target)] : null;
          record[fk] = val;
          return adapter.persistPatch(modelName, record[pk], { [fk]: val }, options);
        });
      } else if (type === "hasOne") {
        def(`get${nameCap}`, async (options: any) => (await adapter.findAll(target, { where: { [fk]: record[srcKey] }, limit: 1, transaction: options?.transaction }))[0] || null);
        def(`set${nameCap}`, async (t: any, options: any) => {
          const current = await adapter.findAll(target, { where: { [fk]: record[srcKey] }, transaction: options?.transaction });
          for (const c of current) await adapter.persistPatch(target, c[tpk(target)], { [fk]: null }, options);
          if (t) await adapter.persistPatch(target, t[tpk(target)], { [fk]: record[srcKey] }, options);
        });
      } else if (type === "hasMany" || type === "belongsToMany") {
        const isBtm = type === "belongsToMany";
        const { through, fkA, fkB } = assoc;
        const add = async (recs: any, options: any) => {
          const throughData = (options && options.through) || {};
          for (const t of arr(recs)) {
            const tid = t[tpk(target)];
            if (isBtm) {
              const existing = await adapter.findAll(through, { where: { and: [{ [fkA]: record[srcKey] }, { [fkB]: tid }] }, transaction: options?.transaction });
              if (!existing.length) await adapter.getCreateFunction(through)({ [fkA]: record[srcKey], [fkB]: tid, ...throughData }, options);
              else if (Object.keys(throughData).length) await adapter.persistPatch(through, existing[0][adapter.model(through).primaryKey], throughData, options);
            } else {
              await adapter.persistPatch(target, tid, { [fk]: record[srcKey] }, options);
            }
          }
        };
        const remove = async (recs: any, options: any) => {
          for (const t of arr(recs)) {
            if (isBtm) await adapter.getDeleteFunction(through, undefined)({ and: [{ [fkA]: record[srcKey] }, { [fkB]: t[tpk(target)] }] }, options);
            else await adapter.persistPatch(target, t[tpk(target)], { [fk]: null }, options);
          }
        };
        const get = async (options: any) => {
          if (isBtm) {
            const edges = await adapter.findAll(through, { where: { [fkA]: record[srcKey] }, transaction: options?.transaction });
            const out: any[] = [];
            for (const e of edges) {
              const t = await adapter.getById(target, e[fkB], options);
              if (t && (!options?.where || matchWhere(t, options.where))) out.push(t);
            }
            return out;
          }
          const where = options?.where ? { and: [{ [fk]: record[srcKey] }, options.where] } : { [fk]: record[srcKey] };
          return adapter.findAll(target, { where, limit: options?.limit, transaction: options?.transaction });
        };
        const set = async (recs: any, options: any) => {
          if (isBtm) {
            await adapter.getDeleteFunction(through, undefined)({ [fkA]: record[srcKey] }, options);
          } else {
            const current = await adapter.findAll(target, { where: { [fk]: record[srcKey] }, transaction: options?.transaction });
            for (const c of current) await adapter.persistPatch(target, c[tpk(target)], { [fk]: null }, options);
          }
          await add(recs, options);
        };
        def([`add${singCap}`, `add${nameCap}`], add);
        def([`remove${singCap}`, `remove${nameCap}`], remove);
        def(`set${nameCap}`, set);
        def(`get${nameCap}`, get);
        def(`count${nameCap}`, async (options: any) => (await get(options)).length);
        def([`has${singCap}`, `has${nameCap}`], async (recs: any, options: any) => {
          const cur = new Set((await get(options)).map((r: any) => r[tpk(target)]));
          return arr(recs).every((t: any) => cur.has(t[tpk(target)]));
        });
      }
    }
    return record;
  }

  // ---- query ----
  processFilterArgument = (where: AdapterWhere | undefined, whereOperators: WhereOperators | undefined, options: AdapterQueryOptions) =>
    processFilterArgument(where, whereOperators, options);

  /** Merge an equality (or, for arrays, membership) filter into an existing `where`. */
  mergeFilterStatement = (fieldName: string, value: unknown, match = true, originalWhere?: AdapterWhere) => {
    const op = Array.isArray(value) ? (match ? "in" : "notIn") : (match ? "eq" : "ne");
    const filter = { [fieldName]: { [op]: value } };
    if (originalWhere && Object.keys(originalWhere).length) {
      return { and: [originalWhere, filter] };
    }
    return filter;
  };

  hasInlineCountFeature = () => false;
  getInlineCount = async (_models: AdapterRow[]) => 0;

  processListArgsToOptions = (
    defName: string,
    args: { [name: string]: any },
    offset: number | undefined,
    _selection: Selection,
    whereOperators: WhereOperators | undefined,
    _graphQLArgs: { getGraphQLArgs: () => { context: any; info: any; source: any } },
    _selectedFields: string[] | undefined,
    _runHook?: (defName: string, hookName: string, value: any, ...args: any[]) => Promise<any>,
  ) => {
    const limit = (args?.first != null || args?.last != null) ? clampPageSize(args.first ?? args.last) : DEFAULT_PAGE_SIZE;
    const base = { where: args?.where || {}, whereOperators, order: args?.orderBy };
    return {
      getOptions: { ...base, limit, offset: offset || 0 },
      countOptions: { ...base },
    };
  };

  findAll = async (defName: string, options: AdapterQueryOptions = {}) => {
    const model = this.model(defName);
    const { ex, finish } = this.execFor(options);
    const now = Date.now();
    const where = await processFilterArgument(options.where || {}, options.whereOperators, options);
    let objs = await executeQuery(ex, this.keys, model, where, now);
    objs = this.sortObjects(objs, options.order);
    const offset = options.offset || 0;
    if (offset || options.limit != null) {
      objs = objs.slice(offset, options.limit != null ? offset + options.limit : undefined);
    }
    await finish();
    return this.tagAll(objs, defName);
  };

  count = async (defName: string, options: AdapterQueryOptions = {}) => {
    const model = this.model(defName);
    const { ex, finish } = this.execFor(options);
    const now = Date.now();
    const where = await processFilterArgument(options.where || {}, options.whereOperators, options);
    const objs = await executeQuery(ex, this.keys, model, where, now);
    await finish();
    return objs.length;
  };

  // ---- mutation ----
  getCreateFunction = (defName: string) => async (input: { [field: string]: any }, options: AdapterQueryOptions = {}) => {
    const model = this.model(defName);
    const { ex, finish } = this.execFor(options);
    const now = Date.now();
    const obj = this.applyDefaults(model, input);
    let id = obj[model.primaryKey];
    if (id === undefined || id === null) {
      id = model.pkStrategy === "sequence" ? await ex.incr(this.keys.seq(defName)) : randomUUID();
      obj[model.primaryKey] = id;
    }
    const ttlMs = options.ttl ?? model.defaultTtl;
    const score = ttlToScore(ttlMs, now);
    await this.enforceUnique(ex, model, obj, id);
    ex.putObj(this.keys.obj(defName, id), serialize(model.fields, obj), ttlMs);
    addToIndexes(ex, this.keys, model, id, planIndexes(this.keys, model, obj), score, ttlMs);
    await finish();
    return this.tag(obj, defName);
  };

  getUpdateFunction = (defName: string, whereOperators: WhereOperators | undefined) =>
    async (where: AdapterWhere, processInput: (instance: ValkeyRow) => Promise<{ [field: string]: any }> | { [field: string]: any }, options: AdapterQueryOptions = {}) => {
      const model = this.model(defName);
      const { ex, finish } = this.execFor(options);
      const now = Date.now();
      const pwhere = await processFilterArgument(where, whereOperators, options);
      const matches = await executeQuery(ex, this.keys, model, pwhere, now);
      const updated: ValkeyRow[] = [];
      for (const oldObj of matches) {
        const input = await processInput(oldObj);
        if (!input || Object.keys(input).length === 0) { updated.push(this.tag(oldObj, defName)); continue; }
        const newObj = { ...oldObj, ...input };
        const id = oldObj[model.primaryKey];
        await this.enforceUnique(ex, model, newObj, id);
        // Preserve the current expiry unless a new ttl is supplied.
        const currentTtl = await ex.pttl(this.keys.obj(defName, id));
        const ttlMs = options.ttl ?? (currentTtl > 0 ? currentTtl : undefined);
        const score = ttlToScore(ttlMs, now);
        ex.putObj(this.keys.obj(defName, id), serialize(model.fields, newObj), ttlMs);
        reindex(ex, this.keys, model, id, oldObj, newObj, score, ttlMs);
        updated.push(this.tag(newObj, defName));
      }
      await finish();
      return updated;
    };

  getDeleteFunction = (defName: string, whereOperators: WhereOperators | undefined) =>
    async (
      where: AdapterWhere,
      options: AdapterQueryOptions = {},
      before?: (instance: AdapterRow) => Promise<AdapterRow> | AdapterRow,
      after?: (instance: AdapterRow) => Promise<AdapterRow> | AdapterRow,
    ) => {
      const model = this.model(defName);
      const { ex, finish } = this.execFor(options);
      const now = Date.now();
      const pwhere = await processFilterArgument(where, whereOperators, options);
      const matches = await executeQuery(ex, this.keys, model, pwhere, now);
      const deleted: AdapterRow[] = [];
      for (const obj of matches) {
        const b = before ? await before(obj) : obj;
        const id = obj[model.primaryKey];
        await removeFromIndexes(ex, this.keys, model, id);
        ex.delObj(this.keys.obj(defName, id));
        deleted.push(after ? await after(b) : b);
      }
      await finish();
      return deleted;
    };

  /** Single-record update (used by the nested relationship-mutation `update` branch). */
  update = async (record: ValkeyRow, input: { [field: string]: any }, options?: AdapterQueryOptions) => {
    const modelName = record?.__valkeyModel;
    if (!modelName) throw new Error("ValkeyAdapter: update() requires an adapter-returned record");
    return this.persistPatch(modelName, record[this.model(modelName).primaryKey], input, options);
  };

  // ---- relationships (reads) ----
  private async btmTargets(association: ValkeyAssociation, source: ValkeyRow, options?: AdapterQueryOptions): Promise<ValkeyRow[]> {
    const sourceModel = this.model(association.source);
    const sourceKey = association.sourceKey || sourceModel.primaryKey;
    const { through, fkA, fkB } = association;
    // Set together by `createRelationship` when it wires the join model. Absent
    // means the relationship was never wired (no `through`, or neither join key
    // could be derived), which would otherwise surface as a query against a model
    // called "undefined".
    if (!through || !fkA || !fkB) {
      throw new Error(`ValkeyAdapter: belongsToMany "${association.name}" has no join model — it was never wired`);
    }
    const edges = await this.findAll(through, { where: { [fkA]: source[sourceKey] }, transaction: options?.transaction });
    const out: ValkeyRow[] = [];
    for (const e of edges) {
      const t = await this.getById(association.target, e[fkB], options);
      if (t) out.push(t);
    }
    return out;
  }

  resolveSingleRelationship = async (
    defName: string, association: ValkeyAssociation, source: ValkeyRow, _args: { [name: string]: any },
    _context: any, _selection: Selection, options: AdapterQueryOptions,
  ) => {
    if (association.associationType === "belongsTo") {
      const targetId = source[association.foreignKey];
      if (targetId == null) return null;
      return this.getById(association.target, targetId, options);
    }
    // hasOne: target holds the FK.
    const sourceKey = association.sourceKey || this.model(defName === association.target ? association.source : defName).primaryKey;
    const rows = await this.findAll(association.target, { where: { [association.foreignKey]: source[sourceKey] }, limit: 1, transaction: options?.transaction });
    return rows[0] || null;
  };

  resolveManyRelationship = async (
    _defName: string, association: ValkeyAssociation, source: ValkeyRow, args: { [name: string]: any },
    offset: number | undefined, whereOperators: WhereOperators | undefined, _selection: Selection,
    options: AdapterQueryOptions, countOnly?: boolean,
  ) => {
    const limit = (args?.first != null || args?.last != null) ? clampPageSize(args.first ?? args.last) : undefined;
    if (association.associationType === "belongsToMany") {
      let models = await this.btmTargets(association, source, options);
      if (args?.where) models = models.filter((m) => matchWhere(m, args.where));
      models = this.tagAll(this.sortObjects(models, args?.orderBy), association.target);
      const total = models.length;
      if (countOnly) return { total, models: [] };
      const start = offset || 0;
      return { total, models: limit != null ? models.slice(start, start + limit) : models.slice(start) };
    }
    const sourceModel = this.model(association.source);
    const sourceKey = association.sourceKey || sourceModel.primaryKey;
    const fkFilter = { [association.foreignKey]: source[sourceKey] };
    const where = args?.where ? { and: [fkFilter, args.where] } : fkFilter;
    const listOptions = { where, whereOperators, order: args?.orderBy, limit, offset: offset || 0, transaction: options?.transaction };
    const total = await this.count(association.target, { where, whereOperators, transaction: options?.transaction });
    if (countOnly) return { total, models: [] };
    const models = await this.findAll(association.target, listOptions);
    return { total, models };
  };

  countRelationship = async (association: ValkeyAssociation, source: ValkeyRow, where: AdapterWhere | undefined, options?: AdapterQueryOptions) => {
    if (association.associationType === "belongsToMany") {
      let models = await this.btmTargets(association, source, options);
      if (where && Object.keys(where).length) models = models.filter((m) => matchWhere(m, where));
      return models.length;
    }
    const sourceModel = this.model(association.source);
    const sourceKey = association.sourceKey || sourceModel.primaryKey;
    const fkFilter = { [association.foreignKey]: source[sourceKey] };
    const merged = where && Object.keys(where).length ? { and: [fkFilter, where] } : fkFilter;
    return this.count(association.target, { where: merged, transaction: options?.transaction });
  };

  // ---- transactions ----
  beginTransaction = async () => {
    const tx = new ValkeyTransaction(this.client);
    return { handle: tx, commit: () => tx.commit(), rollback: () => tx.rollback() };
  };
  transaction = async <T>(cb: (t: ValkeyTransaction) => Promise<T>): Promise<T> => {
    const { handle, commit, rollback } = await this.beginTransaction();
    try {
      const r = await cb(handle);
      await commit();
      return r;
    } catch (e) {
      await rollback();
      throw e;
    }
  };

  // ---- expiry (Valkey-specific) ----
  getExpiry = async (defName: string, id: string | number, options?: AdapterQueryOptions) => {
    const { ex, finish } = this.execFor(options);
    const r = await getExpiry(ex, this.keys, this.model(defName), id);
    await finish();
    return r;
  };
  setExpiry = async (defName: string, id: string | number, ttlMs: number | null, options?: AdapterQueryOptions) => {
    const { ex, finish } = this.execFor(options);
    await setExpiry(ex, this.keys, this.model(defName), id, ttlMs);
    await finish();
  };

  /** Close the client if this adapter created it. */
  close = async () => {
    if (this.ownsClient) {
      try { await this.client.quit?.(); } catch { /* noop */ }
    }
  };
}
