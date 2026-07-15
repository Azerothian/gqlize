import { Controller, DynamicModule, Module, Provider, Type } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { NestizeService } from "./nestize.service";
import { NestizeSchemaRegistry } from "./schema-registry";
import { ZodExceptionFilter } from "./zod-exception.filter";
import { NestizeController } from "./controllers";
import { NestizeOptions, NESTIZE_OPTIONS, ORMIZE } from "./types";

export type NestizeAsyncOptions = {
  imports?: any[];
  inject?: any[];
  useFactory: (
    ...args: any[]
  ) => { orm: any; options?: NestizeOptions } | Promise<{ orm: any; options?: NestizeOptions }>;
};

// Apply the optional pathPrefix by subclassing the base controller and (re)applying
// `@Controller(prefix)` — this overrides the base's empty path without mutating the
// shared base metadata (so multiple modules with different prefixes coexist).
function buildControllers(prefix?: string): Type<any>[] {
  if (!prefix) {
    return [NestizeController];
  }
  class PrefixedNestizeController extends NestizeController {}
  Controller(prefix)(PrefixedNestizeController);
  return [PrefixedNestizeController];
}

const sharedProviders: Provider[] = [
  NestizeSchemaRegistry,
  NestizeService,
  { provide: APP_FILTER, useClass: ZodExceptionFilter },
];

/**
 * NestJS module that exposes an `@azerothian/ormize` instance as a generic REST
 * API. Register with `NestizeModule.forRoot(orm, options)` (or `forRootAsync`).
 */
@Module({})
export class NestizeModule {
  static forRoot(orm: any, options: NestizeOptions = {}): DynamicModule {
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
      controllers: [NestizeController],
      providers: [
        resolved,
        {
          provide: ORMIZE,
          inject: ["NESTIZE_ASYNC_RESULT"],
          useFactory: (r: { orm: any }) => r.orm,
        },
        {
          provide: NESTIZE_OPTIONS,
          inject: ["NESTIZE_ASYNC_RESULT"],
          useFactory: (r: { options?: NestizeOptions }) => r.options || {},
        },
        ...sharedProviders,
      ],
      exports: [NestizeService],
    };
  }
}
