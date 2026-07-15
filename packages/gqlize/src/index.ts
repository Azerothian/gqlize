import GqlizeBinding from "./manager";
import { createSchema as buildSchema } from "./graphql/index";
export function createSchema(orm: any, options?: any) {
  return buildSchema(new GqlizeBinding(orm) as any, options);
}
