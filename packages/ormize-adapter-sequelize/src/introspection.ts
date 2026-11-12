// Field and association introspection: reading the columns and relationships a
// model carries back from Sequelize's internal structures into the shapes the
// rest of ormize consumes. The adapter class in `index.ts` delegates here.

import type {
  ModelAttributeColumnReferencesOptions,
  Sequelize,
} from "sequelize";
import type {
  Association,
  DefinitionFieldMeta,
} from "@azerothian/utilize/types/index";
import { lowercase } from "@azerothian/utilize/utils/word";
import type { OrmizeColumnOptions, NativeAssociationInternals } from "./adapter-types";
import type { SequelizeModelClass } from "./types/query";

function safeStringify(value: unknown) {
  const seen = new Set<unknown>();
  return JSON.stringify(
    value,
    (k, v) => {
      if (seen.has(v) || k === "sequelize") {
        return "...";
      }
      if (typeof v === "object") {
        seen.add(v);
      }
      return v;
    },
    2
  );
}

/**
 * What the introspection functions reach into.
 */
export interface IntrospectionHost {
  readonly sequelize: Sequelize;
  getMetaObj<T>(modelName: string, metaName: string): T;
  setMetaObj(modelName: string, metaName: string, value: unknown): void;
}

/**
 * The model owning the table an attribute's `references` names, or undefined.
 *
 * `references.model` is a *table* name (or a `{tableName, schema}` pair), which
 * is not the model name the id codec types keys with — sequelize pluralises by
 * default, and `options.tableName` may be anything. Matching on
 * `getTableName()` is the only mapping back that holds for both.
 */
export function modelNameForTable(
  sequelize: Sequelize,
  references: string | ModelAttributeColumnReferencesOptions | undefined,
): string | undefined {
  // `references` admits a bare table name, and `references.model` a name, a
  // model class or a `{tableName, schema}` pair.
  const model = typeof references === "string" ? references : references?.model;
  const table = typeof model === "string"
    ? model
    : (model as {tableName?: string} | undefined)?.tableName;
  if (!table) {
    return undefined;
  }
  // `getTableName()` answers with a `{tableName, schema, delimiter}` triple on a
  // schema-qualified model and a bare string otherwise.
  return Object.keys(sequelize.models).find((name) => {
    const qualified = sequelize.models[name].getTableName();
    return (typeof qualified === "string" ? qualified : qualified.tableName) === table;
  });
}

/**
 * Build the field metadata for a model, caching the result under `"fields"`.
 */
