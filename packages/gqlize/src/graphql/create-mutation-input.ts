import {
  GraphQLInputObjectType, GraphQLNonNull, GraphQLScalarType, GraphQLEnumType, GraphQLList, GraphQLInt,
  GraphQLID, GraphQLBoolean,
} from "graphql";
import JSONType from "@azerothian/graphql-types/json";

import createGQLInputObject from "./create-gql-input-object";
import {capitalize} from "@azerothian/gqlize-shared/utils/word";
import {waterfallSync} from "@azerothian/gqlize-shared/utils/waterfall";
import GQLManager from '../manager';
import { Definition, DefinitionFields, SchemaCache, Association, GqlizeOptions } from '../types';
import { Relationship } from '../types/index';
//(instance, defName, fields, relationships, inputTypes, false)
export function generateInputFields(instance: GQLManager, defName: string, definition: Definition, defFields: DefinitionFields, associations: {[relName: string]: Association}, inputTypes: any, schemaCache: SchemaCache, forceOptional: boolean, options: GqlizeOptions) {
  let def = waterfallSync(Object.keys(defFields), (fieldName: string, fields: {[key: string]: any}) => {
    let doNotSkip = true;
    if (options.permission) {
      if (forceOptional) {
        if (options.permission.mutationUpdateInput) {
          doNotSkip = options.permission.mutationUpdateInput(defName, fieldName, options.permission.options);
        }
      } else {
        if (options.permission.mutationCreateInput) {
          doNotSkip = options.permission.mutationCreateInput(defName, fieldName, options.permission.options);
        }
      }
    }
    if (!doNotSkip) {
      return fields;
    }
    const field = defFields[fieldName];
    const comment = (definition.comments?.fields || {})[fieldName] || field.description;
    if (definition.override) {
      const overrideFieldDefinition = definition.override[fieldName];

      if (overrideFieldDefinition) {
        const type = overrideFieldDefinition.inputType || overrideFieldDefinition.type;
        let name = type.name;
        if (!overrideFieldDefinition.inputType) {
          name = `${type.name}${capitalize(fieldName)}Input`;
        }
        if (forceOptional) {
          name = `${capitalize(type.name)}Optional${capitalize(fieldName)}`;
        }
        let inputType;
        if (!(overrideFieldDefinition.type instanceof GraphQLInputObjectType) &&
          !(overrideFieldDefinition.type instanceof GraphQLScalarType) &&
          !(overrideFieldDefinition.type instanceof GraphQLEnumType)) {
          inputType = createGQLInputObject(name, type.fields, schemaCache, comment);
        } else {
          inputType = type;
        }

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
        let t = field.allowNull || field.autoPopulated || forceOptional ? type : new GraphQLNonNull(type);
        fields[fieldName] = {
          type: t,
          description: comment,
        };
      }
    }
    return fields;
  }, {} as {[key: string]: any});

  return waterfallSync(Object.keys(associations), (relName: string, fields: any) => {
    let doNotSkip = true;
    if (options.permission) {
      if (forceOptional) {
        if (options.permission.mutationUpdateInput) {
          doNotSkip = options.permission.mutationUpdateInput(defName, relName, options.permission.options);
        }
      } else {
        if (options.permission.mutationCreateInput) {
          doNotSkip = options.permission.mutationCreateInput(defName, relName, options.permission.options);
        }
      }
    }
    if (!doNotSkip) {
      return fields;
    }
    const association = associations[relName];
    if (!inputTypes[association.target]) {
      return fields;
    }
    const fld: any = {};
    const filterType = instance.getFilterGraphQLType(association.target);
    let updateInput, createInput = inputTypes[association.target].required;
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
    }
    fields[relName] = {
      type: createGQLInputObject(`${defName}${capitalize(relName)}${capitalize(association.associationType)}Input`, fld, schemaCache, ""),
      description: `This is the mutation object for ${defName}${capitalize(relName)}${capitalize(association.associationType)}`,
    };
    return fields;
  }, def);
}

export default function createMutationInput(instance: GQLManager, defName: string, schemaCache: SchemaCache, inputTypes: any, options: any) {
  const fields = instance.getFields(defName);
  const associations = instance.getAssociations(defName);
  const definition = instance.getDefinition(defName);
  let required, optional;
  let doNotSkipUpdate = true, doNotSkipCreate = true;
  if (options.permission) {
    if (options.permission.mutationUpdate) {
      doNotSkipUpdate = options.permission.mutationUpdate(defName, options.permission.options);
    }
    if (options.permission.mutationCreate) {
      doNotSkipCreate = options.permission.mutationCreate(defName, options.permission.options);
    }
  }
  if (doNotSkipCreate) {
    required = createGQLInputObject(`${defName}RequiredInput`, function() {
      return generateInputFields(instance, defName, definition, fields, associations, inputTypes, schemaCache, false, options);
    }, schemaCache, "");
  }
  if (doNotSkipUpdate) {
    optional = createGQLInputObject(`${defName}OptionalInput`, function() {
      return generateInputFields(instance, defName, definition, fields, associations, inputTypes, schemaCache, true, options);
    }, schemaCache, "");
  }
  const filterType = instance.getFilterGraphQLType(defName);
  return {
    required, optional,
    create: (doNotSkipCreate) ? new GraphQLList(required) : undefined,
    update: (doNotSkipUpdate) ? new GraphQLList(createGQLInputObject(`${defName}UpdateInput`, {
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
    delete: new GraphQLList(filterType),
  };
}




