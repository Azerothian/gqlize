import {GraphQLBoolean, GraphQLInputObjectType, GraphQLList, type GraphQLFieldConfigArgumentMap, type GraphQLInputFieldConfigMap} from "graphql";
import { isMutationInstanceMethodAllowed } from "@azerothian/utilize/gate";
import { mutationInstanceMethods } from "@azerothian/utilize/exposed-methods";
import { capitalize } from "@azerothian/utilize/utils/word";
import { deprecationFor } from "@azerothian/utilize/utils/deprecation";
import GQLManager from '../manager';
import { GqlizeOptions, SchemaCache } from '../types';
import { bindField } from "./resolvers/bind";
import { recordExternalType } from "./snapshot/ledger";

/**
 * The `apply` argument's input type: one field per exposed instance-method
 * transform, or `undefined` when the model declares none that survive
 * permissions (an input object with no fields is an invalid GraphQL type).
 *
 * A transform's field is typed by its declared `args`. A transform with no args
 * takes `Boolean` — the same default `whereOperators` get as `isolatedFields`,
 * and the same "name it to run it" reading.
 */
export function createInstanceMutationsInput(
  instance: GQLManager, defName: string, schemaCache: SchemaCache, options: GqlizeOptions,
): GraphQLInputObjectType | undefined {
  const definition = instance.getDefinition(defName);
  const methods = mutationInstanceMethods(definition);
  const fields: GraphQLInputFieldConfigMap = {};
  for (const methodName of Object.keys(methods)) {
    if (!isMutationInstanceMethodAllowed(options.permission, defName, methodName)) {
      continue;
    }
    const { args, deprecated } = methods[methodName];
    const description = (definition.comments?.instanceMethods || {})[methodName];
    // `comments.instanceMethods` names these `apply` input fields rather than the
    // instance-method *query* fields (which read `comments.fields`), so
    // `deprecations.instanceMethods` is the group that mirrors it. Every field
    // built here is nullable, so `@deprecated` is legal on all of them.
    const deprecationReason = deprecationFor(definition, "instanceMethods", methodName, deprecated);
    const argNames = Object.keys(args || {});
    if (argNames.length === 0) {
      fields[methodName] = { type: GraphQLBoolean, description, deprecationReason };
      continue;
    }
    // Transform args are passed through verbatim, so their types are whatever
    // the user wrote — always external, exactly as on the query target.
    argNames.forEach((argName) => {
      recordExternalType(schemaCache, args[argName]?.type, {
        via: "definitionExpose",
        defName,
        group: "instanceMethods",
        target: "mutations",
        methodName,
        use: "arg",
        argName,
      });
    });
    fields[methodName] = {
      description,
      deprecationReason,
      type: new GraphQLInputObjectType({
        name: `GQLT${defName}Apply${capitalize(methodName)}`,
        fields: () => args as GraphQLInputFieldConfigMap,
      }),
    };
  }
  if (Object.keys(fields).length === 0) {
    return undefined;
  }
  return new GraphQLInputObjectType({
    name: `GQLT${defName}InstanceMutations`,
    fields: () => fields,
  });
}

export default function createMutationModel(instance: GQLManager, defName: string, schemaCache: SchemaCache, create: boolean, update: boolean, del: boolean, restore: boolean, options: GqlizeOptions = {}) {

  const input = schemaCache.mutationInputs[defName];
  const inp: GraphQLFieldConfigArgumentMap = {};
  // `input.create`/`input.update` are absent when permissions leave the model
  // with nothing writable — there is no type for the argument to reference.
  if (create && input.create) {
    inp.create = {
      type: input.create,
      description: `This will create a new element for ${defName}`,
    };
  }
  if (update && input.update) {
    inp.update = {
      type: input.update,
      description: `This will update a new element for ${defName}`,
    };
  }
  if (update && input.select) {
    inp.select = {
      type: input.select,
      description: `This will find elements for ${defName} and run relationship mutations on them without modifying the elements themselves`,
    };
  }
  // `input.delete` is built unconditionally, so the second half of this test is
  // for the type only — kept in the same shape as `create`/`update` above.
  if (del && input.delete) {
    inp.delete = {
      type: input.delete,
      description: `This will delete a new element for ${defName}`,
    };
  }
  // Restore reuses the delete filter type rather than minting a second identical
  // `[filterType]`: both say "the rows to act on", and one type keeps the schema
  // (and its snapshot) smaller. The caller already gated `restore` on the model
  // actually soft-deleting — there is nothing to undo otherwise.
  if (restore && input.delete) {
    inp.restore = {
      type: input.delete,
      description: `This will restore soft-deleted elements for ${defName}`,
    };
  }
  // Transforms reshape data on its way to a write, so they are only meaningful
  // alongside one. They run inside the mutation's own transaction, after
  // `definition.before` and immediately before the adapter persists.
  if (create || update) {
    const apply = createInstanceMutationsInput(instance, defName, schemaCache, options);
    if (apply) {
      inp.apply = {
        type: apply,
        description: `Instance-method transforms to run against each ${defName} being created or updated, before it is committed`,
      };
    }
  }
  return bindField({
    type: new GraphQLList(schemaCache.types[defName]),
    args: inp,
  }, {kind: "mutationModel", defName}, {instance, options});
}