export function getFieldsImpl(
  host: IntrospectionHost,
  modelName: string,
): { [fieldName: string]: DefinitionFieldMeta } {
  const Model = host.sequelize.models[modelName];
  //TODO add filter for excluding or including fields
  if (!host.getMetaObj(modelName, "fields")) {
    const fieldNames = Object.keys(Model.rawAttributes);
    const fields = fieldNames.reduce((fields, key) => {
      const attr = Model.rawAttributes[key] as OrmizeColumnOptions;
      // `_dataTypeChanges` is a Sequelize internal (a column whose declared
      // type the dialect had to rewrite), so it is absent from the public
      // typings; a missing one simply means no column was rewritten.
      const dataTypeChanges = (Model as unknown as {
        _dataTypeChanges?: { [fieldName: string]: unknown };
      })._dataTypeChanges;
      const autoPopulated =
        attr.autoIncrement === true ||
        attr.defaultValue !== undefined ||
        !!dataTypeChanges?.[key];
      const allowNull = attr.allowNull === true;
      const foreignKey = !!attr.references;
      let foreignTarget;
      if (foreignKey) {
        foreignTarget = Object.keys(Model.associations)
          .filter((assocKey) => {
            const assoc = Model.associations[assocKey] as NativeAssociationInternals;
            return assoc.identifier === key || assoc.identifierField === key;
          })
          .map((assocKey) => {
            return Model.associations[assocKey].target.name;
          })[0];
        // A `belongsToMany` through model that was not given its own
        // `belongsTo` relationships has an empty `associations` map: sequelize
        // builds the join model's two `BelongsTo`s with `new BelongsTo(...)`,
        // which never registers them on the through model. The attribute still
        // carries the table it references, so name the model that owns that
        // table rather than failing to type the key at all (#65).
        if (!foreignTarget) {
          foreignTarget = modelNameForTable(host.sequelize, attr.references);
        }
        if (!foreignTarget) {
          //TODO: better error logging
          let message = `An error has occurred with relationships on model - ${modelName} - ${key}`;
          if (process.env.NODE_ENV !== "production") {
            const jsonAssociations = safeStringify(Model.associations);
            const jsonRelationships = safeStringify(
              (Model as SequelizeModelClass).relationships
            );
            message = `Model: ${modelName} - Unable to find ${key} identifier field association in the model associations \n ---Associations--- ${jsonAssociations}\n ---Relationships--- ${jsonRelationships}`;
          }
          throw new Error(message);
        }
      }

      fields[key] = {
        name: key,
        type: attr.type,
        primaryKey: attr.primaryKey === true,
        allowNull,
        // `comment` is the Sequelize spelling and the one that reaches the
        // database; `description` is what `DefinitionField` documents, so it
        // is honoured too and wins. Same precedence as the valkey adapter.
        description: attr.description ?? attr.comment,
        deprecated: attr.deprecated,
        defaultValue: attr.defaultValue,
        foreignKey,
        foreignTarget,
        autoPopulated,
        ignoreGlobalKey: attr.ignoreGlobalKey,
        // Opt-in that lets a pk/fk be set from client input (default: excluded
        // to prevent mass-assignment — see isStructurallyWritable). Left
        // undefined when unauthored, so an explicit `false` can still opt a
        // column out of `writableForeignKeys`.
        writable: typeof attr.writable === "boolean" ? attr.writable : undefined,
        // `args`/`resolve` are authored on the field and are meaningless to
        // Sequelize, which carries unknown attribute keys through `define`
        // onto `rawAttributes` untouched (the same escape hatch the two flags
        // above ride on). Read back explicitly rather than spreading
        // `rawAttributes`: Sequelize also hangs a circular `Model`
        // back-reference, internals like `_modelAttribute`, and a `unique`
        // normalised to a shape `DefinitionFieldMeta.unique` does not
        // describe — and `getFields` memoises, so all of it would be retained
        // per field forever. See `passes authored args/resolve through` in
        // `__tests__/define-model.test.ts` for the canary on the passthrough.
        args: attr.args,
        resolve: attr.resolve,
      };
      return fields;
    }, {} as { [key: string]: DefinitionFieldMeta });
    host.setMetaObj(modelName, "fields", fields);
  }
  return host.getMetaObj(modelName, "fields");
}

/**
 * Build the association metadata for a model, caching the result under
 * `"associations"`.
 */
export function getAssociationsImpl(
  host: IntrospectionHost,
  modelName: string,
): { [relName: string]: Association } {
  const Model = host.sequelize.models[modelName];
  let associations: { [relName: string]: Association } = host.getMetaObj(modelName, "associations");
  if (associations) {
    return associations;
  }
  associations = Object.keys(Model.associations).reduce(
    (rels, key) => {
      const assoc = Model.associations[key] as NativeAssociationInternals;
      const { associationType } = assoc;
      rels[key] = {
        name: key,
        target: assoc.target.name,
        source: assoc.source.name,
        associationType: lowercase(associationType),
        foreignKey: assoc.foreignKey,
        // Sequelize defines these only on the association kinds that have one:
        // a `hasMany` carries a source key, a `belongsTo` a target key. An
        // {@link Association} reports *resolved* keys, so an absent one falls
        // back to the primary key of the model it names — which is exactly what
        // Sequelize itself defaults to when the author omits it.
        targetKey: assoc.targetKey || assoc.target.primaryKeyAttribute,
        sourceKey: assoc.sourceKey || assoc.source.primaryKeyAttribute,
        accessors: assoc.accessors,
      };
      // A `belongsToMany` reports its join model and the column on it that
      // points at the target, as the other adapters do. ormize reads `through`
      // to decide whether the relationship carries join-row data.
      if (rels[key].associationType === "belongsToMany" && assoc.through?.model) {
        rels[key].through = assoc.through.model.name;
        rels[key].otherKey = assoc.otherKey;
      }
      return rels;
    },
    {} as { [relName: string]: Association }
  );
  host.setMetaObj(modelName, "associations", associations);
  return associations;
}
