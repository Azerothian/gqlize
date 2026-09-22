// The model handle stored in `ormize.models.*` for a MikroORM entity.
//
// MikroORM is a Data Mapper: an entity class has no statics to query through and
// an entity instance has no `save()`. The rest of the stack — and anyone reaching
// for `db.models.User.findAll(...)` — expects the active-record-shaped surface
// the other two adapters present, so this is where that shape is put on.

import type {
  Definition, DefinitionFieldMeta, Relationship,
} from "@azerothian/utilize/types/index";
import type { DiscoveredEntity, MikroMeta } from "./discover";

/**
 * A field as this adapter reports it: a {@link DefinitionFieldMeta} whose `type`
 * has already been resolved to an abstract descriptor by discovery, rather than
 * left as whatever the author wrote.
 */
export type MikroFieldMeta = DefinitionFieldMeta & { name: string };

/**
 * The statics this adapter installs on a model so `db.models.X.create(...)`
 * works the way it does on the other backends.
 *
 * Each is a thin wrapper over the adapter method of the same name; they exist so
 * the model handle is usable on its own, without the caller holding the adapter.
 */
export interface MikroModelStatics<TEntity extends object = object> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches AdapterCreateFunction's own permissive input bag; a MikroORM `RequiredEntityData<T>` cannot be expressed here, where the entity is known only by name
  create(values: { [field: string]: any }, options?: { [option: string]: unknown }): Promise<TEntity>;
  findAll(options?: { [option: string]: unknown }): Promise<TEntity[]>;
  findOne(options?: { [option: string]: unknown }): Promise<TEntity | null>;
  findByPk(id: unknown, options?: { [option: string]: unknown }): Promise<TEntity | null>;
  count(options?: { [option: string]: unknown }): Promise<number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches AdapterUpdateFunction's own permissive patch bag
  update(values: { [field: string]: any }, options?: { [option: string]: unknown }): Promise<TEntity[]>;
  destroy(options?: { [option: string]: unknown }): Promise<TEntity[]>;
}

/**
 * A registered MikroORM entity.
 *
 * Generic in the entity so `ormize.models.User` can be typed as
 * `MikroModel<User>` — see `./types/orm` for how that reaches `registerAdapter`.
 */
export class MikroModel<TEntity extends object = object> {
  /** The registered name, which is the entity's class name. */
  name: string;
  /** The definition discovery derived, with the author's overrides merged in. */
  definition: Definition;
  /** MikroORM's own metadata for this entity. */
  meta: MikroMeta;
  /**
   * The entity constructor, which is what `em.find`/`em.create` take by
   * reference. Falls back to the class name for a metadata entry that carries no
   * constructor (an `EntitySchema` declared without one).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the user's own class: this adapter never constructs it, and constraining the parameters would reject a perfectly ordinary entity with a required constructor argument
  entity: (new (...args: any[]) => TEntity) | string;
  fields: { [fieldName: string]: MikroFieldMeta } = {};
  primaryKey: string;
  /** See {@link DiscoveredEntity.aliases}. */
  aliases: { [fieldName: string]: string };
  relationships: Relationship[];
  /** See {@link DiscoveredEntity.inverseProperties}. */
  inverseProperties: { [relName: string]: string };
  /** True for a MikroORM auto-generated many-to-many pivot entity. */
  pivot: boolean;
  /**
   * The soft-delete column, when the definition opted in. MikroORM has no soft
   * delete of its own — see `./soft-delete`.
   */
  softDeleteColumn?: string;
  /** Instance methods the definition declared, installed on the entity prototype. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches OrmAdapter.addInstanceFunction's own permissive fn type: no single call shape fits every instance method a caller might install
  instanceMethods: { [name: string]: (...args: any[]) => any } = {};

  /**
   * The rest of the contract's `Model` is an open bag — class methods, the
   * statics below — and this is where those land. Declared explicitly rather than
   * left to a structural cast so `model.findAll(...)` is typed at every call site
   * inside the package.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the open half of the ormize `Model` contract: user-declared class methods, whose signatures are the user's
  [dynamic: string]: any;

  constructor(discovered: DiscoveredEntity, definition: Definition) {
    this.name = discovered.name;
    this.definition = definition;
    this.meta = discovered.meta;
    this.entity = discovered.meta.class || discovered.name;
    this.primaryKey = discovered.primaryKey;
    this.aliases = { ...discovered.aliases };
    this.relationships = definition.relationships || [];
    this.inverseProperties = { ...discovered.inverseProperties };
    this.pivot = discovered.pivot;
    for (const [name, field] of Object.entries(definition.define || {})) {
      this.fields[name] = { ...(field as DefinitionFieldMeta), name };
    }
  }

  /**
   * The MikroORM property a field name stands for.
   *
   * The identity for an ordinary column; for a synthesized foreign key it is the
   * relation property that actually holds the value. Every `where`, `orderBy`,
   * `fields` list and mutation input goes through here on the way down.
   */
  resolve(fieldName: string): string {
    return this.aliases[fieldName] || fieldName;
  }

  /** Whether `fieldName` is a synthesized foreign key rather than a real column. */
  isAlias(fieldName: string): boolean {
    return this.aliases[fieldName] !== undefined;
  }
}

/** A model with its statics installed — what `createModel` hands back. */
export type RegisteredMikroModel<TEntity extends object = object> =
  MikroModel<TEntity> & MikroModelStatics<TEntity>;
