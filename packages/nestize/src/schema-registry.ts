import { createNameResolver, type NameResolver } from "@azerothian/utilize/utils/name-resolver";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { Ormize } from "@azerothian/ormize";
import { generateZodSchemas } from "@azerothian/ormize-zod4";
import type { GeneratedZodSchemas } from "@azerothian/ormize-zod4";
import { isModelAllowed } from "@azerothian/utilize";
import { NESTIZE_OPTIONS, ORMIZE, type NestizeOptions } from "./types";

/**
 * Computes the entity/create/update Zod schemas once (from the initialised ormize
 * instance, honoring the configured permission) and maps a REST `resource`
 * segment (lower-cased model name, or the exact model name) to its definition
 * name. Shared by the service (validation) and the OpenAPI builder (components).
 */
@Injectable()
export class NestizeSchemaRegistry {
  private schemas!: GeneratedZodSchemas;
  // The `:resource` URL segment is attacker-controlled, so resolving it is a
  // security control — see `createNameResolver`, which is shared with
  // temporalize's equivalent because both must keep the same two properties.
  private resources!: NameResolver;

  constructor(
    @Inject(ORMIZE) private readonly orm: Ormize,
    @Inject(NESTIZE_OPTIONS) private readonly options: NestizeOptions
  ) {
    this.schemas = generateZodSchemas(this.orm, { permission: this.options.permission });
    const defs = this.orm.getDefinitions() || {};
    this.resources = createNameResolver(
      Object.keys(defs).filter((name) => isModelAllowed(this.options.permission, name)),
    );
  }

  /** Resolve a `:resource` segment to its definition name, or `undefined`. */
  resolve(resource: unknown): string | undefined {
    return this.resources.resolve(resource);
  }

  /** All exposed model (definition) names. */
  names(): string[] {
    return Object.keys(this.schemas.entity);
  }

  entity(name: string): z.ZodObject<z.ZodRawShape> | undefined {
    return this.schemas.entity[name];
  }
  create(name: string): z.ZodObject<z.ZodRawShape> | undefined {
    return this.schemas.create[name];
  }
  update(name: string): z.ZodObject<z.ZodRawShape> | undefined {
    return this.schemas.update[name];
  }

  all(): GeneratedZodSchemas {
    return this.schemas;
  }
}
