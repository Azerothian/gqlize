import { v4 as uuidv4 } from "uuid";
import logger from "@azerothian/utilize/utils/logger";
import { Keys } from "./keys";
import { ValkeyModel } from "./model";
import { DirectExecutor, Executor, ValkeyTransaction } from "./transaction";
import { serialize, deserialize } from "./serialize";
import { planIndexes, addToIndexes, removeFromIndexes, reindex } from "./indexes";
import { executeQuery, processFilterArgument } from "./query";
import { ttlToScore, getExpiry, setExpiry } from "./expiry";
import { mapDataType, toNativeType } from "./data-type-mapper";
import typeMapper from "./type-mapper";
import replaceIdDeep from "./utils/replace-id-deep";
import * as G from "./graphql";

const log = logger("ormize::adapter::valkey::");

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
function clampPageSize(v: any): number {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

function looksLikeClient(x: any): boolean {
  return !!x && typeof x.get === "function" && typeof x.set === "function" && typeof x.multi === "function";
}

/**
 * Valkey/Redis backend adapter for ormize. Objects are typed JSON; retrieval is
 * driven exclusively by index/mapping structures (never a keyspace scan). See the
 * package README + docs/guide.md.
 */
export default class ValkeyAdapter {
  adapterName = "valkey";
  client: any;
  options: any;
  keys: Keys;
  models: { [name: string]: ValkeyModel } = {};
  private ownsClient = false;

  constructor(adapterOptions: any = {}, clientOrOptions?: any) {
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
  private execFor(options: any): { ex: Executor; finish: () => Promise<void> } {
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
  meta: { [model: string]: { [key: string]: any } } = {};
  _buildPermission: any = undefined;
  setBuildPermission = (permission: any) => { this._buildPermission = permission; };
  getMetaObj = (model: string, key: string) => this.meta[model]?.[key];
  setMetaObj = (model: string, key: string, value: any) => {
    (this.meta[model] = this.meta[model] || {})[key] = value;
  };
  getTypeMapper = () => typeMapper;
  getFilterGraphQLType = (defName: string, definition: any, permission?: any) => G.getFilterGraphQLType(this, defName, definition, permission);
  getOrderByGraphQLType = (defName: string, permission?: any) => G.getOrderByGraphQLType(this, defName, permission);
  getIncludeGraphQLType = (defName: string, definition: any, permission?: any) => G.getIncludeGraphQLType(this, defName, definition, permission);
  getDefaultListArgs = (defName: string, definition: any, permission?: any) => G.getDefaultListArgs(this, defName, definition, permission);

  // ---- relay global-id rewriting (gqlize passes global ids for id/fk fields) ----
  getGlobalKeys = (defName: string): string[] => {
    const m = this.model(defName);
    return Object.keys(m.fields).filter((k) => (m.fields[k].primaryKey || m.fields[k].foreignKey) && !m.fields[k].ignoreGlobalKey);
  };
  replaceIdInWhere = (where: any, defName: string) => replaceIdDeep(where, this.getGlobalKeys(defName));
  replaceIdInInclude = (include: any, _defName: string) => include;
  replaceIdInArgs = async (args: any, defName: string) => {
    if (args?.where) {
      return { ...args, where: this.replaceIdInWhere(args.where, defName) };
    }
    return args;
  };

  // ---- lifecycle ----
  initialise = async () => { /* ioredis connects lazily */ };
  sync = async (_options?: any) => { /* indexes are lazy; nothing to migrate */ };
  reset = async (_options?: any) => {
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
  createModel = async (def: any, _hooks?: any) => {
    const model = new ValkeyModel(def);
    this.models[def.name] = model;
    return model;
  };
  getModel = (name: string) => this.models[name];
  getModels = () => this.models;

  getFields = (defName: string) => this.model(defName).fields as any;

  getPrimaryKeyNameForModel = (defName: string): string[] => [this.model(defName).primaryKey];

  getValueFromInstance = (data: any, key: string) => (data ? data[key] : undefined);

  getAssociations = (defName: string) => {
    const model = this.model(defName);
    const out: { [rel: string]: any } = {};
    for (const rel of model.relationships) {
      const type = rel.type;
      const fk = rel.options?.foreignKey;
      out[rel.name] = {
        name: rel.name,
        target: rel.model,
        source: defName,
        foreignKey: fk,
        sourceKey: rel.options?.sourceKey,
        targetKey: rel.options?.targetKey,
        associationType: type,
        accessors: {
          get: `get${rel.name}`, set: `set${rel.name}`, add: `add${rel.name}`,
          addMultiple: `add${rel.name}`, remove: `remove${rel.name}`,
          removeMultiple: `remove${rel.name}`, count: `count${rel.name}`,
          create: `create${rel.name}`, hasSingle: `has${rel.name}`, hasAll: `has${rel.name}`,
        },
      };
    }
    return out;
  };

  getAssociation = (defName: string, relName: string) => this.getAssociations(defName)[relName];

  createRelationship = (defName: string, targetModel: string, relName: string, relType: string, options: any = {}) => {
    const source = this.model(defName);
    const fk = options.foreignKey;
    // Ensure the foreign key is an indexed field on whichever model owns it, so
    // relationship reads are index-driven.
    // Auto-created relationship FK fields are writable by default — in a KV store
    // setting the foreign key IS how you associate (there is no nested-association
    // mutation path in v1), so they must not be stripped by the mass-assignment guard.
    if (relType === "belongsTo") {
      if (fk) { source.ensureField(fk, { foreignKey: true, foreignTarget: targetModel, writable: true }); source.addIndex(fk); }
    } else if (relType === "hasMany" || relType === "hasOne") {
      const target = this.models[targetModel];
      if (target && fk) { target.ensureField(fk, { foreignKey: true, foreignTarget: defName, writable: true }); target.addIndex(fk); }
    }
    // belongsToMany join population is deferred (v1) — reads via join sets not yet built.
    return this.getAssociation(defName, relName);
  };

  createFunctionForFind = (_modelName: string) => {
    // Cross-adapter relationship proxy. Deferred in v1.
    return () => () => {
      throw new Error("ValkeyAdapter: cross-adapter relationships are not supported (v1)");
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
    return raw == null ? null : deserialize(model.fields, raw);
  }

  // ---- query ----
  processFilterArgument = (where: any, whereOperators: any, options: any) =>
    processFilterArgument(where, whereOperators, options);

  hasInlineCountFeature = () => false;
  getInlineCount = async (_models: any) => 0;

  processListArgsToOptions = (
    defName: string, args: any, offset: any, _selection: any, whereOperators: any, _graphQLArgs: any, _selectedFields: any, _runHook?: any,
  ) => {
    const limit = (args?.first != null || args?.last != null) ? clampPageSize(args.first ?? args.last) : DEFAULT_PAGE_SIZE;
    const base = { where: args?.where || {}, whereOperators, order: args?.orderBy };
    return {
      getOptions: { ...base, limit, offset: offset || 0 },
      countOptions: { ...base },
    };
  };

  findAll = async (defName: string, options: any = {}) => {
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
    return objs;
  };

  count = async (defName: string, options: any = {}) => {
    const model = this.model(defName);
    const { ex, finish } = this.execFor(options);
    const now = Date.now();
    const where = await processFilterArgument(options.where || {}, options.whereOperators, options);
    const objs = await executeQuery(ex, this.keys, model, where, now);
    await finish();
    return objs.length;
  };

  // ---- mutation ----
  getCreateFunction = (defName: string) => async (input: any, options: any = {}) => {
    const model = this.model(defName);
    const { ex, finish } = this.execFor(options);
    const now = Date.now();
    const obj = this.applyDefaults(model, input);
    let id = obj[model.primaryKey];
    if (id === undefined || id === null) {
      id = model.pkStrategy === "sequence" ? await ex.incr(this.keys.seq(defName)) : uuidv4();
      obj[model.primaryKey] = id;
    }
    const ttlMs = options.ttl ?? model.defaultTtl;
    const score = ttlToScore(ttlMs, now);
    await this.enforceUnique(ex, model, obj, id);
    ex.putObj(this.keys.obj(defName, id), serialize(model.fields, obj), ttlMs);
    addToIndexes(ex, this.keys, model, id, planIndexes(this.keys, model, obj), score, ttlMs);
    await finish();
    return obj;
  };

  getUpdateFunction = (defName: string, whereOperators: any) =>
    async (where: any, processInput: (o: any) => any, options: any = {}) => {
      const model = this.model(defName);
      const { ex, finish } = this.execFor(options);
      const now = Date.now();
      const pwhere = await processFilterArgument(where, whereOperators, options);
      const matches = await executeQuery(ex, this.keys, model, pwhere, now);
      const updated: any[] = [];
      for (const oldObj of matches) {
        const input = await processInput(oldObj);
        if (!input || Object.keys(input).length === 0) { updated.push(oldObj); continue; }
        const newObj = { ...oldObj, ...input };
        const id = oldObj[model.primaryKey];
        await this.enforceUnique(ex, model, newObj, id);
        // Preserve the current expiry unless a new ttl is supplied.
        const currentTtl = await ex.pttl(this.keys.obj(defName, id));
        const ttlMs = options.ttl ?? (currentTtl > 0 ? currentTtl : undefined);
        const score = ttlToScore(ttlMs, now);
        ex.putObj(this.keys.obj(defName, id), serialize(model.fields, newObj), ttlMs);
        reindex(ex, this.keys, model, id, oldObj, newObj, score, ttlMs);
        updated.push(newObj);
      }
      await finish();
      return updated;
    };

  getDeleteFunction = (defName: string, whereOperators: any) =>
    async (where: any, options: any = {}, before?: (o: any) => any, after?: (o: any) => any) => {
      const model = this.model(defName);
      const { ex, finish } = this.execFor(options);
      const now = Date.now();
      const pwhere = await processFilterArgument(where, whereOperators, options);
      const matches = await executeQuery(ex, this.keys, model, pwhere, now);
      const deleted: any[] = [];
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

  update = async (_record: any, _input: any, _options?: any) => {
    throw new Error("ValkeyAdapter: nested relationship mutation (update) is not supported (v1) — set the foreign key field instead");
  };

  // ---- relationships (reads) ----
  resolveSingleRelationship = async (defName: string, association: any, source: any, _args: any, _context: any, _selection: any, options: any) => {
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
    defName: string, association: any, source: any, args: any, offset: any, whereOperators: any, _selection: any, options: any, countOnly?: boolean,
  ) => {
    const sourceModel = this.model(association.source);
    const sourceKey = association.sourceKey || sourceModel.primaryKey;
    const fkFilter = { [association.foreignKey]: source[sourceKey] };
    const where = args?.where ? { and: [fkFilter, args.where] } : fkFilter;
    const limit = (args?.first != null || args?.last != null) ? clampPageSize(args.first ?? args.last) : undefined;
    const listOptions = { where, whereOperators, order: args?.orderBy, limit, offset: offset || 0, transaction: options?.transaction };
    const total = await this.count(association.target, { where, whereOperators, transaction: options?.transaction });
    if (countOnly) return { total, models: [] };
    const models = await this.findAll(association.target, listOptions);
    return { total, models };
  };

  countRelationship = async (association: any, source: any, where: any, options: any) => {
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
  transaction = async (cb: (t: any) => Promise<any>) => {
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
  getExpiry = async (defName: string, id: any, options?: any) => {
    const { ex, finish } = this.execFor(options);
    const r = await getExpiry(ex, this.keys, this.model(defName), id);
    await finish();
    return r;
  };
  setExpiry = async (defName: string, id: any, ttlMs: number | null, options?: any) => {
    const { ex, finish } = this.execFor(options);
    await setExpiry(ex, this.keys, this.model(defName), id, ttlMs);
    await finish();
  };

  /** Close the client if this adapter created it. */
  close = async () => {
    if (this.ownsClient && this.client?.quit) {
      try { await this.client.quit(); } catch { /* noop */ }
    }
  };
}
