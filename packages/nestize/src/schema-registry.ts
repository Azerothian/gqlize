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
  // Null-prototype map: the `:resource` URL segment is attacker-controlled, so a
  // plain object would let keys like `constructor`/`__proto__`/`hasOwnProperty`
  // resolve to inherited members instead of `undefined`, bypassing the
  // unknown-resource 404 path.
  private resourceMap: { [resource: string]: string } = Object.create(null);

  constructor(
    @Inject(ORMIZE) private readonly orm: Ormize,
    @Inject(NESTIZE_OPTIONS) private readonly options: NestizeOptions
  ) {
    this.schemas = generateZodSchemas(this.orm, { permission: this.options.permission });
    const defs = this.orm.getDefinitions() || {};
    for (const name of Object.keys(defs)) {
      if (!isModelAllowed(this.options.permission, name)) {
        continue;
      }
      this.resourceMap[name.toLowerCase()] = name;
      this.resourceMap[name] = name;
    }
  }

  /** Resolve a `:resource` segment to its definition name, or `undefined`. */
  resolve(resource: string): string | undefined {
    if (resource === undefined || resource === null) {
      return undefined;
    }
    return this.resourceMap[resource] || this.resourceMap[String(resource).toLowerCase()];
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
