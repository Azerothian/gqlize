// MikroORM metadata -> ormize definitions.
//
// This is the inverted half of the adapter, and the reason the package exists:
// the other two backends are handed a `Definition` and build a native model from
// it, while here the native models already exist and the definitions are derived
// from them. Nothing in this file opens a connection — MikroORM has already run
// its own discovery by the time an instance is handed over, and reading that
// metadata is what keeps `initialise({ddl: false})` honest.

import { capitalize } from "@azerothian/utilize/utils/word";
import { copyDefinition } from "@azerothian/utilize/utils/copy-on-write";
import type {
  Definition, DefinitionFieldMeta, DefinitionFields, Relationship,
} from "@azerothian/utilize/types/index";
import { DataType, DataTypes, type DataTypeDescriptor } from "@azerothian/utilize/types/data-type";
import { mapDataType } from "./data-type-mapper";
import type { MikroAdapterOptions, MikroORMInstance } from "./types/index";

/**
 * MikroORM's `ReferenceKind`, spelled out rather than imported.
 *
 * The values are the enum's own string values and are part of MikroORM's public
 * metadata, so comparing against them is comparing against the same constants —
 * but it keeps this module free of a value import from the peer dependency, so a
 * consumer on v6 and one on v7 both work without the package resolving two
 * copies of the enum.
 */
const Kind = {
  Scalar: "scalar",
  OneToOne: "1:1",
  OneToMany: "1:m",
  ManyToOne: "m:1",
  ManyToMany: "m:n",
  Embedded: "embedded",
} as const;

/**
 * As much of a MikroORM `EntityProperty` as discovery reads. Structural for the
 * same reason as the types in `./types` — the real one is generic in both the
 * owning and the target entity.
 */
export interface MikroProp {
  name: string;
  kind: string;
  type?: string;
  runtimeType?: string;
  fieldNames?: string[];
  primary?: boolean;
  autoincrement?: boolean;
  nullable?: boolean;
  unique?: boolean | string;
  index?: boolean | string;
  default?: string | number | boolean | null;
  defaultRaw?: string;
  comment?: string;
  hidden?: boolean;
  lazy?: boolean;
  persist?: boolean;
  getter?: boolean;
  formula?: unknown;
  enum?: boolean;
  items?: (string | number)[];
  array?: boolean;
  columnTypes?: string[];
  owner?: boolean;
  mappedBy?: string;
  inversedBy?: string;
  embedded?: [string, string];
  onCreate?: unknown;
  onUpdate?: unknown;
  version?: boolean;
  targetMeta?: MikroMeta;
  pivotEntity?: unknown;
  pivotTable?: string;
  referencedColumnNames?: string[];
}

/** As much of a MikroORM `EntityMetadata` as discovery reads. */
export interface MikroMeta {
  className: string;
  tableName?: string;
  schema?: string;
  comment?: string;
  primaryKeys: string[];
  compositePK?: boolean;
  props: MikroProp[];
  properties: { [name: string]: MikroProp };
  relations?: MikroProp[];
  pivotTable?: boolean;
  embeddable?: boolean;
  abstract?: boolean;
  virtual?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the entity constructor, which `em.find`/`em.create` take by reference; its shape is the user's, not ours
  class?: any;
}

/**
 * One entity, as this adapter needs to remember it.
 *
 * The `Definition` is what ormize is given; `aliases` and `pivot` are what only
 * this adapter needs and a definition has no place to carry.
 */
