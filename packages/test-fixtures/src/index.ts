// The models both the ormize and gqlize suites build against.
//
// One set, not two: these were near-identical copies (91-96% the same) that had
// already drifted — the ormize copy carried a top-level `tableName` that is not
// a `Definition` field and was silently ignored, which the gqlize copy had
// caught and removed. Sharing them means a mistake like that is found once.
//
// Typed `const x: Definition = {...}` rather than `{...} as Definition` on
// purpose: the annotation turns on excess-property checking (which is what
// caught that dead key) and threads contextual types through every nested hook
// and method below, so each picks up its real parameter types.
export { default as TaskDef } from "./models/task";
export { default as ItemDef } from "./models/item";
export { default as TaskItemDef } from "./models/task-item";
