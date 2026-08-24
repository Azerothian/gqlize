import { DataTypeDescriptor, DataTypes } from "@azerothian/utilize/types/data-type";
import type { Definition, Relationship } from "@azerothian/utilize/types/index";
import { resolveAttributeTypes } from "./data-type-mapper";

/**
 * A relationship as this adapter carries it: the definition's own
 * {@link Relationship}, plus the join descriptor `createRelationship` stamps on
 * a `belongsToMany` once it has resolved the join model and both of its keys.
 */
export type ValkeyRelationship = Relationship & {
  __join?: { through: string; fkA: string; fkB: string };
};

/**
 * Sequelize-style `options.indexes`, the one adapter-native model option this
 * package reads. {@link DefinitionOptions} carries unnamed options as `unknown`
 * by design — the set belongs to the backend — so the shape is named and
 * narrowed here, at the single place it is read.
 */
type IndexOption = { fields?: string[]; unique?: boolean };

export interface FieldMeta {
  name: string;
  type: DataTypeDescriptor;
  primaryKey?: boolean;
  foreignKey?: boolean;
  foreignTarget?: string;
  unique?: boolean;
  index?: boolean;
  allowNull?: boolean;
  autoPopulated?: boolean;
  writable?: boolean;
  defaultValue?: any;
  ignoreGlobalKey?: boolean;
}

/**
 * Lightweight in-memory model built from an ormize `Definition`. Holds field
 * metadata, the primary key, and the set of indexed / unique fields the adapter
 * maintains secondary structures for. Relationship wiring augments it later
 * (foreign-key fields become indexed so relationship reads are index-driven).
 */
export class ValkeyModel {
  name: string;
  definition: Definition;
  fields: { [k: string]: FieldMeta } = {};
  primaryKey!: string;
  pkStrategy: "uuid" | "sequence" | "provided" = "provided";
  indexes = new Set<string>();
  uniques = new Set<string>();
  relationships: ValkeyRelationship[];
  defaultTtl?: number;

  constructor(def: Definition) {
    // Every key this adapter writes is built from the model name, so an unnamed
    // definition has no keyspace to live in. Ormize guards the same thing before
    // it gets here; this covers a caller driving the adapter directly.
    if (!def.name) throw new Error("ValkeyModel: a definition must have a name");
    this.name = def.name;
    this.definition = def;
    this.relationships = def.relationships || [];
    // A model-level `ttl` is one of those adapter-native options, so it arrives
    // as `unknown` and is checked rather than assumed.
    const ttl = def.options?.ttl;
    this.defaultTtl = typeof ttl === "number" ? ttl : undefined;

    const resolved = resolveAttributeTypes(def.define || {});
    for (const key of Object.keys(resolved)) {
      const src = (def.define || {})[key] || {};
      this.fields[key] = {
        name: key,
        type: resolved[key].type,
        primaryKey: src.primaryKey === true,
        unique: src.unique === true,
        index: src.index === true,
        writable: src.writable === true,
        // Primary keys are never null (the GraphQL Node interface requires ID!).
        allowNull: src.primaryKey === true ? false : src.allowNull !== false,
        defaultValue: src.defaultValue,
        ignoreGlobalKey: src.ignoreGlobalKey,
      };
    }

    // Resolve / synthesize the primary key.
    const pk = Object.keys(this.fields).find((k) => this.fields[k].primaryKey);
    if (pk) {
      this.primaryKey = pk;
      const f = this.fields[pk];
      this.pkStrategy = f.defaultValue !== undefined || f.type.type === "UUID" ? "uuid" : "provided";
      if (f.defaultValue !== undefined && f.type.type === "UUID") {
        this.pkStrategy = "uuid";
      }
    } else {
      // No pk declared → synthesize an auto-increment integer `id`.
      this.primaryKey = "id";
      this.pkStrategy = "sequence";
      this.fields.id = { name: "id", type: DataTypes.Int, primaryKey: true, allowNull: false, autoPopulated: true };
    }

    // Field-level unique / index flags.
    for (const key of Object.keys(this.fields)) {
      const f = this.fields[key];
      if (f.unique) {
        this.uniques.add(key);
        this.indexes.add(key);
      }
      if (f.index) {
        this.indexes.add(key);
      }
    }

    // Sequelize-style single-field `options.indexes: [{ fields: [f], unique? }]`.
    for (const idx of (def.options?.indexes || []) as IndexOption[]) {
      const flds: string[] = idx.fields || [];
      if (flds.length === 1) {
        const f = flds[0];
        this.indexes.add(f);
        if (idx.unique) {
          this.uniques.add(f);
          if (this.fields[f]) this.fields[f].unique = true;
        }
        if (this.fields[f]) this.fields[f].index = true;
      }
      // Composite indexes are not supported in v1 (single-field only).
    }
  }

  /** Ensure a field exists (used to register relationship foreign keys). */
  ensureField(name: string, meta: Partial<FieldMeta>): void {
    if (!this.fields[name]) {
      this.fields[name] = { name, type: DataTypes.Unknown, allowNull: true, ...meta };
    } else {
      Object.assign(this.fields[name], meta);
    }
  }

  /** Mark a field as (equality) indexed. */
  addIndex(name: string): void {
    this.indexes.add(name);
    if (this.fields[name]) this.fields[name].index = true;
  }

  /** True when the field can seed an index-only query (indexed, unique, or pk). */
  isSearchable(name: string): boolean {
    return name === this.primaryKey || this.indexes.has(name) || this.uniques.has(name);
  }
}
