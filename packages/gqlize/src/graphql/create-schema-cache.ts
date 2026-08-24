import { SchemaCache } from '../types';
export default function createSchemaCache() {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- ts7 needs it
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
  } as SchemaCache;
}
