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
  // Null-prototype map: the model name arrives from workflow input, so a plain
  // object would let keys like `constructor`/`__proto__`/`hasOwnProperty` resolve
  // to inherited members instead of `undefined`, bypassing the unknown-model check.
  private modelMap: { [key: string]: string } = Object.create(null);
  private byPermission = new WeakMap<object, SchemaSet>();
  private unscoped?: SchemaSet;

  constructor(private readonly orm: Ormize, private readonly options: TemporalizeOptions = {}) {
    for (const name of listModels(orm, options)) {
      this.modelMap[name] = name;
      this.modelMap[name.toLowerCase()] = name;
    }
  }

  /** Resolve an untrusted model name to its definition name, or `undefined`. */
  resolve(model: unknown): string | undefined {
    if (typeof model !== "string" || model === "") {
      return undefined;
    }
    return this.modelMap[model] || this.modelMap[model.toLowerCase()];
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
    const cached = this.byPermission.get(permission as object);
    if (cached) {
      return cached;
    }
    const built = generateZodSchemas(this.orm, opts);
    this.byPermission.set(permission as object, built);
    return built;
  }
}
