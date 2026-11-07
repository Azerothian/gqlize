// Barrel re-export for the engine sub-modules. Each module was extracted from
// `manager.ts` as a pure move: same logic, same order, same comments.

export { sequelizeHookList, hookList, gqlizeHookList, WRITE_HOOKS, OPAQUE_READ_HOOKS,
  sequelizeHookSet, relationshipTypes, SINGULAR_ACCESSOR, runHookEntry } from "./constants";
export type { HookFunction, WiredRelationship } from "./constants";

export { warnDefinitionInstanceHooks, createHook, createInstanceHook,
  installInstanceHooks, runHook, applyEagerAfterFind } from "./hooks";
export type { HookHost } from "./hooks";

export { resolveRowScope, reassertRowScope, scopeNativeWhere, scopedWriteWhere,
  assertRowsInScope, withScopeFor, scopeMiss, ScopeDeniedError, ScopeEscapeError } from "./scope-bridge";
export type { ScopeHost } from "./scope-bridge";

export { tagRelation, writeFootprint, readTags, cachedCount, cachedFindAll } from "./read-cache-bridge";
export type { ReadCacheHost } from "./read-cache-bridge";

export { validateRelationship, validateCrossAdapterKeys, buildCrossAdapterAssociation,
  processRelationship, generateJoinModels } from "./relationships";
export type { RelationshipHost } from "./relationships";

export { countableFrom, createResolveContext, cursorOffset, expandComputedOrder,
  resolveClassMethod, resolveManyRelationship, resolveSingleRelationship,
  resolveFindAll } from "./resolution";
export type { ResolutionHost } from "./resolution";

export { mutationEntry, processInputs, processRelationshipMutation,
  applyInstanceTransforms, processCreate, processUpdate, processSelect,
  processDelete, processRestore } from "./mutations";
export type { MutationEntryHost } from "./mutations";

export { transaction, runWithContext, getContext, withTransaction } from "./transactions";
export type { TransactionHost } from "./transactions";
