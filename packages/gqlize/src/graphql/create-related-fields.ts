import createListObject from "./create-list-object";
// import { fromCursor, toCursor } from "./objects/cursor";
import {capitalize} from "@azerothian/utilize/utils/word";
import { isRelationshipAllowed } from "@azerothian/utilize";
import { SchemaCache, GqlizeOptions, Definition, DefinitionFields, HookMap, Relationship, WhereOperators, Association } from '../types';
import GQLManager from '../manager';
import { GraphQLType, GraphQLArgs, GraphQLBoolean } from "graphql";
import { bindField } from "./resolvers/bind";

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

      let include;
      if (associationKeys.length > 0) {
        fields = associationKeys.reduce((f, relName) => {
          const association = associations[relName];
          if (!isRelationshipAllowed(options.permission, defName, relName, association.target)) {
            return f;
          }
          const targetObject = schemaCache.types[association.target];
          const targetDef = instance.getDefinition(association.target);
          if (!targetObject) {
            // `targetType ${relationship.target} not defined for relationship`;
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
            default:
              f[relName] = createManyObject(instance, schemaCache, defName, targetDef, targetObject, "", association, (definition.comments?.fields || {})[relName], options);
              break;
          }

          return f;
        }, {} as any);
      }
      schemaCache.relatedFields[defName] = fields;
    }
    return fields;
  };
}

function createManyObject(instance: GQLManager, schemaCache: SchemaCache, defName: string, targetDef: Definition, targetObject: any, prefix: string, relationship: Association, comment: string, options: GqlizeOptions) {
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
