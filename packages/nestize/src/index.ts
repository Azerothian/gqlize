import "reflect-metadata";

export { NestizeModule } from "./nestize.module";
export type { NestizeAsyncOptions } from "./nestize.module";
export { NestizeService } from "./nestize.service";
export type { MethodKind } from "./nestize.service";
export { NestizeSchemaRegistry } from "./schema-registry";
export { ZodExceptionFilter } from "./zod-exception.filter";
export { NestizeController } from "./controllers";
export { buildOpenApiDocument, setupSwagger } from "./openapi";
export { parseListQuery, parseWhere } from "./query";
export type { ParsedListArgs, ParsedQuery } from "./query";
export {
  ORMIZE,
  NESTIZE_OPTIONS,
} from "./types";
export type {
  NestizeOptions,
  NestizeExposeOptions,
  OpenApiOptions,
} from "./types";
