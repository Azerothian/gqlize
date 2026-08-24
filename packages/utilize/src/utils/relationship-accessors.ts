import pluralize from "pluralize";
import {capitalize} from "./word";

/** The ten Sequelize-style accessor names a relationship defines on a record. */
export interface RelationshipAccessors {
  get: string;
  set: string;
  add: string;
  addMultiple: string;
  remove: string;
  removeMultiple: string;
  count: string;
  create: string;
  hasSingle: string;
  hasAll: string;
}

/**
 * Build the accessor-name table for a relationship: singular for the -one
 * variants, plural for the -many.
 *
 * Every adapter and the cross-adapter wiring in ormize must produce the *same*
 * names for the same relationship, or a cross-adapter relationship silently
 * fails to find the accessor it is looking for. Hence one table.
 *
 * `getName` overrides the read accessor. Cross-adapter relationships resolve
 * their own during wiring, and it is not always `get${Name}`.
 */
export function relationshipAccessors(name: string, getName?: string): RelationshipAccessors {
  const nameCap = capitalize(name);
  const singCap = capitalize(pluralize.singular(name));
  return {
    get: getName ?? `get${nameCap}`,
    set: `set${nameCap}`,
    add: `add${singCap}`,
    addMultiple: `add${nameCap}`,
    remove: `remove${singCap}`,
    removeMultiple: `remove${nameCap}`,
    count: `count${nameCap}`,
    create: `create${singCap}`,
    hasSingle: `has${singCap}`,
    hasAll: `has${nameCap}`,
  };
}
