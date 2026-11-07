// Relationship wiring: validating, processing, and building the join models
// that a cross-adapter `belongsToMany` needs.
//
// Extracted from the `Ormize` class. The relationship-mutation *verbs* live in
// `../relationship-mutations.ts` (unchanged); this module is about the wiring
// that makes those verbs possible.

import pluralize from "pluralize";
import { relationshipAccessors } from "@azerothian/utilize/utils/relationship-accessors";
import { lowercase, capitalize } from "@azerothian/utilize/utils/word";
import { relationshipForeignKey, throughModelName, throughOtherKey, reciprocalOtherKey } from "@azerothian/utilize/utils/join-keys";
import type { OrmAdapter, AdapterQueryOptions, Association } from "@azerothian/utilize/types/index";
import { DataTypes } from "@azerothian/utilize/types/data-type";
import type { DataTypeDescriptor } from "@azerothian/utilize/types/index";
import type { Definition, Relationship } from "../types";
import { addProxyAccessor, btmGetter, createProxyFunction, writeAccessors } from "../cross-adapter";
import { requestFrom } from "../cross-adapter";
import type { WiredRelationship } from "./constants";
import { relationshipTypes, SINGULAR_ACCESSOR } from "./constants";
import type { ScopeHost } from "./scope-bridge";
import { scopeNativeWhere } from "./scope-bridge";

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

