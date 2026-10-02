// The row API ormize expects, put on each row this adapter returns.
//
// ormize reaches a relationship off a row *by name* — `row[association.accessors.get]`,
// `.set`, `.add`, `.addMultiple`, `.remove`, `.removeMultiple`, `.count` — and
// those names come from one shared table (`relationshipAccessors`), because a
// cross-adapter relationship looks its accessor up by the name the owning
// adapter reported. MikroORM is a Data Mapper: its entities have none of them.
//
// Per row, not on the entity prototype, and that is the load-bearing decision
// here. An entity class is module-level and shared by every MikroORM instance
// that discovers it, so a prototype method would belong to whichever ormize
// registered last — two instances over the same entities (two permission
// profiles, two tests in one file, an app and its admin surface) would route
// each other's rows. MikroORM also decorates those prototypes itself, with
// `toJSON`/`init`/`assign` among others, so "is this name already taken" cannot
// tell a user's own method from the ORM's. Tagging the row answers both: each
// row is bound to the adapter that produced it, and a marker makes it idempotent
// so the identity map handing the same object back costs nothing.
//
// Nothing in this file imports a value from `@mikro-orm/core`. `em.assign`,
// `em.populate` and the `Collection`/`Reference` shapes are all reachable
// structurally, and keeping it that way means a consumer whose `@mikro-orm/core`
// resolves to a different copy than this package's devDependency still works.

import { relationshipAccessors } from "@azerothian/utilize/utils/relationship-accessors";
import type {
  AdapterQueryOptions, AdapterRow, Association, WhereOperators,
} from "@azerothian/utilize/types/index";
import type { MikroEntityManager } from "./types/index";
import type { MikroModel, RegisteredMikroModel } from "./model";

/** A MikroORM entity, as this adapter handles it: an object with unknown fields. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the user's own entity class; its field types are known to them, and every consumer of this alias is the adapter re-narrowing its own output
export type MikroRow = { [field: string]: any };

/** A MikroORM `Collection`, structurally — see the note at the top of this file. */
interface CollectionLike {
  isInitialized(fully?: boolean): boolean;
  init(options?: object): Promise<unknown>;
  loadItems(options?: object): Promise<MikroRow[]>;
  loadCount(options?: object | boolean): Promise<number>;
  getItems(check?: boolean): MikroRow[];
  add(...items: MikroRow[]): unknown;
  remove(...items: MikroRow[]): unknown;
  set(items: MikroRow[]): void;
}

/** What the accessors need from the adapter that installs them. */
export interface RowApiHost {
  emFor(options?: AdapterQueryOptions): MikroEntityManager;
  model(defName: string): RegisteredMikroModel;
  hasModel(defName: string): boolean;
  getAssociations(defName: string): { [relName: string]: Association };
  findAll(defName: string, options: AdapterQueryOptions): Promise<AdapterRow[]>;
  getDeleteFunction(defName: string, whereOperators: WhereOperators | undefined): (
    where: object, options?: AdapterQueryOptions,
  ) => Promise<AdapterRow[]>;
}

