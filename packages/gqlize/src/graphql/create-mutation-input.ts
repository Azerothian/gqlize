import {
  GraphQLNonNull, GraphQLList, GraphQLInt,
  GraphQLID, GraphQLBoolean,
} from "graphql";
import type { GraphQLNullableInputType } from "graphql";
import JSONType from "@azerothian/graphql-types/json";

import createGQLInputObject from "./create-gql-input-object";
import { isInputFieldWritable, isMutationAllowed } from "@azerothian/utilize";
import {capitalize} from "@azerothian/utilize/utils/word";
import {waterfallSync} from "@azerothian/utilize/utils/waterfall";
import GQLManager from '../manager';
import { Definition, DefinitionFields, SchemaCache, Association, GqlizeOptions } from '../types';
import { recordExternalType } from "./snapshot/ledger";
import { isBuiltInputType, type AuthoredTypeSlot } from "./utils/authored-type";

/** Whether a relationship may appear on a create/update input object. */
function isRelationshipInputAllowed(options: GqlizeOptions, defName: string, relName: string, forceOptional: boolean) {
  const permission: any = options.permission;
  if (!permission) {
    return true;
  }
  const predicate = forceOptional ? permission.mutationUpdateInput : permission.mutationCreateInput;
  if (!predicate) {
    return true;
  }
  return !!predicate(defName, relName, permission.options);
}

/**
 * Whether `generateInputFields` will produce at least one field.
 *
 * An input object with no fields is not a valid GraphQL type, and permissions
 * can deny every writable field of a model (primary and foreign keys are already
 * stripped as structurally unwritable). This mirrors the two reduces below
 * without building any types, so the caller can decide not to create the input
 * object at all — the built version cannot be inspected because it is a thunk,
 * deferred so that relationship targets later in the build order resolve.
 */
function hasInputFields(defName: string, defFields: DefinitionFields, associations: {[relName: string]: Association}, mutableDefNames: Set<string>, forceOptional: boolean, options: GqlizeOptions) {
  const kind = forceOptional ? "update" : "create";
  const hasWritableField = Object.keys(defFields).some((fieldName) => {
    return isInputFieldWritable(options.permission, defName, fieldName, kind, defFields[fieldName]);
  });
  if (hasWritableField) {
    return true;
  }
  // A permitted relationship always contributes a field: even when the target
  // has no create/update input of its own, `set`/`remove`/`delete`/`restore`
  // are built from its filter type.
  return Object.keys(associations).some((relName) => {
    return isRelationshipInputAllowed(options, defName, relName, forceOptional) &&
      mutableDefNames.has(associations[relName].target);
  });
}

