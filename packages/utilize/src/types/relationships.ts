/**
 * Relationship declarations and the live association metadata the adapter
 * produces from them.
 */

export type Association = {
  name: string;
  target: string;
  source: string;
  foreignKey: string;
  targetKey: string;
  sourceKey: string;
  associationType: string;
  /**
   * True when source and target live on different adapters. Such a relationship
   * has no native association behind it: it cannot be eager-loaded (no JOIN spans
   * two datastores) and is resolved as a separate query on the target, scoped to
   * the join key.
   */
  crossAdapter?: boolean;
  /**
   * `belongsToMany` only: the join model, and the column on it that points at the
   * target (`foreignKey` points at the source). A cross-adapter `belongsToMany`
   * resolves through this model, so it must be a registered model in its own
   * right rather than an implicit table.
   */
  through?: string;
  otherKey?: string;
  /**
   * `belongsToMany` only: true when `through` names a model the author
   * registered (not one an adapter or ormize made implicitly). Only then does
   * the relationship carry join-row data: `add`/`set` entries take
   * `{ where, through }`. Otherwise it behaves as a plain many-to-many and
   * entries are bare filters. Set by `Ormize.getAssociations`, which both the
   * schema builders and the relationship verbs read, so the two agree.
   */
  throughModel?: boolean;
  accessors: {
    add: string;
    set: string;
    get: string;
    removeMultiple: string;
    addMultiple: string;
    count: string;
    create: string;
    hasAll: string;
    hasSingle: string;
    remove: string;
  }
}

export enum RelationshipType {
  BelongsTo = "belongsTo",
  HasOne = "hasOne",
  HasMany = "hasMany",
  BelongsToMany = "belongsToMany"
}

export type Relationship = {
  model: string;
  name: string;
  type: string | RelationshipType;
  target?: string;
  rel?: Association;
  options: {
    as?: string;
    foreignKey?: string;
    sourceKey?: string;
    /** Column on the target a `belongsTo` points at. Defaults to the target's primary key. */
    targetKey?: string;
    constraints?: boolean;
    /** Column on the join model a `belongsToMany` uses to reach the target. */
    otherKey?: string;
    through?: {
      model?: string;
      foreignKey?: string;
      otherKey?: string;
    } | string;
  };
}
