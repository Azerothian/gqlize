/**
 * Grouping objects (`QueryModels`, `MutationClassMethods`, the per-model
 * class-method containers) exist only so their children have something to
 * resolve against. They carry no data of their own.
 */
export function buildContainerResolver() {
  return function resolve() {
    return {};
  };
}
