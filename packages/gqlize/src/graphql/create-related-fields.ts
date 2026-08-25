import createListObject from "./create-list-object";
// import { fromCursor, toCursor } from "./objects/cursor";
import {capitalize} from "@azerothian/utilize/utils/word";
import { isRelationshipAllowed } from "@azerothian/utilize";
import { SchemaCache, GqlFieldMap, GqlizeOptions, Definition, Association } from '../types';
import GQLManager from '../manager';
import { GraphQLBoolean, type GraphQLOutputType } from "graphql";
import { bindField } from "./resolvers/bind";

/**
 * Deliberately `console.warn` and not the `debug`-based logger, for the reason
 * given in `./index.ts`: `debug` is silent unless `DEBUG` is set, which would
 * make a silently dropped relationship invisible - the thing this warning
 * exists to surface.
 */
const log = {
  warn: (message: string) => console.warn(message), // eslint-disable-line no-console
};

export default function createRelatedFieldsFunc(
  defName: string,
  instance: GQLManager,
  definition: Definition,
  options: GqlizeOptions,
  schemaCache: SchemaCache
) {
  return function relatedFields() {

    let fields = schemaCache.relatedFields[defName];
    if (!fields && schemaCache.types[defName]) {
      const associations = instance.getAssociations(defName);
      const associationKeys = Object.keys(associations);

      if (associationKeys.length > 0) {
        fields = associationKeys.reduce((f, relName) => {
          const association = associations[relName];
          if (!isRelationshipAllowed(options.permission, defName, relName, association.target)) {
            return f;
          }
          const targetObject = schemaCache.types[association.target];
          const targetDef = instance.getDefinition(association.target);
          if (!targetObject) {
            // A relationship with no target type cannot become a field, but it
            // used to vanish without a word - leaving a schema quietly missing a
            // field its author declared. See #14.
            //
            // Only warn when there is no definition behind the target either: a
            // type absent despite a definition was omitted on purpose (denied by
            // `permission.model`, or emptied of every field by `permission.field`
            // - see `permission-empty-types.test.ts`), and dropping the
            // relationship is how that omission is meant to propagate. A target
            // with no definition at all is an authoring mistake: a typo'd
            // `rel.model`, or a model that ormize knows and gqlize was not given.
            if (!targetDef) {
              log.warn(`gqlize: relationship '${defName}.${relName}' targets '${association.target}', which has no definition - the field has been omitted from the schema.`);
            }
            return f;
          }
          switch (association.associationType) {
            case "hasOne":
            case "belongsTo":
              f[relName] = bindField({
                type: targetObject,
                description: ((definition.comments || {}).fields || {})[relName],
                args: {
                  required: {
                    type: GraphQLBoolean,
                    description: "When true, the relation is eager-loaded as an INNER JOIN so parents without a matching related row are excluded.",
                  },
                },
              }, {
                kind: "singleRelationship",
                defName,
                relName,
                targetDefName: association.target,
              }, { instance, options });
              break;
            default: {
              // `createManyObject` returns nothing for a target definition with
              // no `name`, which cannot become a list field. Guarded rather than
              // assigned: a key holding `undefined` reaches `GraphQLObjectType`
              // as a field with no config and fails the whole build.
              const many = createManyObject(instance, schemaCache, defName, targetDef, targetObject, "", association, (definition.comments?.fields || {})[relName], options);
              if (many) {
                f[relName] = many;
              }
              break;
            }
          }

          return f;
        }, {} as GqlFieldMap);
      }
      schemaCache.relatedFields[defName] = fields;
    }
    return fields;
  };
}

function createManyObject(instance: GQLManager, schemaCache: SchemaCache, defName: string, targetDef: Definition, targetObject: GraphQLOutputType, prefix: string, relationship: Association, comment: string, options: GqlizeOptions) {
  if(targetDef?.name) {
    // The association is looked up on the *parent* (`defName`) while the rows
    // themselves belong to the target — hence both names in the descriptor.
    return createListObject(instance, schemaCache, targetDef.name, targetObject, {
      source: "manyRelationship",
      defName: targetDef.name,
      parentDefName: defName,
      relName: relationship.name,
    }, prefix, `${relationship.associationType}${capitalize(relationship.name)}`, undefined, comment, options);
  }
}