export interface DiscoveredEntity {
  name: string;
  definition: Definition;
  meta: MikroMeta;
  /** Primary key property name. Single — see {@link CompositeKeyError}. */
  primaryKey: string;
  /**
   * Synthesized field name -> the MikroORM property it stands for.
   *
   * MikroORM has no scalar property for a foreign key: the relation property
   * *is* the key holder, so `Article.author` both names the relation and stores
   * `author_id`. ormize and gqlize need a real field for it — that is what
   * `create-basic-fields` mints the relay global id from, and typing it by what
   * it points at is the whole of #65 — so discovery invents `authorId` and this
   * table maps it back. Every `where`, `orderBy`, `fields` and mutation input is
   * run through it before reaching MikroORM.
   */
  aliases: { [fieldName: string]: string };
  /**
   * Relationship name -> the property that points back, on the *other* entity.
   *
   * MikroORM's `mappedBy`/`inversedBy`, under one name. It is what lets a
   * to-many read be an ordinary query on the target (`em.find(Article, {author:
   * 5})`, `em.find(Tag, {articles: 5})`) rather than a `Collection.loadItems` —
   * which returns what it already holds when the collection is initialised, so a
   * filtered or paged read would silently ignore its own arguments.
   *
   * Absent for a relationship whose other side was never declared; there is then
   * no property to filter on and the collection is the only way through.
   */
  inverseProperties: { [relName: string]: string };
  /** True for a pivot entity the author declared, rather than an ordinary model. */
  pivot: boolean;
}

/**
 * A composite primary key was found.
 *
 * Named rather than a bare `Error` because it is a capability limit, not a bug:
 * ormize itself reads `getPrimaryKeyNameForModel(...)[0]` throughout, so a
 * two-column key would be silently half-used — an id minted from one column and
 * a `node(id:)` lookup that never matches. Better to say so at discovery, where
 * the entity's name is still in hand.
 */
export class CompositeKeyError extends Error {
  constructor(entityName: string, keys: string[]) {
    super(`MikroAdapter: entity '${entityName}' has a composite primary key (${keys.join(", ")}), which this adapter does not support. `
      + `Exclude it with MikroAdapterOptions.entities, or give it a single surrogate key.`);
    this.name = "CompositeKeyError";
  }
}

/** The synthesized scalar name for a relation property: `author` + `id` -> `authorId`. */
export function foreignKeyFieldName(relationName: string, referencedKey: string): string {
  return `${relationName}${capitalize(referencedKey)}`;
}

/** Whether a property is a relation rather than a column. */
function isRelation(prop: MikroProp): boolean {
  return prop.kind === Kind.OneToOne || prop.kind === Kind.OneToMany
    || prop.kind === Kind.ManyToOne || prop.kind === Kind.ManyToMany;
}

/** Whether a relation property holds the foreign key itself (so the source owns it). */
function ownsForeignKey(prop: MikroProp): boolean {
  return prop.kind === Kind.ManyToOne || (prop.kind === Kind.OneToOne && prop.owner === true);
}

/** The field this property maps to on the model that owns the key. */
function referencedKeyOf(prop: MikroProp): string {
  return prop.targetMeta?.primaryKeys?.[0] || prop.referencedColumnNames?.[0] || "id";
}

/**
 * A scalar column as a {@link DefinitionFieldMeta}.
 *
 * `writable` is the mass-assignment guard: a column MikroORM will compute or
 * overwrite — a generated primary key, a `formula`, a getter, a `@Property({
 * persist: false })`, a version column, an `onCreate`/`onUpdate` hook — must not
 * be settable through a mutation input, because the value would be accepted and
 * then silently discarded.
 */
function scalarField(prop: MikroProp, type: DataTypeDescriptor): DefinitionFieldMeta {
  // Whatever the backend will fill in if the input does not: a generated key, a
  // declared default, a hook, a version counter, a formula. It is what makes a
  // non-nullable column optional in the generated create input, so leaving a
  // defaulted column out of it would demand a value the database already has.
  const hasDefault = prop.default !== undefined || prop.defaultRaw !== undefined;
  const autoPopulated = Boolean(
    prop.autoincrement || hasDefault || prop.onCreate || prop.onUpdate || prop.version || prop.formula,
  );
  // Narrower than `autoPopulated`, and a different question: not "will the
  // backend fill this in" but "may a caller set it at all". A default is a
  // starting value and can be overridden; a value MikroORM computes on write
  // cannot, so accepting one would take it and throw it away.
  const writable = prop.persist !== false && !prop.getter && !prop.formula && !prop.version
    && !prop.autoincrement && !prop.onCreate && !prop.onUpdate;
  return {
    name: prop.name,
    type,
    primaryKey: Boolean(prop.primary),
    allowNull: Boolean(prop.nullable),
    unique: Boolean(prop.unique),
    index: Boolean(prop.index),
    autoPopulated,
    writable,
    ...(prop.default !== undefined && prop.default !== null ? { defaultValue: prop.default } : {}),
    ...(prop.comment ? { description: prop.comment, comment: prop.comment } : {}),
  };
}

