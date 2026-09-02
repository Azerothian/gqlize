import {
  GraphQLNonNull, GraphQLList, GraphQLInt,
  GraphQLID, GraphQLBoolean,
} from "graphql";
import type { GraphQLInputFieldConfig, GraphQLInputFieldConfigMap, GraphQLInputType, GraphQLNullableInputType, ThunkObjMap } from "graphql";
import JSONType from "@azerothian/graphql-types/json";

import createGQLInputObject from "./create-gql-input-object";
import { deprecationFor, isInputFieldWritable, isMutationAllowed } from "@azerothian/utilize";
import {capitalize} from "@azerothian/utilize/utils/word";
import {waterfallSync} from "@azerothian/utilize/utils/waterfall";
import GQLManager from '../manager';
import { Definition, DefinitionFields, SchemaCache, Association, GqlizeOptions } from '../types';
import { recordExternalType } from "./snapshot/ledger";
import { isBuiltInputType, type AuthoredTypeSlot } from "./utils/authored-type";

/** Whether a relationship may appear on a create/update input object. */
function isRelationshipInputAllowed(options: GqlizeOptions, defName: string, relName: string, forceOptional: boolean) {
  const permission = options.permission;
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
export function generateInputFields(instance: GQLManager, defName: string, definition: Definition, defFields: DefinitionFields, associations: {[relName: string]: Association}, inputTypes: SchemaCache["mutationInputs"], schemaCache: SchemaCache, forceOptional: boolean, options: GqlizeOptions) {
  const def = waterfallSync(Object.keys(defFields), (fieldName: string, fields: GraphQLInputFieldConfigMap) => {
    const doNotSkip = isInputFieldWritable(options.permission, defName, fieldName, forceOptional ? "update" : "create", defFields[fieldName]);
    if (!doNotSkip) {
      return fields;
    }
    const field = defFields[fieldName];
    const comment = (definition.comments?.fields || {})[fieldName] || field.description;
    // A *required* input field cannot carry `@deprecated` — graphql rejects the
    // schema outright, because a client has no way to stop sending a value it is
    // obliged to send. So the reason is attached only on the branches that leave
    // the field nullable, which for a NOT NULL column means it shows on the
    // update input (`forceOptional`) and not on the create input. That asymmetry
    // is the spec's, not ours.
    const deprecationReason = deprecationFor(definition, "fields", fieldName, field.deprecated);
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
          : createGQLInputObject(name, type.fields as ThunkObjMap<GraphQLInputFieldConfig>, schemaCache, comment);
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
            deprecationReason,
          };
        }
      }
    }
    if (!fields[fieldName]) {
      if (instance.getGlobalKeys(defName).indexOf(fieldName) > -1) {
        fields[fieldName] = {
          type: GraphQLID,
          description: comment || `This a primary key for ${defName}`,
          deprecationReason,
        };
      } else {
        // The adapter's type mapper serves both output and input positions and is
        // declared over the whole type union; the `Input` suffix it is called with
        // is what asks for the input side, and graphql rejects an output-only type
        // when the input object is built.
        const type = instance.getGraphQLInputType(defName, `${fieldName}${forceOptional ? "Optional" : "Required"}`, field.type) as GraphQLInputType;
        const required = !(field.allowNull || field.autoPopulated || forceOptional);
        fields[fieldName] = {
          type: required ? new GraphQLNonNull(type as GraphQLNullableInputType) : type,
          description: comment,
          deprecationReason: required ? undefined : deprecationReason,
        };
      }
    }
    return fields;
  }, {});

  return waterfallSync(Object.keys(associations), (relName: string, fields: GraphQLInputFieldConfigMap) => {
    if (!isRelationshipInputAllowed(options, defName, relName, forceOptional)) {
      return fields;
    }
    const association = associations[relName];
    const targetInputs = inputTypes[association.target];
    if (!targetInputs) {
      return fields;
    }
    const fld: GraphQLInputFieldConfigMap = {};
    const filterType = instance.getFilterGraphQLType(association.target);
    const createInput = targetInputs.required;
    const optionalInput = targetInputs.optional;
    let updateInput, selectInput;
    if (optionalInput) {
      updateInput = createGQLInputObject(`${defName}${capitalize(relName)}Update`, {
        where: {
          type: filterType,
          description: "This will apply a filter to your mutation",
        },
        input: {
          type: optionalInput,
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
          type: optionalInput,
          description: "Relationship mutations to run on the selected elements. Scalar fields are ignored — the selected elements are not modified",
        },
      }, schemaCache, "");
    }
    const isBelongsToMany = association.associationType === "belongsToMany";
    const isCollection = association.associationType === "hasMany" || isBelongsToMany;
    // belongsToMany add/set accept an optional `through` payload to write
    // join-table column values for the associated records.
    const throughInput = isBelongsToMany
      ? createGQLInputObject(`${defName}${capitalize(relName)}AddThrough`, {
        where: {
          type: filterType,
          description: "Filter used to find the existing elements to associate",
        },
        through: {
          type: JSONType,
          description: "Attribute values to write on the join table for the associated elements",
        },
      }, schemaCache, "")
      : undefined;
    const list = (type: GraphQLInputType) => new GraphQLList(type);
    const addSetType = throughInput ? list(throughInput) : list(filterType);

    // The eight relationship verbs, in the order they are declared on the input
    // type. This is the schema-side half of `VERBS` in ormize's
    // `relationship-mutations.ts`, which is the engine-side list of the same
    // eight — kept in the same shape and the same order so the two can be read
    // against each other. They must agree: a verb offered here that the engine
    // does not implement is a field that silently does nothing.
    //
    // `available` gates a verb on the input type it needs existing at all;
    // `singular` is absent for `add`, which a to-one relationship does not offer.
    const VERBS: {
      name: string;
      available?: unknown;
      collection: { type: GraphQLInputType; description: string };
      singular?: { type: GraphQLInputType; description: string };
    }[] = [
      {
        name: "create",
        available: createInput,
        collection: { type: list(createInput as GraphQLInputType), description: `This will create a new element with a relationship to the current ${defName}` },
        singular: { type: createInput as GraphQLInputType, description: `This will create a new element with a relationship to the current ${defName}` },
      },
      {
        name: "update",
        available: updateInput,
        collection: { type: list(updateInput as GraphQLInputType), description: `This will update any matching elements that have a relationship to the current ${defName}` },
        singular: { type: updateInput as GraphQLInputType, description: `This will update any matching elements that have a relationship to the current ${defName}` },
      },
      {
        name: "add",
        collection: {
          type: addSetType,
          description: throughInput
            ? `This will add any matching existing elements (with optional through attributes) to the current ${defName}`
            : `This will add any matching elements with a relationship to the current ${defName}`,
        },
      },
      {
        name: "set",
        collection: {
          type: addSetType,
          description: throughInput
            ? `This will replace the entire ${relName} set with the matching existing elements (with optional through attributes)`
            : `This will replace the entire ${relName} set with the matching existing elements`,
        },
        singular: { type: filterType, description: `This will associate an existing matching element with the current ${defName}` },
      },
      {
        name: "remove",
        collection: { type: list(filterType), description: `This will remove the relationship from any matching elements from the current ${defName}` },
        singular: { type: GraphQLBoolean, description: `When true, this will disassociate the current ${relName} from the ${defName}` },
      },
      {
        name: "delete",
        collection: { type: list(filterType), description: `This will delete any matching elements that have a relationship with the current ${defName}` },
        singular: { type: filterType, description: `This will delete any matching elements that have a relationship with the current ${defName}` },
      },
      {
        name: "restore",
        collection: { type: list(filterType), description: `This will restore any soft-deleted matching elements related to the current ${defName}` },
        singular: { type: filterType, description: `This will restore the soft-deleted ${relName} related to the current ${defName}` },
      },
      {
        name: "select",
        available: selectInput,
        collection: { type: list(selectInput as GraphQLInputType), description: `This will find matching related elements and run relationship mutations on them without modifying the elements themselves` },
        singular: { type: selectInput as GraphQLInputType, description: `This will find the matching related ${relName} and run relationship mutations on it without modifying the element itself` },
      },
    ];

    for (const verb of VERBS) {
      if ("available" in verb && !verb.available) {
        continue;
      }
      const shape = isCollection ? verb.collection : verb.singular;
      if (!shape) {
        continue;
      }
      fld[verb.name] = shape;
    }
    fields[relName] = {
      type: createGQLInputObject(`${defName}${capitalize(relName)}${capitalize(association.associationType)}Input`, fld, schemaCache, ""),
      description: `This is the mutation object for ${defName}${capitalize(relName)}${capitalize(association.associationType)}`,
    };
    return fields;
  }, def);
}

export default function createMutationInput(instance: GQLManager, defName: string, schemaCache: SchemaCache, inputTypes: SchemaCache["mutationInputs"], options: GqlizeOptions, mutableDefNames: Set<string>) {
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