/** `null`/`undefined` -> `[]`, a single value -> `[value]`, a list unchanged. */
function list<T>(value: T | T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

/** Whether a value is a MikroORM `Collection` rather than a single reference. */
function isCollection(value: unknown): value is CollectionLike {
  const c = value as Partial<CollectionLike> | null | undefined;
  return !!c && typeof c.loadItems === "function" && typeof c.isInitialized === "function";
}

/**
 * The entity behind a relation property, whether or not it is wrapped.
 *
 * A property declared `ref: true` holds a `Reference`; one declared without it
 * holds the entity itself, possibly uninitialised. Both answer the same
 * questions, so everything below goes through here first.
 */
export function unwrapReference(value: unknown): MikroRow | null {
  if (value == null) {
    return null;
  }
  const ref = value as { unwrap?: () => MikroRow };
  return typeof ref.unwrap === "function" ? ref.unwrap() : (value);
}

/**
 * Rewrite a mutation input's synthesized foreign keys into the relation
 * properties they stand for.
 *
 * `{authorId: 5}` becomes `{author: 5}`, which is what `em.create`/`em.assign`
 * take — MikroORM accepts a primary key in place of an entity for a relation.
 */
export function aliasInput(model: MikroModel, input: { [field: string]: unknown } | undefined): { [field: string]: unknown } {
  const out: { [field: string]: unknown } = {};
  for (const [key, value] of Object.entries(input || {})) {
    out[model.resolve(key)] = value;
  }
  return out;
}

/**
 * Read one field off a row.
 *
 * A synthesized foreign key reads the *reference's* primary key rather than
 * loading it: the key is already on an uninitialised reference, and initialising
 * one to read an id it is holding would be a query per row.
 */
export function readField(host: RowApiHost, model: MikroModel, row: MikroRow, fieldName: string): unknown {
  if (!row) {
    return undefined;
  }
  if (!model.isAlias(fieldName)) {
    return row[fieldName];
  }
  const property = model.resolve(fieldName);
  const target = unwrapReference(row[property]);
  if (target == null) {
    return null;
  }
  const relationship = model.relationships.find((r) => (r.options?.as || r.name) === property);
  const targetKey = relationship?.options?.targetKey
    || (relationship && host.hasModel(relationship.model) ? host.model(relationship.model).primaryKey : undefined);
  return targetKey ? target[targetKey] : undefined;
}

/** A row's scalar fields as a plain object, foreign keys included under their synthesized names. */
function toPlain(host: RowApiHost, model: MikroModel, row: MikroRow): { [field: string]: unknown } {
  const out: { [field: string]: unknown } = {};
  for (const fieldName of Object.keys(model.fields)) {
    out[fieldName] = readField(host, model, row, fieldName);
  }
  return out;
}

/**
 * The marker that says a row already carries the API.
 *
 * `Symbol.for` so it is stable across module boundaries: a consumer that ends up
 * with two copies of this package still recognises one copy's tagged rows.
 */
const TAGGED: unique symbol = Symbol.for("ormize.mikro-orm.tagged") as never;

/**
 * Install `name` on `row`, unless the row already carries one.
 *
 * Non-enumerable throughout: MikroORM's change tracking and serialization both
 * walk own enumerable properties, so an accessor must not look like a column.
 * Nothing already on the row is replaced — an entity's own `getArticles()` is
 * the author's, and MikroORM's own `toJSON`/`init` decorations are the ORM's.
 */
function define(
  row: MikroRow, names: string | string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- there is no one signature that fits `save()`, `getX(options)` and `setX(target, options)`; this matches OrmAdapter.addInstanceFunction's own permissive fn type for the same reason
  fn: (...args: any[]) => any,
): void {
  for (const name of Array.isArray(names) ? names : [names]) {
    if (row[name] !== undefined) {
      continue;
    }
    Object.defineProperty(row, name, { value: fn, enumerable: false, configurable: true, writable: true });
  }
}

/** Tag every row of a list, returning the same list. */
export function tagRows(host: RowApiHost, model: RegisteredMikroModel, rows: MikroRow[]): MikroRow[] {
  for (const row of rows) {
    tagRow(host, model, row);
  }
  return rows;
}

/**
 * Put the row API — CRUD, the definition's instance methods, and one accessor
 * set per relationship — on one row.
 *
 * Idempotent: the identity map hands the same object back for the same primary
 * key, and re-tagging it would redefine a dozen properties per read.
 */
export function tagRow(host: RowApiHost, model: RegisteredMikroModel, row: MikroRow): MikroRow {
  if (!row || typeof row !== "object" || (row as { [TAGGED]?: boolean })[TAGGED]) {
    return row;
  }
  Object.defineProperty(row, TAGGED, { value: true, enumerable: false, configurable: true });
  const pk = model.primaryKey;
  const def = (names: string | string[], fn: (...args: never[]) => unknown) =>
    define(row, names, fn as (...args: unknown[]) => unknown);

  // ---- instance CRUD ----
  def("save", async (options?: AdapterQueryOptions) => {
    await host.emFor(options).flush();
    return row;
  });
  def("update", async (values: { [field: string]: unknown }, options?: AdapterQueryOptions) => {
    const em = host.emFor(options);
    em.assign(row, aliasInput(model, values));
    await em.flush();
    return row;
  });
  def("destroy", async (options?: AdapterQueryOptions) =>
    // Through the adapter's delete function rather than `em.remove`, so a
    // soft-deleting model soft-deletes here too.
    host.getDeleteFunction(model.name, undefined)({ [pk]: row[pk] }, options));
  def("reload", async (options?: AdapterQueryOptions) => {
    await host.emFor(options).refresh(row);
    return row;
  });
  def("get", (key?: string | { [option: string]: unknown }) =>
    (key === undefined || typeof key === "object" ? toPlain(host, model, row) : readField(host, model, row, key)));
  def("toJSON", () => toPlain(host, model, row));

  // ---- definition-declared instance methods, and ormize's own cross-adapter accessors ----
  for (const [name, fn] of Object.entries(model.instanceMethods)) {
    def(name, fn);
  }

  // ---- relationships ----
  for (const association of Object.values(host.getAssociations(model.name))) {
    installAccessors(host, model, row, association);
  }
  return row;
}

/** One relationship's ten accessors, under the names `relationshipAccessors` gives them. */
function installAccessors(
  host: RowApiHost, model: RegisteredMikroModel, row: MikroRow, association: Association,
): void {
  const { name: relName, target, associationType } = association;
  // A target on another adapter has no MikroORM relation to walk: ormize installs
  // its own accessors for it (through `addInstanceFunction`, which lands in
  // `model.instanceMethods` above), so leave the names free rather than
  // shadowing them with ones that would throw.
  if (association.crossAdapter || !host.hasModel(target)) {
    return;
  }
  // The shared table, not a local spelling — `getAssociations` already *reports*
  // these names from it, and a second source of truth for the same names is
  // exactly what a cross-adapter lookup by the reported name cannot survive.
  const accessors = relationshipAccessors(relName);
  // Discovery names an ormize relationship after the MikroORM property it came
  // from, so the two are the same string — named here so the reads below say
  // which of the two they mean.
  const property = relName;
  const def = (names: string | string[], fn: (...args: never[]) => unknown) =>
    define(row, names, fn as (...args: unknown[]) => unknown);
  const targetPk = () => host.model(target).primaryKey;

  if (associationType === "belongsTo" || associationType === "hasOne") {
    def(accessors.get, async (options?: AdapterQueryOptions) => {
      await host.emFor(options).populate(row, [property]);
      return unwrapReference(row[property]);
    });
    def(accessors.set, async (value: MikroRow | null, options?: AdapterQueryOptions) => {
      // Assignment on either side of a to-one relation propagates in MikroORM,
      // so the inverse (`hasOne`) case needs nothing extra here.
      row[property] = value ?? null;
      await host.emFor(options).flush();
      return row;
    });
    return;
  }

  const collectionOf = (): CollectionLike => {
    const value = row[property];
    if (!isCollection(value)) {
      throw new Error(`MikroAdapter: '${model.name}.${property}' is not a collection, `
        + `but relationship '${relName}' is a ${associationType}.`);
    }
    return value;
  };
  /** A collection must be loaded before it can be diffed against, which `set`/`remove` do. */
  const loaded = async (): Promise<CollectionLike> => {
    const collection = collectionOf();
    if (!collection.isInitialized()) {
      await collection.init();
    }
    return collection;
  };

  const get = async (options?: AdapterQueryOptions) =>
    // `loadItems` takes the read shape directly, so a relationship read is one
    // query with its own filter rather than a full load filtered in memory.
    collectionOf().loadItems({
      ...(options?.where ? { where: options.where } : {}),
      ...(options?.orderBy ? { orderBy: options.orderBy } : {}),
      ...(options?.limit != null ? { limit: options.limit } : {}),
      ...(options?.offset != null ? { offset: options.offset } : {}),
    });
  const add = async (items: MikroRow | MikroRow[], options?: AdapterQueryOptions) => {
    const through = (options?.through || {}) as { [field: string]: unknown };
    if (associationType === "belongsToMany" && Object.keys(through).length > 0) {
      await addThroughRows(host, model, association, row, list(items), through, options);
      return row;
    }
    const collection = await loaded();
    collection.add(...list(items));
    await host.emFor(options).flush();
    return row;
  };
  const remove = async (items: MikroRow | MikroRow[], options?: AdapterQueryOptions) => {
    const collection = await loaded();
    collection.remove(...list(items));
    await host.emFor(options).flush();
    return row;
  };
  const set = async (items: MikroRow | MikroRow[], options?: AdapterQueryOptions) => {
    const collection = await loaded();
    collection.set(list(items));
    await host.emFor(options).flush();
    const through = (options?.through || {}) as { [field: string]: unknown };
    if (associationType === "belongsToMany" && Object.keys(through).length > 0) {
      await addThroughRows(host, model, association, row, list(items), through, options);
    }
    return row;
  };

  def(accessors.get, get);
  def([accessors.add, accessors.addMultiple], add);
  def([accessors.remove, accessors.removeMultiple], remove);
  def(accessors.set, set);
  def(accessors.count, async (options?: AdapterQueryOptions) =>
    collectionOf().loadCount(options?.where ? { where: options.where } : true));
  def([accessors.hasSingle, accessors.hasAll], async (items: MikroRow | MikroRow[], options?: AdapterQueryOptions) => {
    const current = new Set((await get(options)).map((item) => item[targetPk()]));
    return list(items).every((item) => current.has(item[targetPk()]));
  });
}

/**
 * Write the extra columns of a many-to-many's join rows.
 *
 * `Collection.add` links two entities and nothing more, which is all an
 * auto-generated pivot has room for. A pivot the author declared as an entity
 * can carry its own columns, and ormize passes their values as `options.through`
 * — so those rows are created (or patched, if the link already exists) through
 * the pivot model directly.
 */
async function addThroughRows(
  host: RowApiHost, model: MikroModel, association: Association,
  source: MikroRow, targets: MikroRow[], through: { [field: string]: unknown },
  options?: AdapterQueryOptions,
): Promise<void> {
  const pivotName = association.through;
  const ownKey = association.foreignKey;
  const otherKey = association.otherKey;
  if (!pivotName || !ownKey || !otherKey || !host.hasModel(pivotName)) {
    throw new Error(`MikroAdapter: relationship '${association.source}.${association.name}' carries `
      + `join-row data but has no join model to write it to. Declare the pivot as an entity `
      + `(MikroORM's \`pivotEntity\`) to give those columns somewhere to live.`);
  }
  const pivot = host.model(pivotName);
  const em = host.emFor(options);
  const sourceId = source[model.primaryKey];
  const targetPk = host.model(association.target).primaryKey;
  for (const target of targets) {
    const link = { [ownKey]: sourceId, [otherKey]: target[targetPk] };
    const existing = await host.findAll(pivotName, { where: link, limit: 1, transaction: options?.transaction });
    if (existing.length) {
      em.assign(existing[0], aliasInput(pivot, through));
    } else {
      em.persist(em.create(pivot.entity, aliasInput(pivot, { ...link, ...through })));
    }
  }
  await em.flush();
}