//(instance, defName, fields, relationships, inputTypes, false)
export function generateInputFields(instance: GQLManager, defName: string, definition: Definition, defFields: DefinitionFields, associations: {[relName: string]: Association}, inputTypes: any, schemaCache: SchemaCache, forceOptional: boolean, options: GqlizeOptions) {
  const def = waterfallSync(Object.keys(defFields), (fieldName: string, fields: {[key: string]: any}) => {
    const doNotSkip = isInputFieldWritable(options.permission, defName, fieldName, forceOptional ? "update" : "create", defFields[fieldName]);
    if (!doNotSkip) {
      return fields;
    }
    const field = defFields[fieldName];
    const comment = (definition.comments?.fields || {})[fieldName] || field.description;
    if (definition.override) {
      const overrideFieldDefinition = definition.override[fieldName];

      if (overrideFieldDefinition) {
        // Both forms an author may write carry a `name`; only the config form
        // carries `fields`, which is read in the build branch below.
        const type = (overrideFieldDefinition.inputType || overrideFieldDefinition.type) as AuthoredTypeSlot;
        let name = type.name;
        if (!overrideFieldDefinition.inputType) {
          name = `${type.name}${capitalize(fieldName)}Input`;
        }
        if (forceOptional) {
          name = `${capitalize(type.name)}Optional${capitalize(fieldName)}`;
        }
        // The guard reads `type`, not `inputType`, exactly as before: an override
        // that supplies a built `inputType` supplies a built `type` alongside it.
        const inputType: GraphQLNullableInputType = isBuiltInputType(overrideFieldDefinition.type)
          ? type as unknown as GraphQLNullableInputType
          : createGQLInputObject(name, type.fields, schemaCache, comment);
        recordExternalType(schemaCache, inputType, {
          via: "definitionOverride",
          defName,
          fieldName,
          use: "inputType",
          forceOptional,
        });

        if (!field.allowNull && !field.autoPopulated && !forceOptional) {
          fields[fieldName] = {
            type: new GraphQLNonNull(inputType),
            description: comment,
          };
        } else {
          fields[fieldName] = {
            type: inputType,
            description: comment,
          };
        }
      }
    }
    if (!fields[fieldName]) {
      if (instance.getGlobalKeys(defName).indexOf(fieldName) > -1) {
        fields[fieldName] = {
          type: GraphQLID,
          description: comment || `This a primary key for ${defName}`,
        };
      } else {
        const type = instance.getGraphQLInputType(defName, `${fieldName}${forceOptional ? "Optional" : "Required"}`, field.type);
        const t = field.allowNull || field.autoPopulated || forceOptional ? type : new GraphQLNonNull(type as any);
        fields[fieldName] = {
          type: t,
          description: comment,
        };
      }
    }
    return fields;
  }, {});

  return waterfallSync(Object.keys(associations), (relName: string, fields: any) => {
    if (!isRelationshipInputAllowed(options, defName, relName, forceOptional)) {
      return fields;
    }
    const association = associations[relName];
    if (!inputTypes[association.target]) {
      return fields;
    }
    const fld: any = {};
    const filterType = instance.getFilterGraphQLType(association.target);
    const createInput = inputTypes[association.target].required;
    let updateInput, selectInput;
    if (inputTypes[association.target].optional) {
      updateInput = createGQLInputObject(`${defName}${capitalize(relName)}Update`, {
        where: {
          type: filterType,
          description: "This will apply a filter to your mutation",
        },
        input: {
          type: inputTypes[association.target].optional,
          description: "This will update the items that you targeted with the filter in the where element",
        },
      }, schemaCache, "");
      // `select` finds related records by filter and runs further relationship
      // mutations on them via `input` WITHOUT modifying the found records
      // themselves (scalar fields in `input` are ignored).
      selectInput = createGQLInputObject(`${defName}${capitalize(relName)}Select`, {
        where: {
          type: filterType,
          description: "Filter used to find the existing related elements to run relationship mutations on",
        },
        input: {
          type: inputTypes[association.target].optional,
          description: "Relationship mutations to run on the selected elements. Scalar fields are ignored — the selected elements are not modified",
        },
      }, schemaCache, "");
    }
    const isBelongsToMany = association.associationType === "belongsToMany";
    const isCollection = association.associationType === "hasMany" || isBelongsToMany;
    if (isCollection) {
      if (createInput) {
        fld.create = {
          type: new GraphQLList(createInput),
          description: `This will create a new element with a relationship to the current ${defName}`,
        };
      }
      if (updateInput) {
        fld.update = {
          type: new GraphQLList(updateInput),
          description: `This will update any matching elements that have a relationship to the current ${defName}`,
        };
      }
      if (isBelongsToMany) {
        // belongsToMany add/set accept an optional `through` payload to write
        // join-table column values for the associated records.
        const throughInput = createGQLInputObject(`${defName}${capitalize(relName)}AddThrough`, {
          where: {
            type: filterType,
            description: "Filter used to find the existing elements to associate",
          },
          through: {
            type: JSONType,
            description: "Attribute values to write on the join table for the associated elements",
          },
        }, schemaCache, "");
        fld.add = {
          type: new GraphQLList(throughInput),
          description: `This will add any matching existing elements (with optional through attributes) to the current ${defName}`,
        };
        fld.set = {
          type: new GraphQLList(throughInput),
          description: `This will replace the entire ${relName} set with the matching existing elements (with optional through attributes)`,
        };
      } else {
        fld.add = {
          type: new GraphQLList(filterType),
          description: `This will add any matching elements with a relationship to the current ${defName}`,
        };
        fld.set = {
          type: new GraphQLList(filterType),
          description: `This will replace the entire ${relName} set with the matching existing elements`,
        };
      }
      fld.remove = {
        type: new GraphQLList(filterType),
        description: `This will remove the relationship from any matching elements from the current ${defName}`,
      };
      fld.delete = {
        type: new GraphQLList(filterType),
        description: `This will delete any matching elements that have a relationship with the current ${defName}`,
      };
      fld.restore = {
        type: new GraphQLList(filterType),
        description: `This will restore any soft-deleted matching elements related to the current ${defName}`,
      };
      if (selectInput) {
        fld.select = {
          type: new GraphQLList(selectInput),
          description: `This will find matching related elements and run relationship mutations on them without modifying the elements themselves`,
        };
      }
    } else {
      if (createInput) {
        fld.create = {
          type: createInput,
          description: `This will create a new element with a relationship to the current ${defName}`,
        };
      }
      if (updateInput) {
        fld.update = {
          type: updateInput,
          description: `This will update any matching elements that have a relationship to the current ${defName}`,
        };
      }
      fld.set = {
        type: filterType,
        description: `This will associate an existing matching element with the current ${defName}`,
      };
      fld.remove = {
        type: GraphQLBoolean,
        description: `When true, this will disassociate the current ${relName} from the ${defName}`,
      };
      fld.delete = {
        type: filterType,
        description: `This will delete any matching elements that have a relationship with the current ${defName}`,
      };
      fld.restore = {
        type: filterType,
        description: `This will restore the soft-deleted ${relName} related to the current ${defName}`,
      };
      if (selectInput) {
        fld.select = {
          type: selectInput,
          description: `This will find the matching related ${relName} and run relationship mutations on it without modifying the element itself`,
        };
      }
    }
    fields[relName] = {
      type: createGQLInputObject(`${defName}${capitalize(relName)}${capitalize(association.associationType)}Input`, fld, schemaCache, ""),
      description: `This is the mutation object for ${defName}${capitalize(relName)}${capitalize(association.associationType)}`,
    };
    return fields;
  }, def);
}

