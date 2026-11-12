import createListObject, { type ListObjectExtras } from "./create-list-object";
import {capitalize} from "@azerothian/utilize/utils/word";
import { deprecationFor, isRelationshipAllowed, isThroughMode } from "@azerothian/utilize";
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
                deprecationReason: deprecationFor(definition, "fields", relName),
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
                // `createManyObject` hands back the *cached* connection field
                // config (`schemaCache.lists`), which more than one parent can
                // share — copy before marking rather than deprecating every
                // other use of the same connection.
                const reason = deprecationFor(definition, "fields", relName);
                f[relName] = reason ? {...many, deprecationReason: reason} : many;
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

/**
 * A through-mode `belongsToMany`'s additions to its connection: the join row on
 * each edge (`through`, the join model's own type) and `throughWhere` /
 * `throughOrderBy` on the field. `undefined` for every other relationship, and
 * for one whose join model the permission bag hides or that has no type.
 */
function throughExtras(instance: GQLManager, schemaCache: SchemaCache, relationship: Association, options: GqlizeOptions): ListObjectExtras | undefined {
  if (!isThroughMode(options.permission, relationship)) {
    return undefined;
  }
  const joinName = relationship.through as string;
  const joinType = schemaCache.types[joinName];
  if (!joinType) {
    return undefined;
  }
  const filter = instance.getFilterGraphQLType(joinName);
  const orderBy = instance.getOrderByGraphQLType(joinName);
  return {
    edgeFields: () => ({
      through: {
        type: joinType,
        description: `The ${joinName} row behind this link`,
      },
    }),
    args: {
      ...(filter ? {throughWhere: {type: filter, description: `Only links whose ${joinName} row matches`}} : {}),
      ...(orderBy ? {throughOrderBy: {type: orderBy, description: `Order the links by ${joinName} columns, before \`orderBy\``}} : {}),
    },
  };
}

function createManyObject(instance: GQLManager, schemaCache: SchemaCache, defName: string, targetDef: Definition, targetObject: GraphQLOutputType, prefix: string, relationship: Association, comment: string, options: GqlizeOptions) {
  if(targetDef?.name) {
    // The edge of a through-mode relationship carries this parent's join model,
    // so its connection cannot be the one other parents of the same target
    // share by name: it is named after the parent too.
    const extras = throughExtras(instance, schemaCache, relationship, options);
    // The association is looked up on the *parent* (`defName`) while the rows
    // themselves belong to the target — hence both names in the descriptor.
    return createListObject(instance, schemaCache, targetDef.name, targetObject, {
      source: "manyRelationship",
      defName: targetDef.name,
      parentDefName: defName,
      relName: relationship.name,
    }, extras ? defName : prefix, `${relationship.associationType}${capitalize(relationship.name)}`, undefined, comment, options, extras);
  }
}
