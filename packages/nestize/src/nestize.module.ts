import { Controller, DynamicModule, Module, Provider, Type } from "@nestjs/common";
import type { FactoryProvider, ModuleMetadata } from "@nestjs/common";
import type { Ormize } from "@azerothian/ormize";
import { NestizeService } from "./nestize.service";
import { NestizeSchemaRegistry } from "./schema-registry";
import { NestizeController } from "./controllers";
import { NestizeOptions, NESTIZE_OPTIONS, ORMIZE } from "./types";

/** What `useFactory` must resolve to: the initialised instance, plus options. */
export type NestizeAsyncResult = { orm: Ormize; options?: NestizeOptions };

export type NestizeAsyncOptions = {
  imports?: ModuleMetadata["imports"];
  inject?: FactoryProvider["inject"];
  /** `...args: any[]` mirrors Nest's own factory contract: what is injected is `inject`'s business. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches @nestjs/common's own `FactoryProvider.useFactory: (...args: any[]) => T | Promise<T>` exactly; narrowing it here would just be a cast at the call site instead
  useFactory: (...args: any[]) => NestizeAsyncResult | Promise<NestizeAsyncResult>;
  /**
   * Route path prefix. Must be supplied here (not via the async `options`)
   * because Nest needs `controllers` synchronously at module-definition time,
   * before the async factory resolves. A `pathPrefix` returned from `useFactory`
   * cannot influence route mounting and is ignored.
   */
  pathPrefix?: string;
};

// Apply the optional pathPrefix by subclassing the base controller and (re)applying
// `@Controller(prefix)` — this overrides the base's empty path without mutating the
// shared base metadata (so multiple modules with different prefixes coexist).
function buildControllers(prefix?: string): Type<NestizeController>[] {
  if (!prefix) {
    return [NestizeController];
  }
  class PrefixedNestizeController extends NestizeController {}
  Controller(prefix)(PrefixedNestizeController);
  return [PrefixedNestizeController];
}

// ZodExceptionFilter is applied at the controller level (@UseFilters) rather than
// as a global APP_FILTER, so it only reshapes errors from Nestize's own routes.
const sharedProviders: Provider[] = [
  NestizeSchemaRegistry,
  NestizeService,
];

/**
 * NestJS module that exposes an `@azerothian/ormize` instance as a generic REST
 * API. Register with `NestizeModule.forRoot(orm, options)` (or `forRootAsync`).
 */
@Module({})
export class NestizeModule {
  static forRoot(orm: Ormize, options: NestizeOptions = {}): DynamicModule {
    return {
      module: NestizeModule,
      controllers: buildControllers(options.pathPrefix),
      providers: [
        { provide: ORMIZE, useValue: orm },
        { provide: NESTIZE_OPTIONS, useValue: options },
        ...sharedProviders,
      ],
      exports: [NestizeService],
    };
  }

  static forRootAsync(async: NestizeAsyncOptions): DynamicModule {
    const resolved: Provider = {
      provide: "NESTIZE_ASYNC_RESULT",
      inject: async.inject || [],
      useFactory: async.useFactory,
    };
    return {
      module: NestizeModule,
      imports: async.imports || [],
      controllers: buildControllers(async.pathPrefix),
      providers: [
        resolved,
        {
          provide: ORMIZE,
          inject: ["NESTIZE_ASYNC_RESULT"],
          useFactory: (r: NestizeAsyncResult) => r.orm,
        },
        {
          provide: NESTIZE_OPTIONS,
          inject: ["NESTIZE_ASYNC_RESULT"],
          useFactory: (r: NestizeAsyncResult) => r.options || {},
        },
        ...sharedProviders,
      ],
      exports: [NestizeService],
    };
  }
}
