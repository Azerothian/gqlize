/** Shared type aliases for the mutation test suites. */
export type Edge<T> = {node: T};
export type Connection<T> = {edges: Edge<T>[]};
export type TaskRow = {id: string; name: string};
export type TaskOptionsRow = {id: string; name: string; options: {hidden?: string; hidden2?: string}};
export type TaskNullCheckRow = {id: string; nullCheck: string | null};
export type TaskIntZeroRow = {id: string; intZeroCheck: number};
export type TaskMutationCheckRow = {id: string; name: string; mutationCheck: string};
export type TaskItemRow = {id: string; name: string; parentId: string | null};
export type TaskDeleteRow = {id: string};
export type TaskWithTaskItemRow = {id: string; task: {id: string}};
export type TaskItemsConnectionRow = {id: string; items: Connection<{id: string; name: string}>};
export type TaskWithNestedItemsRow = {id: string; items: Connection<{id: string}>};
export type ItemWithHasOneRow = {id: string; hasOne: {id: string; name: string; hasOneId: string}};
export type ItemWithBelongsToRow = {id: string; belongsTo: {id: string; name: string}; belongsToId: string};
export type ParentWithChildrenRow = {id: string; name?: string; children: Connection<{id: string; name?: string; parentId?: string}>};
export type IntrospectionInputFields = {__type: {inputFields: {name: string}[]}};