/** The relationship type ormize uses for a MikroORM reference kind. */
function relationshipType(prop: MikroProp): Relationship["type"] | undefined {
  switch (prop.kind) {
    case Kind.ManyToOne: return "belongsTo";
    case Kind.OneToOne: return prop.owner === true ? "belongsTo" : "hasOne";
    case Kind.OneToMany: return "hasMany";
    case Kind.ManyToMany: return "belongsToMany";
    default: return undefined;
  }
}

/**
 * Merge an author's per-entity overrides over a derived definition.
 *
 * `define`, `options`, `comments`, `deprecations` and `override` merge key by
 * key, `ignoreFields` and `relationships` merge by name; everything else is
 * replaced wholesale. The distinction is what makes an override usable at all:
 * naming one column's comment must not drop the other forty columns discovery
 * just found, while an `expose` block or a `before` hook has no derived
 * counterpart to merge with.
 */
export function mergeDefinition(derived: Definition, overrides?: Partial<Definition>): Definition {
  if (!overrides) {
    return derived;
  }
  const { define, options, comments, deprecations, override, ignoreFields, relationships, ...rest } = overrides;
  return {
    ...derived,
    ...rest,
    define: { ...(derived.define || {}), ...(define || {}) },
    options: { ...(derived.options || {}), ...(options || {}) },
    comments: { ...(derived.comments || {}), ...(comments || {}) },
    deprecations: { ...(derived.deprecations || {}), ...(deprecations || {}) },
    override: { ...(derived.override || {}), ...(override || {}) },
    // Additive: discovery contributes MikroORM's own `hidden` properties, and an
    // author naming more must not un-hide those.
    ignoreFields: [...new Set([...(derived.ignoreFields || []), ...(ignoreFields || [])])],
    // Additive too, keyed by name. This is how a *cross-adapter* relationship is
    // declared — MikroORM cannot express one, since the other end is not one of
    // its entities — and an author adding one must not have to restate the
    // relationships discovery already found.
    relationships: mergeRelationships(derived.relationships, relationships),
  };
}

/** Derived relationships plus the author's, with a same-named override winning. */
function mergeRelationships(derived?: Relationship[], overrides?: Relationship[]): Relationship[] {
  if (!overrides?.length) {
    return derived || [];
  }
  const byName = new Map((derived || []).map((relationship) => [relationship.name, relationship]));
  for (const relationship of overrides) {
    byName.set(relationship.name, relationship);
  }
  return [...byName.values()];
}

