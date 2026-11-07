/**
 * Type barrel — re-exports every type from the themed modules so that
 * `@azerothian/utilize/types/index` remains the single import for consumers.
 */

// Re-exported so `./types/index` is a complete type barrel: `GqlizeOptions`
// names `Permission`, and the packages that build on these types import both.
export type { Permission, PermissionContext } from "../gate";
// `scope`'s vocabulary. `PortableWhere` is declared in `../gate` rather than
// here so the gate stays importable on its own, but it belongs to this module's
// surface: it is the caller-side counterpart of `AdapterWhere` below.
export type {
  PortableWhere, ScopeOperation, ScopeResult, ScopePredicate, ResolvedScope,
} from "../gate";

export * from "./primitives";
export * from "./relationships";
export * from "./definitions";
export * from "./selection";
export * from "./codecs";
export * from "./cache";
export * from "./options";
export * from "./adapter";
export * from "./orm";
export * from "./data-type";
