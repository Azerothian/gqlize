import { createNameResolver, type NameResolver } from "@azerothian/utilize/utils/name-resolver";
import type { Ormize } from "@azerothian/ormize";
import { generateZodSchemas } from "@azerothian/ormize-zod4";
import type { ZodObjectMap } from "@azerothian/ormize-zod4";
import type { Permission } from "@azerothian/utilize";
import type { TemporalizeOptions } from "./types";
import { listModels } from "./queue";

export type SchemaSet = { entity: ZodObjectMap; create: ZodObjectMap; update: ZodObjectMap };

/**
 * Resolves a model name arriving from workflow input, and supplies the
 * entity/create/update Zod schemas used for input validation and output
 * projection.
 *
 * Unlike nestize — which fixes one `permission` at module registration — the
 * permission here is derived per call from the activity's `context`, so schema
 * sets are memoized by permission object identity. Return a stable (per-role)
 * permission object from `resolvePermission` and the schemas are built once;
 * returning a freshly-constructed object on every call re-derives them each time.
 */
export class TemporalizeRegistry {
  // The model name arrives from workflow input, so resolving it is a security
  // control — see `createNameResolver`, which is shared with nestize's
  // equivalent because both must keep the same two properties.
  private models: NameResolver;
  private byPermission = new WeakMap<object, SchemaSet>();
  private unscoped?: SchemaSet;

  constructor(private readonly orm: Ormize, private readonly options: TemporalizeOptions = {}) {
    this.models = createNameResolver(listModels(orm, options));
  }

  /** Resolve an untrusted model name to its definition name, or `undefined`. */
  resolve(model: unknown): string | undefined {
    return this.models.resolve(model);
  }

  /** All models temporalize generates activities for. */
  names(): string[] {
    return listModels(this.orm, this.options);
  }

  schemas(permission?: Permission): SchemaSet {
    const opts = { permission, includeRelations: this.options.includeRelations !== false };
    if (!permission) {
      return (this.unscoped = this.unscoped || generateZodSchemas(this.orm, opts));
    }
    const cached = this.byPermission.get(permission);
    if (cached) {
      return cached;
    }
    const built = generateZodSchemas(this.orm, opts);
    this.byPermission.set(permission, built);
    return built;
  }
}
