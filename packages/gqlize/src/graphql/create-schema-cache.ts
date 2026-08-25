import { SchemaCache } from '../types';
export default function createSchemaCache() {
  return {
    types: {},
    typeFields: {},
    lists: {},
    orderBy: {},
    classMethodQueries: {},
    classMethodMutations: {},
    mutationInputs: {},
    mutationModels: {},
    mutationInputFields: {},
    basicFields: {},
    complexFields: {},
    relatedFields: {},
  } as SchemaCache; // the assertion is load-bearing under ts7, which does not infer it
}
