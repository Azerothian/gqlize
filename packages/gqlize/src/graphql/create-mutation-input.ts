import {
  GraphQLNonNull, GraphQLList, GraphQLInt,
  GraphQLID, GraphQLBoolean,
} from "graphql";
import type { GraphQLInputFieldConfig, GraphQLInputFieldConfigMap, GraphQLInputType, GraphQLNullableInputType, ThunkObjMap } from "graphql";

import createGQLInputObject from "./create-gql-input-object";
import { deprecationFor, isInputFieldWritable, isMutationAllowed, isMutationInstanceMethodAllowed, isRelationshipVerbAllowed, isThroughInputField, isThroughMode } from "@azerothian/utilize";
import { mutationInstanceMethods } from "@azerothian/utilize/exposed-methods";
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
/**
 * Whether a column becomes a mutation input field: structurally writable,
 * permitted for this kind of write, and not in `ignoreFields` — which is
 * documented as excluded from every generated type, inputs included.
 */
function isColumnInput(definition: Definition, defName: string, fieldName: string, kind: "create" | "update", defFields: DefinitionFields, options: GqlizeOptions) {
  return !definition.ignoreFields?.includes(fieldName)
    && isInputFieldWritable(options.permission, defName, fieldName, kind, defFields[fieldName]);
}

function hasInputFields(defName: string, definition: Definition, defFields: DefinitionFields, associations: {[relName: string]: Association}, mutableDefNames: Set<string>, forceOptional: boolean, options: GqlizeOptions, plan: MutationInputPlan) {
  const kind = forceOptional ? "update" : "create";
  const hasWritableField = Object.keys(defFields).some((fieldName) => {
    return isColumnInput(definition, defName, fieldName, kind, defFields, options);
  });
  if (hasWritableField) {
    return true;
  }
  // A relationship contributes a field when at least one of its verbs is
  // offered: exactly the condition `generateInputFields` adds it under, which
  // it must stay, or this would promise a field the builder leaves out and the
  // input object would be empty.
  return Object.keys(associations).some((relName) => {
    const association = associations[relName];
    return isRelationshipInputAllowed(options, defName, relName, forceOptional)
      && mutableDefNames.has(association.target)
      && relationshipOffersAVerb(options, association, plan);
  });
}

/**
 * The `through` field of a `belongsToMany` add/set entry, typed by the join
 * model's columns. Only called in through mode (`isThroughMode`): the join model
 * is one the author registered and the permission bag lets it be seen.
 *
 * The columns offered are the ones `isThroughInputField` accepts — the join
 * model's create-input permission, minus the two join keys, every primary and
 * foreign key (the payload is not run through the id codec) and `ignoreFields`.
 * The write engine drops the same keys again on every route.
 *
 * Returns `undefined` when no column qualifies: an input object with no fields
 * is not valid GraphQL, and there would be nothing to send anyway.
 */
function createThroughType(instance: GQLManager, defName: string, relName: string, association: Association, schemaCache: SchemaCache, options: GqlizeOptions): GraphQLInputType | undefined {
  const through = association.through as string;
  const joinDef = instance.getDefinition(through);
  const joinKeys = [association.foreignKey, association.otherKey].filter(Boolean) as string[];
  const joinFields = instance.getFields(through);
  const fieldNames = Object.keys(joinFields).filter((fieldName) =>
    isThroughInputField(options.permission, through, fieldName, joinFields[fieldName], joinKeys, joinDef?.ignoreFields));
  if (fieldNames.length === 0) {
    return undefined;
  }
  return createGQLInputObject(`${defName}${capitalize(relName)}ThroughInput`, () => fieldNames.reduce((fields, fieldName) => {
    const field = joinFields[fieldName];
    fields[fieldName] = {
      type: instance.getGraphQLInputType(through, `${fieldName}Optional`, field.type) as GraphQLInputType,
      description: (joinDef.comments?.fields || {})[fieldName] || field.description,
      deprecationReason: deprecationFor(joinDef, "fields", fieldName, field.deprecated),
    };
    return fields;
  }, {} as GraphQLInputFieldConfigMap), schemaCache, `Column values written on the ${through} join row`);
}

/**
 * Which relationship verbs a target's permissions allow, decided from the
 * permission bag alone so `hasInputFields` can ask before any type exists.
 * `create`, `update` and `select` also need the target's own create/update
 * input, which the plan answers for; the rule itself is utilize's
 * `isRelationshipVerbAllowed`, shared with nestize.
 */
