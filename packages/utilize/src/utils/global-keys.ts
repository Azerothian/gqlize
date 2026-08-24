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
  [name: string]: {primaryKey?: any; foreignKey?: any; ignoreGlobalKey?: any};
}): string[] {
  return Object.keys(fields).filter((key) => {
    const field = fields[key];
    return (field.foreignKey || field.primaryKey) && !field.ignoreGlobalKey;
  });
}
