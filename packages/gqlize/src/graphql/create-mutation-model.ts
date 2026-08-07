
import {GraphQLList} from "graphql";
import GQLManager from '../manager';
import { GqlizeOptions, SchemaCache } from '../types';
import { bindField } from "./resolvers/bind";

export default function createMutationModel(instance: GQLManager, defName: string, schemaCache: SchemaCache, create: any, update: any, del: any, options: GqlizeOptions = {}) {

  const input = schemaCache.mutationInputs[defName];
  let inp: any = {};
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
  if (del) {
    inp.delete = {
      type: input.delete,
      description: `This will delete a new element for ${defName}`,
    };
  }
  return bindField({
    type: new GraphQLList(schemaCache.types[defName]),
    args: inp,
  }, {kind: "mutationModel", defName}, {instance, options});
}