function relationshipGates(options: GqlizeOptions, association: Association) {
  return {
    link: isRelationshipVerbAllowed(options.permission, association, "add"),
    delete: isRelationshipVerbAllowed(options.permission, association, "delete"),
    restore: isRelationshipVerbAllowed(options.permission, association, "restore"),
  };
}

function relationshipOffersAVerb(options: GqlizeOptions, association: Association, plan: MutationInputPlan) {
  const gates = relationshipGates(options, association);
  // `update`/`select` need the target's update permission, under which `link` is already true.
  return gates.link || gates.delete || gates.restore || plan.creatable(association.target);
}

/** Whether each model gets a create input and an update input, answered once per schema build. */
export interface MutationInputPlan {
  creatable(defName: string): boolean;
  updatable(defName: string): boolean;
}

/**
 * Decide, for every mutable model, whether its create and update inputs exist.
 *
 * The question recurses: a model with no writable column of its own still has
 * an input when one of its relationships offers a verb, and `create` is offered
 * only when the target itself has a create input. The answers are memoised, and
 * a model already being decided counts as having no input, so a cycle of models
 * that exist only through each other's `create` settles on "none" rather than
 * recursing forever. `createMutationInput` builds exactly what this decides.
 */
export function createMutationInputPlan(instance: GQLManager, options: GqlizeOptions, mutableDefNames: Set<string>): MutationInputPlan {
  const memo = new Map<string, boolean>();
  const plan: MutationInputPlan = {
    creatable: (defName) => decide(defName, false),
    updatable: (defName) => decide(defName, true),
  };
  function decide(defName: string, forceOptional: boolean): boolean {
    const key = `${forceOptional ? "update" : "create"}:${defName}`;
    const known = memo.get(key);
    if (known !== undefined) {
      return known;
    }
    memo.set(key, false);
    const answer = mutableDefNames.has(defName)
      && isMutationAllowed(options.permission, defName, forceOptional ? "update" : "create")
      && hasInputFields(defName, instance.getDefinition(defName), instance.getFields(defName),
        instance.getAssociations(defName), mutableDefNames, forceOptional, options, plan);
    memo.set(key, answer);
    return answer;
  }
  return plan;
}

