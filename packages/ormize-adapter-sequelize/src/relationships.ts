// Relationship wiring: creating Sequelize associations from ormize
// relationship definitions. Extracted from `index.ts` to keep relationship
// setup separate from the adapter class.

import type { Sequelize } from "sequelize";
import logger from "@azerothian/utilize/utils/logger";
import { throughForeignKey, throughOtherKey } from "@azerothian/utilize/utils/join-keys";
import type { AdapterQueryOptions, Relationship } from "@azerothian/utilize/types/index";
import type { SequelizeModelClass } from "./types/query";
import { staticsOf } from "./model-creation";
import { mergeFilterStatement } from "./row-helpers";

const log = logger("gqlize::adapter::sequelize::");

export function createRelationshipImpl(
  sequelize: Sequelize,
  targetModel: string,
  sourceModel: string,
  name: string,
  type: string,
  options: Relationship["options"] = {},
): void {
  const model = sequelize.models[targetModel] as SequelizeModelClass;
  if (!model.relationships) {
    model.relationships = {};
  }
  try {
    // `name` is the relationship's identity everywhere else — the include
    // input, permissions, `model.relationships`, ormize and the valkey adapter
    // all key by it — so it is the alias here too. Letting `options.as` win
    // registered the association under a second name, and an `include` naming
    // the relationship then reached for an association that did not exist.
    if (options.as !== undefined && options.as !== name) {
      // eslint-disable-next-line no-console -- see the paranoid warning in `createModel`: `debug` is silent unless enabled, and this changes which name a client must use
      console.warn(
        `Relationship "${targetModel}.${name}": options.as "${options.as}" is ignored; the relationship is named by "name".`,
      );
    }
    const opts: Record<string, unknown> = Object.assign({}, options, { as: name });
    // `through` may also be a bare model name, which Sequelize accepts as-is.
    // Only the object form carries a `model` to resolve.
    //
    // Resolved into `opts`, never back into `options`: `options` is the
    // caller's `rel.options`, handed here unchanged by the manager, and
    // `Relationship["options"].through.model` is declared `string`. Writing
    // the model class back over the name corrupted the definition for every
    // later build and silently broke the three readers that correctly expect
    // a name — `Ormize.resolveCrossAdapterJoin`, `Ormize.deriveOtherKey`, and
    // the valkey adapter's own `deriveOtherKey`, which stopped matching and
    // fell back to a guessed key.
    //
    // The object-form copy is unconditional: sequelize's association builders
    // write back onto the options bag they are handed (`BelongsToMany`
    // normalises `through` and writes `foreignKey`/`otherKey`), so a shallow
    // `opts` is not deep enough at `through` even when there is no name to
    // resolve.
    if (typeof options.through === "object" && options.through) {
      opts.through = options.through.model
        ? { ...options.through, model: sequelize.models[options.through.model] }
        : { ...options.through };
    }
    // Sequelize reads a belongsToMany's keys off the association options only,
    // never off `through`. Both spellings are typed, and ormize and the valkey
    // adapter honour the `through` one, so hoist it — the top-level key still
    // wins — or this backend joins on a guessed column the others do not use.
    if (type === "belongsToMany") {
      if (opts.foreignKey === undefined && throughForeignKey(options.through) !== undefined) {
        opts.foreignKey = throughForeignKey(options.through);
      }
      if (opts.otherKey === undefined && throughOtherKey(options.through) !== undefined) {
        opts.otherKey = throughOtherKey(options.through);
      }
    }
    // `type` names one of Sequelize's association builders (`belongsTo`,
    // `hasMany`, ...) and is called by name off the model class, so the lookup
    // is dynamic — see {@link staticsOf}. An unknown one is a definition error
    // and is reported by the `catch` below.
    const build = staticsOf(model)[type];
    if (typeof build !== "function") {
      throw new Error(`SequelizeAdapter: "${type}" is not a relationship type`);
    }
    model.relationships[name] = {
      name: name,
      type: type,
      source: sourceModel,
      target: targetModel,
      options: opts,
      rel: build.call(model, sequelize.models[sourceModel], opts),
    };
  } catch (err) {
    log.error("Error Mapping relationship", {
      model,
      sourceModel,
      name,
      type,
      options,
      err,
    });
    // Fail fast at boot rather than silently booting with a missing/broken
    // association — downstream query scoping and relationship resolution
    // assume the association exists, so swallowing this hides real defects.
    throw err;
  }
  sequelize.models[targetModel] = model;
}

export function createFunctionForFindImpl(
  sequelize: Sequelize,
  modelName: string,
) {
  const model = sequelize.models[modelName];
  return function(value: unknown, filterKey: string, singular: boolean) {
    return (options: AdapterQueryOptions = {}) => {
      const opts = Object.assign({}, options, {
        where: mergeFilterStatement(filterKey, value, true, options.where),
      });
      if (!singular) {
        return model.findAll(opts);
      }
      return model.findOne(opts);
    };
  };
}
