import GqlizeBinding from "./manager";
import { createSchema as buildSchema } from "./graphql/index";
import type { GqlizeOptions } from "./types";

/**
 * `options` is typed rather than `any` on purpose: `permission` is a closed
 * shape, so TypeScript's excess-property check on an object literal catches a
 * misspelled predicate here. That matters more than usual because an absent
 * predicate means ALLOW — a typo fails *open*, silently. `unknownPermissionKeys`
 * covers the same mistake at runtime for JS callers.
 */
export function createSchema(orm: any, options?: GqlizeOptions) {
  return buildSchema(new GqlizeBinding(orm) as any, options);
}