/** Derive one entity's definition, alias table and primary key. */
function discoverEntity(meta: MikroMeta, metas: Map<string, MikroMeta>): DiscoveredEntity {
  if (meta.compositePK || meta.primaryKeys.length > 1) {
    throw new CompositeKeyError(meta.className, meta.primaryKeys);
  }
  const define: DefinitionFields = {};
  const aliases: { [fieldName: string]: string } = {};
  const relationships: Relationship[] = [];
  const inverseProperties: { [relName: string]: string } = {};
  const ignoreFields: string[] = [];
  const comments: { [fieldName: string]: string } = {};
  const primaryKey = meta.primaryKeys[0];

  for (const prop of meta.props) {
    // A flattened embeddable sub-column. Its parent (kind `embedded`) is emitted
    // as one object field, so emitting these too would put both the object and
    // its members in the schema.
    if (prop.embedded) {
      continue;
    }
    if (prop.hidden) {
      ignoreFields.push(prop.name);
    }
    if (prop.comment) {
      comments[prop.name] = prop.comment;
    }

    if (!isRelation(prop)) {
      // An embeddable is one JSON-shaped field here rather than a nested type —
      // see the package README's limitations.
      define[prop.name] = scalarField(prop, prop.kind === Kind.Embedded ? DataTypes.JSON : mapDataType(prop));
      continue;
    }

    const type = relationshipType(prop);
    if (!type || !prop.targetMeta) {
      continue;
    }
    const target = prop.targetMeta.className;
    const inverse = prop.mappedBy || prop.inversedBy;
    if (inverse) {
      inverseProperties[prop.name] = inverse;
    }

    if (ownsForeignKey(prop)) {
      // The synthesized scalar the relation's key is exposed as. `foreignTarget`
      // is what #65 turned on: the global id minted for this field belongs to the
      // model it points at, not to the model that holds it.
      const referenced = referencedKeyOf(prop);
      const fieldName = foreignKeyFieldName(prop.name, referenced);
      aliases[fieldName] = prop.name;
      const targetPk = prop.targetMeta.properties?.[referenced];
      define[fieldName] = {
        name: fieldName,
        type: targetPk ? mapDataType(targetPk) : DataTypes.Unknown,
        foreignKey: true,
        foreignTarget: target,
        allowNull: Boolean(prop.nullable),
        // Setting the foreign key is how a relation is re-pointed, so it must
        // survive the mass-assignment guard.
        writable: true,
        ...(prop.comment ? { description: prop.comment, comment: prop.comment } : {}),
      } as DefinitionFields[string];
      relationships.push({
        model: target,
        name: prop.name,
        type,
        options: { as: prop.name, foreignKey: fieldName, targetKey: referenced, sourceKey: fieldName },
      });
      continue;
    }

    if (type === "belongsToMany") {
      const pivot = pivotMetaFor(prop, metas);
      relationships.push({
        model: target,
        name: prop.name,
        type,
        options: {
          as: prop.name,
          foreignKey: pivot?.own || "",
          otherKey: pivot?.other || "",
          sourceKey: primaryKey,
          targetKey: prop.targetMeta.primaryKeys[0],
          ...(pivot?.through ? { through: pivot.through } : {}),
        },
      });
      continue;
    }

    // hasMany / inverse hasOne: the *target* holds the key, under the name
    // discovery synthesized for the owning property over there.
    const owning = prop.mappedBy ? prop.targetMeta.properties?.[prop.mappedBy] : undefined;
    const foreignKey = prop.mappedBy
      ? foreignKeyFieldName(prop.mappedBy, owning ? referencedKeyOf(owning) : primaryKey)
      : "";
    relationships.push({
      model: target,
      name: prop.name,
      type,
      options: { as: prop.name, foreignKey, sourceKey: primaryKey, targetKey: foreignKey },
    });
  }

  const definition: Definition = {
    name: meta.className,
    define,
    relationships,
    ...(meta.comment ? { comment: meta.comment } : {}),
    ...(Object.keys(comments).length ? { comments: { ...comments } } : {}),
    ...(ignoreFields.length ? { ignoreFields } : {}),
    options: {
      ...(meta.tableName ? { tableName: meta.tableName } : {}),
      ...(meta.schema ? { schema: meta.schema } : {}),
    },
  };

  return {
    name: meta.className, definition, meta, primaryKey, aliases, inverseProperties,
    pivot: isPivotLike(meta),
  };
}

/**
 * The pivot entity behind a many-to-many, and which of its two foreign keys
 * points back at the source — or `undefined` when MikroORM generated the pivot
 * itself, since one of those is not registered (see {@link discoverEntities}).
 *
 * Both keys are named the way discovery names every other foreign key, so the
 * join model ormize resolves through and the definition discovery registered for
 * it agree on their spelling.
 */
