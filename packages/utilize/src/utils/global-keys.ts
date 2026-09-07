/**
 * The fields a backend exposes as relay global ids rather than raw values:
 * primary and foreign keys, minus anything the definition opted out with
 * `ignoreGlobalKey`.
 *
 * Every adapter and the ormize manager itself need this, and they must agree —
 * a key one of them treats as global and another does not is a value that gets
 * decoded on the way in but not encoded on the way out.
 */
export function globalKeysFromFields(fields: {
  [name: string]: {primaryKey?: unknown; foreignKey?: unknown; ignoreGlobalKey?: unknown};
}): string[] {
  return Object.keys(fields).filter((key) => {
    const field = fields[key];
    return (field.foreignKey || field.primaryKey) && !field.ignoreGlobalKey;
  });
}

/**
 * The same key set as {@link globalKeysFromFields}, but keyed by the type each
 * key points at rather than flattened to a list of names.
 *
 * A foreign key targets its `foreignTarget`; everything else targets its own
 * model. `foreignTarget` wins even when the column is *also* a primary key,
 * which is the whole point of #65: `belongsToMany` drops a join model's own `id`
 * and makes its two foreign keys the composite primary key, so testing
 * `primaryKey` first typed `RoleUser.userId` as a `RoleUser` id rather than the
 * `User` id it holds. The same is true of a shared-primary-key 1:1 table.
 *
 * A column marked `foreignKey` that no relationship ever wired has no target to
 * name, and the encoder falls back to the parent type's own name in that case —
 * this mirrors that fallback, so the pair round-trips.
 *
 * Kept beside `globalKeysFromFields` because they must not disagree: a key one
 * of them treats as global and the other does not is a value decoded on the way
 * in and never encoded on the way out.
 */
export function globalKeyTargets(fields: {
  [name: string]: {primaryKey?: unknown; foreignKey?: unknown; ignoreGlobalKey?: unknown; foreignTarget?: string};
}, defName: string): {[fieldName: string]: string} {
  return globalKeysFromFields(fields).reduce((targets, key) => {
    const field = fields[key];
    targets[key] = field.foreignTarget || defName;
    return targets;
  }, {} as {[fieldName: string]: string});
}