export default function createMutationInput(instance: GQLManager, defName: string, schemaCache: SchemaCache, inputTypes: any, options: any, mutableDefNames: Set<string>) {
  const fields = instance.getFields(defName);
  const associations = instance.getAssociations(defName);
  const definition = instance.getDefinition(defName);
  // Permissions can leave a model with nothing writable at all; the resulting
  // input object would have no fields and make the whole schema invalid, so it
  // is not built and the mutations that would take it are omitted.
  const doNotSkipUpdate = isMutationAllowed(options.permission, defName, "update") &&
    hasInputFields(defName, fields, associations, mutableDefNames, true, options);
  const doNotSkipCreate = isMutationAllowed(options.permission, defName, "create") &&
    hasInputFields(defName, fields, associations, mutableDefNames, false, options);
  const required = doNotSkipCreate ? createGQLInputObject(`${defName}RequiredInput`, function() {
    return generateInputFields(instance, defName, definition, fields, associations, inputTypes, schemaCache, false, options);
  }, schemaCache, "") : undefined;
  const optional = doNotSkipUpdate ? createGQLInputObject(`${defName}OptionalInput`, function() {
    return generateInputFields(instance, defName, definition, fields, associations, inputTypes, schemaCache, true, options);
  }, schemaCache, "") : undefined;
  const filterType = instance.getFilterGraphQLType(defName);
  return {
    required, optional,
    create: required ? new GraphQLList(required) : undefined,
    update: optional ? new GraphQLList(createGQLInputObject(`${defName}UpdateInput`, {
      where: {
        type: filterType,
        description: "If provided this will restrict to changes to only the elements that match",
      },
      limit: {
        type: GraphQLInt,
        description: "If provided this will restrict the changes to only the first amount of ${limit}",
      },
      input: {
        type: optional,
        description: "This is the input for the data",
      },
    }, schemaCache, "")) : undefined,
    // `select` finds matching elements and runs relationship mutations on them
    // (via `input`) without modifying the elements themselves.
    select: optional ? new GraphQLList(createGQLInputObject(`${defName}SelectInput`, {
      where: {
        type: filterType,
        description: "Filter used to find the existing elements to run relationship mutations on",
      },
      limit: {
        type: GraphQLInt,
        description: "If provided this will restrict the selection to only the first amount of ${limit}",
      },
      input: {
        type: optional,
        description: "Relationship mutations to run on the selected elements. Scalar fields are ignored — the selected elements are not modified",
      },
    }, schemaCache, "")) : undefined,
    delete: new GraphQLList(filterType),
  };
}