/** The narrow slice of the `Ormize` class these functions need. */
export interface RelationshipHost extends ScopeHost {
  defsAdapters: { [name: string]: string };
  relationships: { [defName: string]: { [relName: string]: WiredRelationship } };
  _joinModels: { [name: string]: { source: string; target: string; foreignKey: string; otherKey: string; sourceKey: string; targetKey: string } };
  defaultAdapter: string | undefined;
  addDefinition(def: Definition, adapterName?: string): Promise<void>;
  getFields(defName: string): Record<string, { type?: unknown; foreignKey?: boolean; primaryKey?: boolean; writable?: boolean | undefined; index?: boolean; allowNull?: boolean }>;
  requireDefinition(defName: string, subject: string): Definition;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Everything about `rel` that can be judged before any of it is wired: that it
 * has a name and a known type, that its target exists, and - for a
 * cross-adapter relationship, whose keys nobody can synthesize - that the
 * columns it names are really there.
 *
 * Up front and covering both branches on purpose. The type guard used to sit
 * below the same-adapter early return (so it only ever ran for cross-adapter
 * relationships, leaving the same-adapter case to whichever adapter happened to
 * validate), a missing `rel.name` was silently stored under the key
 * `"undefined"`, and a missing target crashed inside `getPrimaryKeyNameForModel`
 * after the relationship had already been recorded. See #14.
 */
export function validateRelationship(self: RelationshipHost, defName: string, rel: Relationship) {
  const subject = `Relationship '${defName}.${rel.name}'`;
  if (!rel.name) {
    throw new Error(`Relationship on '${defName}' targeting '${rel.model}' has no name.`);
  }
  if (!relationshipTypes.includes(rel.type)) {
    throw new Error(`${subject}: unknown relationship type '${rel.type}'. Expected one of ${relationshipTypes.map((t) => `'${t}'`).join(", ")}.`);
  }
  if (!rel.model) {
    throw new Error(`${subject} (${rel.type}) does not name a target model.`);
  }
  self.requireDefinition(rel.model, `${subject} (${rel.type}) targets model '${rel.model}', which has not been defined`);
}

/**
 * The keys of every cross-adapter relationship, checked against the models they
 * sit on. No JOIN spans two datastores, so ormize resolves the pair itself by
 * reading these columns - and unlike a native association it cannot create the
 * foreign key, which has to be declared on the target definition by hand. An
 * unchecked name wired cleanly and then failed at the first query as a raw
 * driver error (`no such column: Bar.nopeId`) naming neither the relationship
 * nor the option that produced it. See #14.
 *
 * A pass at the end of `initialise()` rather than a check inside
 * `processRelationship`, because a column is not necessarily there yet when the
 * relationship naming it is wired: relationships are processed concurrently,
 * and a same-adapter association on the target creates its foreign key as a
 * side effect. Only once every relationship is wired - and every generated join
 * model defined - does `getFields` answer for the finished schema.
 */
export function validateCrossAdapterKeys(self: RelationshipHost) {
  for (const defName of Object.keys(self.relationships)) {
    for (const relName of Object.keys(self.relationships[defName])) {
      const rel = self.relationships[defName][relName];
      if (rel.internal !== false) {
        continue;
      }
      const subject = `Cross-adapter relationship '${defName}.${relName}' (${rel.type})`;
      // `belongsTo` keeps the foreign key on the source and points at the
      // target's `targetKey`; `hasMany`/`hasOne` keep it on each target and
      // point back at the source's `sourceKey`. `belongsToMany` keeps it on
      // neither - both join columns live on the through model.
      const checks: [string, string | undefined, string][] = rel.type === "belongsToMany"
        ? [
          [defName, rel.sourceKey, "sourceKey"],
          [rel.model, rel.targetKey, "targetKey"],
          [rel.through as string, rel.foreignKey, "foreignKey (on the join model)"],
          [rel.through as string, rel.otherKey, "otherKey (on the join model)"],
        ]
        : rel.type === "belongsTo"
          ? [[defName, rel.foreignKey, "foreignKey"], [rel.model, rel.targetKey, "targetKey"]]
          : [[defName, rel.sourceKey, "sourceKey"], [rel.model, rel.foreignKey, "foreignKey"]];
      for (const [modelName, keyName, option] of checks) {
        if (!keyName) {
          continue;
        }
        const fields = self.getModelAdapter(modelName).getFields(modelName);
        if (fields[keyName]) {
          continue;
        }
        throw new Error(`${subject} declares ${option} '${keyName}', but model '${modelName}' has no such field. `
          + "A cross-adapter key must be declared on the definition - ormize cannot create it. "
          + `Fields on '${modelName}': ${Object.keys(fields).map((f) => `'${f}'`).join(", ")}.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Build an {@link Association} descriptor for an ormize-wired cross-adapter relationship. */
export function buildCrossAdapterAssociation(defName: string, rel: WiredRelationship): Association {
  return {
    name: rel.name,
    target: rel.model,
    source: defName,
    // Only a cross-adapter relationship is described this way, and wiring one
    // resolves every join key and the accessor name before it gets here.
    foreignKey: rel.foreignKey as string,
    sourceKey: rel.sourceKey as string,
    targetKey: rel.targetKey as string,
    associationType: rel.type,
    crossAdapter: true,
    through: rel.through,
    otherKey: rel.otherKey,
    accessors: relationshipAccessors(rel.name, rel.funcName),
  };
}

export async function processRelationship(self: RelationshipHost, def: Definition, sourceAdapter: OrmAdapter, rel: Relationship) {
  if(!def.name) {
    throw new Error(`Attempting to use a definition without a name: ${JSON.stringify(def)}`);
  }
  validateRelationship(self, def.name, rel);
  // Normalised once: the cross-adapter branch used to destructure `rel.options`
  // blind, and an omitted `options` is a legitimate shape for a same-adapter
  // relationship that leaves every key to the adapter.
  rel = rel.options ? rel : {...rel, options: {}};
  const targetAdapter = self.getModelAdapter(rel.model);
  if (!self.relationships[def.name]) {
    self.relationships[def.name] = {};
  }
  if (self.relationships[def.name][rel.name]) {
    throw new Error(`Unable to continue duplicate relationships: ${def.name} - ${rel.name}`);
  }
  self.relationships[def.name][rel.name] = {
    targetAdapter,
    sourceAdapter,
    type: rel.type,
    model: rel.model,
    name: rel.name,
    options: rel.options,
  };
  const foreignKey = relationshipForeignKey(rel.type, rel.options);
  if (targetAdapter === sourceAdapter) {
    self.relationships[def.name][rel.name].internal = true;
    //TODO: populate foreignKey/sourceKeys if not provided
    await sourceAdapter.createRelationship(def.name, rel.model, rel.name, rel.type, rel.options);
    return undefined;

  }
  self.relationships[def.name][rel.name].internal = false;
  const modelClass = sourceAdapter.getModel(def.name);
  const sourcePrimaryKeyName = sourceAdapter.getPrimaryKeyNameForModel(def.name)[0]; //TODO: check for edge case with multi primary key table
  // Singular for the -one variants, plural for the -many. `validateRelationship`
  // above has already rejected any other type, so there is no fallback arm to
  // write — the `default:` that used to be here was unreachable.
  const base = `get${capitalize(rel.model)}`;
  const funcName = SINGULAR_ACCESSOR.has(rel.type)
    ? pluralize.singular(base)
    : pluralize.plural(base);
  self.relationships[def.name][rel.name].funcName = funcName;
  if (!foreignKey) {
    throw new Error(`For cross adapter relationships you must define a foreign key ${def.name} (${rel.type}) ${rel.model}: ${rel.name}`);
  }
  const sourceKey = rel.options?.sourceKey || sourcePrimaryKeyName;
  // `targetKey` is the column on the target that a belongsTo points at; it
  // defaults to the target's primary key.
  const targetKey = rel.options?.targetKey || targetAdapter.getPrimaryKeyNameForModel(rel.model)[0];
  Object.assign(self.relationships[def.name][rel.name], {foreignKey, sourceKey, targetKey});
  if (rel.type === "belongsToMany") {
    Object.assign(self.relationships[def.name][rel.name], resolveCrossAdapterJoin(self, def.name, rel, {foreignKey, sourceKey, targetKey}));
  }
  const association = buildCrossAdapterAssociation(def.name, self.relationships[def.name][rel.name]);
  if (rel.type === "belongsToMany") {
    // The pair is resolved from the join model rather than from a key on either
    // record, so there is no single find to proxy — see {@link btmGetter}.
    addProxyAccessor(sourceAdapter, def.name, modelClass, funcName, btmGetter(self.host, association));
  } else {
    // `createFunctionForFind` is synchronous — it returns the find function
    // itself, not a promise of one.
    const findFunc = targetAdapter.createFunctionForFind(rel.model);
    // Captured out of the closure: the `!def.name` guard at the top of this
    // method narrows the property, but that narrowing does not survive into a
    // callback.
    const defName = def.name;
    const adaptOptions = (options: AdapterQueryOptions | undefined) => self.host.optionsForAdapter(defName, rel.model, options);
    // F5. The proxy runs the target's find directly, so the target's read scope
    // has to travel with it — the accessor is an ordinary instance method and
    // anything holding a source row can call it.
    const scopedWhere = (options: AdapterQueryOptions | undefined) =>
      scopeNativeWhere(self, rel.model, "read", requestFrom(options), options?.where, options);
    // The proxy reads its join value off `this`, which is a *source* instance —
    // so the read goes through the source adapter, not the target's. `belongsTo`
    // keeps the key on the source and points at the target's `targetKey`; the
    // other two keep it on each target and point back at the source's `sourceKey`,
    // differing only in whether one row or many come back.
    const proxy = rel.type === "belongsTo"
      ? createProxyFunction(sourceAdapter, foreignKey, targetKey, true, findFunc, adaptOptions, scopedWhere)
      : createProxyFunction(sourceAdapter, sourceKey, foreignKey, rel.type === "hasOne", findFunc, adaptOptions, scopedWhere);
    addProxyAccessor(sourceAdapter, def.name, modelClass, funcName, proxy);
  }
  for (const [accessor, func] of Object.entries(writeAccessors(self.host, association, sourceAdapter, targetAdapter))) {
    addProxyAccessor(sourceAdapter, def.name, modelClass, accessor, func);
  }
  return undefined;
}

/**
 * Resolve the join model of a cross-adapter `belongsToMany` and the column on it
 * that points at the target (`foreignKey` points at the source).
 *
 * The join has to physically live in exactly one datastore. An unnamed one is
 * named after the pair — sorted, so both sides of a reciprocal pair agree on it
 * regardless of which is wired first — and one that is not a registered model
 * gets generated (see {@link generateJoinModels}). A generated join model is
 * queued rather than created here: relationships are wired concurrently, so
 * both sides would otherwise race to define it.
 */
function resolveCrossAdapterJoin(self: RelationshipHost, defName: string, rel: Relationship, keys: {foreignKey: string, sourceKey: string, targetKey: string}) {
  const {through} = rel.options || {};
  const throughName = throughModelName(through)
    || [defName, rel.model].sort().join("");
  const otherKey = rel.options?.otherKey
    || throughOtherKey(through)
    || reciprocalOtherKey(self.defs[rel.model]?.relationships, throughName)
    || `${lowercase(rel.model)}Id`;
  if (!self.defs[throughName] && !self._joinModels[throughName]) {
    self._joinModels[throughName] = {source: defName, target: rel.model, otherKey, ...keys};
  }
  return {through: throughName, otherKey};
}

/**
 * Define the join models a cross-adapter `belongsToMany` needed and the caller
 * did not register, on the first registered adapter.
 *
 * Run in one pass after every relationship is wired: the column types are read
 * off the keys they point at, and an adapter only knows a model's full field
 * list (foreign keys included) once its relationships have been created.
 */
export async function generateJoinModels(self: RelationshipHost) {
  const adapterName = self.defaultAdapter || Object.keys(self.adapters)[0];
  for (const name of Object.keys(self._joinModels)) {
    const join = self._joinModels[name];
    delete self._joinModels[name];
    if (self.defs[name]) {
      continue;
    }
    await self.addDefinition({
      name,
      // No primary key is declared: each adapter synthesizes its own (an
      // auto-increment `id` on both of the shipped ones). Both join columns are
      // indexed — a key-value adapter can only answer a `where` from an index.
      define: {
        [join.foreignKey]: {type: keyType(self, join.source, join.sourceKey), allowNull: true, index: true, writable: true},
        [join.otherKey]: {type: keyType(self, join.target, join.targetKey), allowNull: true, index: true, writable: true},
      },
      // `paranoid: false` explicitly, not by omission: an adapter-level
      // default (Sequelize's `defaultModel`) would otherwise reach this
      // generated table, and `{paranoid: true, timestamps: false}` is a
      // combination Sequelize accepts and then silently ignores — leaving a
      // model that claims to soft delete and does not.
      options: {timestamps: false, paranoid: false},
      relationships: [],
    }, adapterName);
  }
}

/** The abstract type of a model's key column, for a generated join model to mirror. */
function keyType(self: RelationshipHost, defName: string, keyName: string): DataTypeDescriptor {
  const adapter = self.getModelAdapter(defName);
  const field = adapter.getFields(defName)[keyName];
  return field?.type ? adapter.mapDataType(field.type) : DataTypes.String;
}
