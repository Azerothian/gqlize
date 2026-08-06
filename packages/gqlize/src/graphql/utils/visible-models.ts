import { isFieldAllowed, isModelAllowed, isRelationshipAllowed } from "@azerothian/utilize";
import GQLManager from "../../manager";
import { Definitions, GqlizeOptions } from "../../types";

/**
 * Work out which models still have at least one visible output field under the
 * configured permissions.
 *
 * A model whose every field is denied would produce a `GraphQLObjectType` with
 * no fields, which is not a valid GraphQL type — `validateSchema` reports
 * "Type X must define one or more fields." and every query against the schema
 * fails. The only safe answer is to drop the model from the schema entirely.
 *
 * This has to be a fixpoint rather than a single pass: a model whose only
 * visible field is a relationship becomes empty itself once that relationship's
 * target is dropped, and so on transitively.
 *
 * The result is folded back into the permission bag by the caller so that every
 * downstream builder — related fields, list objects, mutation inputs, the relay
 * node fetcher and the adapters' include types — agrees on which models exist.
 */
export default function computeVisibleModels(instance: GQLManager, definitions: Definitions, options: GqlizeOptions): Set<string> {
  const defNames = Object.keys(definitions);
  const visible = new Set(defNames.filter((defName) => isModelAllowed(options.permission, defName)));

  // Mirrors `create-basic-fields`: overrides and `ignoreFields` are removed from
  // the candidate keys, and an empty candidate list short-circuits *before* the
  // overrides are merged back in — so a model left with only overrides really
  // does end up with no basic fields.
  const hasBasicFields: { [defName: string]: boolean } = {};
  visible.forEach((defName) => {
    const definition = definitions[defName];
    const exclude = Object.keys(definition.override || {}).concat(definition.ignoreFields || []);
    const modelFields = instance.getFields(defName);
    hasBasicFields[defName] = Object.keys(modelFields).some((fieldName) => {
      return exclude.indexOf(fieldName) === -1 && isFieldAllowed(options.permission, defName, fieldName);
    });
  });

  // Mirrors `create-related-fields`: a relationship contributes a field only
  // when it is permitted and its target model made it into the schema.
  function hasRelatedFields(defName: string) {
    const associations = instance.getAssociations(defName);
    return Object.keys(associations).some((relName) => {
      const association = associations[relName];
      return isRelationshipAllowed(options.permission, defName, relName, association.target) &&
        visible.has(association.target);
    });
  }

  // Mirrors `create-complex-fields`: an instance method contributes a field only
  // when it is permitted and its type resolves (a string type names a model).
  function hasComplexFields(defName: string) {
    const instanceMethods = definitions[defName].expose?.instanceMethods?.query;
    if (!instanceMethods) {
      return false;
    }
    return Object.keys(instanceMethods).some((methodName) => {
      const { type } = instanceMethods[methodName];
      if (!type || (typeof type === "string" && !visible.has(type))) {
        return false;
      }
      return isAllowedInstanceMethod(options, defName, methodName);
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    Array.from(visible).forEach((defName) => {
      if (hasBasicFields[defName] || hasRelatedFields(defName) || hasComplexFields(defName)) {
        return;
      }
      visible.delete(defName);
      changed = true;
    });
  }
  return visible;
}

function isAllowedInstanceMethod(options: GqlizeOptions, defName: string, methodName: string) {
  const permission: any = options.permission;
  if (!permission?.queryInstanceMethods) {
    return true;
  }
  return !!permission.queryInstanceMethods(defName, methodName, permission.options);
}