function pivotMetaFor(prop: MikroProp, metas: Map<string, MikroMeta>): { through: string; own: string; other: string } | undefined {
  const pivotName = pivotClassName(prop, metas);
  const pivot = pivotName ? metas.get(pivotName) : undefined;
  if (!pivot) {
    return undefined;
  }
  // A pivot's own relations are two `m:1`s. The one whose target is this
  // relationship's target is the "other" key; the remaining one points home.
  const relations = pivot.props.filter((p) => p.kind === Kind.ManyToOne);
  const targetName = prop.targetMeta?.className;
  const other = relations.find((p) => p.targetMeta?.className === targetName);
  const own = relations.find((p) => p !== other);
  if (!own || !other) {
    return undefined;
  }
  return {
    through: pivot.className,
    own: foreignKeyFieldName(own.name, referencedKeyOf(own)),
    other: foreignKeyFieldName(other.name, referencedKeyOf(other)),
  };
}

/** Resolve a `m:n` property's pivot entity to the class name discovery registered it under. */
function pivotClassName(prop: MikroProp, metas: Map<string, MikroMeta>): string | undefined {
  const entity = prop.pivotEntity as { name?: string } | string | undefined;
  if (typeof entity === "string" && metas.has(entity)) {
    return entity;
  }
  if (entity && typeof entity !== "string" && entity.name && metas.has(entity.name)) {
    return entity.name;
  }
  // Fall back to the table name: `pivotEntity` is only a class when the author
  // declared the pivot themselves, and an auto-generated one is reachable only
  // through the table it was created for.
  for (const meta of metas.values()) {
    if (meta.tableName === prop.pivotTable) {
      return meta.className;
    }
  }
  return undefined;
}

/**
 * Every entity of a MikroORM instance, as ormize definitions.
 *
 * Three kinds are skipped. Embeddables and abstract bases are not queryable
 * models, and an embeddable's columns are already flattened onto the entity that
 * holds it. So is the pivot MikroORM generates for a `m:n` that was not given an
 * entity of its own: it has a composite primary key and no identity beyond the
 * pair it joins, and nothing needs it — the relationship is walked through
 * MikroORM's own `Collection`, and the join is an implementation detail of that.
 *
 * A pivot the author *did* declare as an entity is an ordinary model here and is
 * discovered like any other, which is what gives its extra columns somewhere to
 * live (see `rows.addThroughRows`) and types both of its foreign keys by what
 * they point at (#65).
 */
export function discoverEntities(
  mikro: MikroORMInstance, options: MikroAdapterOptions = {},
): DiscoveredEntity[] {
  const all = mikro.getMetadata().getAll() as Map<unknown, MikroMeta>;
  const metas = new Map<string, MikroMeta>();
  for (const meta of all.values()) {
    if (!meta?.className || meta.embeddable || meta.abstract || meta.pivotTable) {
      continue;
    }
    // `getAll()` is keyed by entity name *and* by class for the same metadata, so
    // the same entity can arrive twice.
    metas.set(meta.className, meta);
  }
  const wanted = options.entities ? new Set(options.entities) : undefined;
  const out: DiscoveredEntity[] = [];
  for (const meta of metas.values()) {
    if (wanted && !wanted.has(meta.className)) {
      continue;
    }
    const discovered = discoverEntity(meta, metas);
    discovered.definition = copyDefinition(
      mergeDefinition(discovered.definition, options.definitions?.[meta.className]),
    );
    out.push(discovered);
  }
  return out;
}

/**
 * Whether an author-declared entity is really a join table: a model whose every
 * column is either a primary key or a foreign key, and which owns at least two
 * of the latter. Reported so a caller can tell a join apart from a model; the
 * adapter itself treats it like any other.
 */
function isPivotLike(meta: MikroMeta): boolean {
  const relations = meta.props.filter((p) => p.kind === Kind.ManyToOne);
  if (relations.length < 2) {
    return false;
  }
  return meta.props.every((p) => p.primary || p.kind === Kind.ManyToOne || p.embedded);
}

/** Whether a discovered field type is an enum — used by the GraphQL layer. */
export function isEnumField(field: DefinitionFieldMeta): boolean {
  return (field.type as DataTypeDescriptor | undefined)?.type === DataType.Enum;
}