//(instance, defName, fields, relationships, inputTypes, false)
export function generateInputFields(instance: GQLManager, defName: string, definition: Definition, defFields: DefinitionFields, associations: {[relName: string]: Association}, inputTypes: SchemaCache["mutationInputs"], schemaCache: SchemaCache, forceOptional: boolean, options: GqlizeOptions) {
  const def = waterfallSync(Object.keys(defFields), (fieldName: string, fields: GraphQLInputFieldConfigMap) => {
    const doNotSkip = isColumnInput(definition, defName, fieldName, forceOptional ? "update" : "create", defFields, options);
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
    const gates = relationshipGates(options, association);
    const isCollection = association.associationType === "hasMany" || association.associationType === "belongsToMany";
    // A belongsToMany whose join model is registered and visible takes
    // `{ where, through }` entries on add/set, `through` writing join-row
    // columns. Every other collection, including a plain belongsToMany, takes
    // the bare filter — the write engine decides the same way.
    const throughMode = isThroughMode(options.permission, association);
    const throughType = throughMode
      ? createThroughType(instance, defName, relName, association, schemaCache, options)
      : undefined;
    const throughInput = throughMode
      ? createGQLInputObject(`${defName}${capitalize(relName)}AddThrough`, {
        where: {
          type: filterType,
          description: "Filter used to find the existing elements to associate",
        },
        ...(throughType ? {
          through: {
            type: throughType,
            description: "Attribute values to write on the join table for the associated elements",
          },
        } : {}),
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
    // `available` gates a verb on the input type it needs existing at all, or
    // on the target's own operation permission where it needs no input type;
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
        available: gates.link,
        collection: {
          type: addSetType,
          description: throughInput
            ? `This will add any matching existing elements (with optional through attributes) to the current ${defName}`
            : `This will add any matching elements with a relationship to the current ${defName}`,
        },
      },
      {
        name: "set",
        available: gates.link,
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
        available: gates.link,
        collection: { type: list(filterType), description: `This will remove the relationship from any matching elements from the current ${defName}` },
        singular: { type: GraphQLBoolean, description: `When true, this will disassociate the current ${relName} from the ${defName}` },
      },
      {
        // `delete` and `restore` take only the target's filter type, so unlike
        // `create`/`update` there is no target input whose absence would gate
        // them: they are gated on the target's own operation here, or a caller
        // denied `mutationDelete` on a model could still delete its rows by
        // reaching them through a relationship.
        name: "delete",
        available: gates.delete,
        collection: { type: list(filterType), description: `This will delete any matching elements that have a relationship with the current ${defName}` },
        singular: { type: filterType, description: `This will delete any matching elements that have a relationship with the current ${defName}` },
      },
      {
        name: "restore",
        available: gates.restore,
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
    if (Object.keys(fld).length === 0) {
      // Every verb denied: no field, rather than an empty input object.
      // `hasInputFields` counts the relationship out under the same condition.
      return fields;
    }
    fields[relName] = {
      type: createGQLInputObject(`${defName}${capitalize(relName)}${capitalize(association.associationType)}Input`, fld, schemaCache, ""),
      description: `This is the mutation object for ${defName}${capitalize(relName)}${capitalize(association.associationType)}`,
    };
    return fields;
  }, def);
}

/** Whether the model exposes an `apply` transform the permissions leave in (see `createInstanceMutationsInput`). */
export function hasAllowedTransform(definition: Definition, defName: string, options: GqlizeOptions): boolean {
  return Object.keys(mutationInstanceMethods(definition))
    .some((methodName) => isMutationInstanceMethodAllowed(options.permission, defName, methodName));
}

export default function createMutationInput(instance: GQLManager, defName: string, schemaCache: SchemaCache, inputTypes: SchemaCache["mutationInputs"], options: GqlizeOptions, plan: MutationInputPlan) {
  const fields = instance.getFields(defName);
  const associations = instance.getAssociations(defName);
  const definition = instance.getDefinition(defName);
  // Permissions can leave a model with nothing writable at all; the resulting
  // input object would have no fields and make the whole schema invalid, so it
  // is not built and the mutations that would take it are omitted. The plan
  // decides that for every model at once, because whether a relationship can
  // `create` depends on whether its target gets an input.
  const doNotSkipUpdate = plan.updatable(defName);
  const doNotSkipCreate = plan.creatable(defName);
  const required = doNotSkipCreate ? createGQLInputObject(`${defName}RequiredInput`, function() {
    return generateInputFields(instance, defName, definition, fields, associations, inputTypes, schemaCache, false, options);
  }, schemaCache, "") : undefined;
  const optional = doNotSkipUpdate ? createGQLInputObject(`${defName}OptionalInput`, function() {
    return generateInputFields(instance, defName, definition, fields, associations, inputTypes, schemaCache, true, options);
  }, schemaCache, "") : undefined;
  const filterType = instance.getFilterGraphQLType(defName);
  // `update` and `select` share the same where/limit/input shape — only the
  // name and descriptions differ. `input` is left off when there is no update
  // input to give it (see `transformOnly`).
  const whereInputObject = (name: string, whereDesc: string, limitDesc: string, inputDesc: string) =>
    new GraphQLList(createGQLInputObject(name, {
      where: { type: filterType, description: whereDesc },
      limit: { type: GraphQLInt, description: limitDesc },
      ...(optional ? { input: { type: optional, description: inputDesc } } : {}),
    }, schemaCache, ""));
  // A model may update rows but have nothing to write by hand, with its
  // permitted writes all in `apply` transforms. It still gets `update`, as
  // `where` and `limit` only, or the transforms could never run on a row that
  // already exists. `select` stays tied to the update input: without
  // relationship mutations to run it would do nothing.
  const transformOnly = !optional && isMutationAllowed(options.permission, defName, "update") && hasAllowedTransform(definition, defName, options);
  return {
    required, optional,
    create: required ? new GraphQLList(required) : undefined,
    update: optional || transformOnly ? whereInputObject(`${defName}UpdateInput`,
      "If provided this will restrict to changes to only the elements that match",
      "If provided this will restrict the changes to only the first amount of ${limit}",
      "This is the input for the data",
    ) : undefined,
    // `select` finds matching elements and runs relationship mutations on them
    // (via `input`) without modifying the elements themselves.
    select: optional ? whereInputObject(`${defName}SelectInput`,
      "Filter used to find the existing elements to run relationship mutations on",
      "If provided this will restrict the selection to only the first amount of ${limit}",
      "Relationship mutations to run on the selected elements. Scalar fields are ignored — the selected elements are not modified",
    ) : undefined,
    delete: new GraphQLList(filterType),
  };
}




