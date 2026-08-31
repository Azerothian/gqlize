import { isOrmizeDataType } from "../types/data-type";
import type { Definition, Relationship } from "../types/index";

/**
 * Copy-on-write helpers for caller-owned config.
 *
 * A `Definition` and the options bag handed to `new Ormize(...)` belong to the
 * caller: ormize reads them and must never write to them. That is not a style
 * preference — a definition module is routinely imported once and built twice
 * (two adapters, two permission profiles, an orm per test), and a backend that
 * writes on what it is given makes the second build see the first build's state.
 *
 * The depth below is not "deep clone". It is exactly the set of containers a
 * backend is known to write on, established by reading sequelize's own source:
 *
 *  - `define[field]` — `Sequelize.normalizeAttribute` rewrites `type` and
 *    `defaultValue` in place, and `Model.refreshAttributes` hangs `Model` (a
 *    *circular* back-reference), `fieldName`, `field` and `_modelAttribute` on
 *    every attribute. Those attributes are the definition's own objects unless
 *    they are copied first, which is what makes an unfixed definition
 *    unserializable after a build.
 *  - `define[field].references` — `normalizeAttribute` writes through it
 *    (`references.model = ...getTableName()`).
 *  - `options.indexes[i]` — `Model._conformIndex` defaults `type`/`parser` onto
 *    each entry and, for a unique index, sets `unique` and deletes `type`;
 *    `Utils.nameIndex` then stamps a `name` derived from the table name, so a
 *    definition reused against a second table carries the first one's index name.
 *  - `relationships[i].options.through` — resolved from a model *name* to a model
 *    *class* at wiring time, and sequelize's association builders write on the
 *    options object they are handed.
 *
 * Deliberately NOT copied, each for a checked reason:
 *  - `options.hooks` — `_setupHooks` reads the map and writes only to sequelize's
 *    own `this.options.hooks`.
 *  - `options.defaultScope` / `options.scopes` — `_injectScope` clones through
 *    `Utils.cloneDeep` before use.
 *  - every function (hooks, `resolve`, computed `orderBy`), every DataType token
 *    and every class reference — carried by identity. Copying a token would
 *    break the identity the adapters' type mapping relies on, and a generic
 *    `structuredClone` is not an option here at all: it throws on the first
 *    function it meets, and these objects are full of them.
 *
 * If you widen the depth, name the backend behaviour that forced it. If you
 * narrow it, `packages/ormize/__tests__/config-purity.test.ts` will say so.
 */

/**
 * A plain data container — an object literal, not a class instance, not an
 * ormize DataType token.
 *
 * The token check is load-bearing rather than defensive: tokens ARE plain
 * objects (`{[ORMIZE_DATATYPE]: true, type, ...}`), so a bare prototype test
 * would copy them, and a field may be authored in the shorthand form
 * `field: DataTypes.String` where the token *is* the descriptor.
 */
function isCopyableContainer(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (isOrmizeDataType(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `{...value}` when it is a plain container, otherwise the value itself. */
function copyContainer<T>(value: T): T {
  return isCopyableContainer(value) ? { ...value } : value;
}

/** One field descriptor, plus the one nested container sequelize writes through. */
export function copyField<T>(field: T): T {
  if (!isCopyableContainer(field)) {
    // The shorthand form (`field: DataTypes.String`) or an adapter-native type
    // instance. Neither is a container this owns, and neither is written to.
    return field;
  }
  const copy = { ...field } as Record<string, unknown>;
  if (copy.references !== undefined) {
    copy.references = copyContainer(copy.references);
  }
  return copy as T;
}

/**
 * A field map: new map, each descriptor copied.
 *
 * Exported because an adapter needs it on its own account — `createModel` is
 * public and is called directly, with no manager and so no boundary copy, in
 * both the adapter's own tests and in userland.
 */
export function copyDefine<T>(define: T): T {
  if (!isCopyableContainer(define)) {
    return define;
  }
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(define)) {
    out[name] = copyField(define[name]);
  }
  return out as T;
}

/**
 * Model options: new object, with the `indexes` array, its entries, and each
 * entry's `fields` list copied — `_conformIndex` and `nameIndex` write to all
 * three.
 */
export function copyModelOptions<T>(options: T): T {
  if (!isCopyableContainer(options)) {
    // `undefined`, or an options bag someone built as a class instance. Neither
    // is a container to copy.
    return options;
  }
  const out = { ...options } as Record<string, unknown>;
  if (Array.isArray(out.indexes)) {
    out.indexes = out.indexes.map((index) => {
      const copy = copyContainer(index) as Record<string, unknown>;
      if (copy !== index && Array.isArray(copy.fields)) {
        copy.fields = [...copy.fields];
      }
      return copy;
    });
  }
  return out as T;
}

/** Relationship options, with an object-form `through` copied. */
export function copyRelationshipOptions(options: Relationship["options"]): Relationship["options"] {
  if (!isCopyableContainer(options)) {
    return options;
  }
  const copy = { ...options };
  if (copy.through !== undefined && typeof copy.through === "object") {
    copy.through = { ...copy.through };
  }
  return copy;
}

/** A relationship entry, its options, and an object-form `through`. */
function copyRelationship(rel: Relationship): Relationship {
  if (!isCopyableContainer(rel)) {
    return rel;
  }
  const copy = { ...rel };
  if (copy.options !== undefined) {
    copy.options = copyRelationshipOptions(copy.options);
  }
  return copy;
}

/**
 * The copy of a definition that is safe to hand to a backend.
 *
 * Generic over the definition type so an adapter-extended definition (the
 * sequelize adapter's `SequelizeDefinition`, with its `queries` and
 * `removeAttributes`) keeps its own shape rather than being widened to
 * `Definition`.
 */
export function copyDefinition<T extends Definition>(def: T): T {
  const copy = { ...def } as T & Record<string, unknown>;

  if (def.define) {
    copy.define = copyDefine(def.define as unknown as Record<string, unknown>) as T["define"];
  }

  if (def.options) {
    copy.options = copyModelOptions(def.options as unknown as Record<string, unknown>);
  }

  if (Array.isArray(def.relationships)) {
    copy.relationships = def.relationships.map(copyRelationship);
  }

  return copy;
}
