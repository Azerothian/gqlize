import type { Relationship } from "../types/index";

/**
 * Reading a `belongsToMany`'s join model and its keys.
 *
 * `Relationship.options.through` has two spellings — a bare model name, or an
 * object carrying that name plus its own key overrides — and every reader has to
 * handle both. That unwrapping was written out four times across ormize and the
 * valkey adapter, and the type it depends on has already been broken once: the
 * sequelize adapter used to overwrite `through.model` with a live model *class*,
 * which silently turned every one of those readers into a no-match that fell
 * back to a guessed key (fixed in 7.0.0-beta.11). One implementation is a
 * correctness argument as much as a tidiness one — there is now a single place
 * where the assumption "this is a model name" lives.
 *
 * Not folded in: the sequelize adapter's own `through` handling, which
 * deliberately resolves the name to a model object because that is what
 * Sequelize's association builders want.
 */

/** The join model's name, whichever spelling was used. */
export function throughModelName(through: Relationship["options"]["through"]): string | undefined {
  return typeof through === "string" ? through : through?.model;
}

/** An `otherKey` declared on the object form of `through`, if there is one. */
export function throughOtherKey(through: Relationship["options"]["through"]): string | undefined {
  return typeof through === "object" ? through?.otherKey : undefined;
}

/** A `foreignKey` declared on the object form of `through`, if there is one. */
export function throughForeignKey(through: Relationship["options"]["through"]): string | undefined {
  return typeof through === "object" ? through?.foreignKey : undefined;
}

/**
 * A relationship's foreign key: the top-level `options.foreignKey`, or — for a
 * `belongsToMany`, whose keys live on the join model — the one declared under
 * `through`. Both are typed; only the top-level one used to be read, so a key
 * written under `through` was ignored by one backend and honoured by another.
 */
export function relationshipForeignKey(type: string, options: Relationship["options"] | undefined): string | undefined {
  if (options?.foreignKey !== undefined) {
    return options.foreignKey;
  }
  return type === "belongsToMany" ? throughForeignKey(options?.through) : undefined;
}

/**
 * The reciprocal `belongsToMany`'s foreign key — the join column pointing at the
 * target.
 *
 * Takes the relationship list rather than a registry, because the two callers
 * hold it differently: ormize reads definitions, the valkey adapter reads its own
 * models. `throughName` may be absent — a `belongsToMany` declared without a
 * `through` has no join model to match a reciprocal against, and no key comes
 * back.
 */
export function reciprocalOtherKey(
  relationships: Relationship[] | undefined,
  throughName: string | undefined,
): string | undefined {
  const reciprocal = (relationships || []).find((r) =>
    r.type === "belongsToMany" && throughModelName(r.options?.through) === throughName);
  return reciprocal?.options?.foreignKey;
}
