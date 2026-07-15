import { z } from "zod";
import {
  isModelAllowed,
  isFieldAllowed,
  isRelationshipAllowed,
  isMutationAllowed,
  isInputFieldAllowed,
} from "@azerothian/utilize";
import { descriptorToZod } from "./type-mapper";
import { applyValidators } from "./validators";
import { GeneratedZodSchemas, GenerateOptions, ZodObjectMap } from "./types";

/**
 * Generate Zod v4 `entity` / `create` / `update` schemas from a live, initialised
 * ormize instance. Honors the same permission rules as gqlize (denied
 * models/fields/relationships/mutations are absent from the output).
 *
 * The ormize instance MUST be initialised (`await orm.initialise()`) first — the
 * field metadata is read from the materialized backend models.
 */
export function generateZodSchemas(orm: any, options: GenerateOptions = {}): GeneratedZodSchemas {
  const { permission, includeRelations = true, translateValidators = true } = options;

  const defs = (orm.getDefinitions && orm.getDefinitions()) || {};
  const allNames = Object.keys(defs);
  if (allNames.length === 0) {
    throw new Error(
      "generateZodSchemas: no model definitions found. Define models and call `await orm.initialise()` before generating."
    );
  }
  const modelNames = allNames.filter((name) => isModelAllowed(permission, name));

  const entity: ZodObjectMap = {};
  const create: ZodObjectMap = {};
  const update: ZodObjectMap = {};

  for (const name of modelNames) {
    const def = defs[name] || {};
    const ignore = new Set<string>(def.ignoreFields || []);
    const authored = def.define || {};

    let fields: { [f: string]: any };
    try {
      fields = orm.getFields(name) || {};
    } catch (e: any) {
      throw new Error(
        `generateZodSchemas: could not read fields for "${name}". Ensure \`await orm.initialise()\` has run. (${e?.message || e})`
      );
    }
    const fieldNames = Object.keys(fields).filter((f) => !ignore.has(f));

    // Base (unwrapped) Zod schema for a column, with validators applied.
    const baseOf = (fieldName: string): z.ZodTypeAny => {
      const meta = fields[fieldName];
      const descriptor = orm.mapDataType(meta.type);
      let s = descriptorToZod(descriptor);
      if (translateValidators) {
        const v = authored[fieldName] && authored[fieldName].validate;
        if (v) s = applyValidators(s, v, descriptor.type);
      }
      return s;
    };

    // --- entity ---
    const entityShape: { [k: string]: z.ZodTypeAny } = {};
    for (const fieldName of fieldNames) {
      if (!isFieldAllowed(permission, name, fieldName)) continue;
      let s = baseOf(fieldName);
      if (fields[fieldName].allowNull) s = s.nullable();
      entityShape[fieldName] = s;
    }
    if (includeRelations && orm.getAssociations) {
      const associations = orm.getAssociations(name) || {};
      for (const relName of Object.keys(associations)) {
        const assoc = associations[relName];
        if (!isRelationshipAllowed(permission, name, relName, assoc.target)) continue;
        const single = assoc.associationType === "belongsTo" || assoc.associationType === "hasOne";
        // Lazy so circular relations (A <-> B) resolve; falls back to unknown if
        // the target model is permission-denied / absent.
        const targetRef: z.ZodTypeAny = z.lazy(() => entity[assoc.target] || z.unknown());
        entityShape[relName] = single
          ? targetRef.nullable().optional()
          : z.array(targetRef).optional();
      }
    }
    entity[name] = z.object(entityShape);

    // --- create / update (scalar columns only) ---
    const createShape: { [k: string]: z.ZodTypeAny } = {};
    const updateShape: { [k: string]: z.ZodTypeAny } = {};
    for (const fieldName of fieldNames) {
      const meta = fields[fieldName];
      let base = baseOf(fieldName);
      if (meta.allowNull) base = base.nullable();

      if (isInputFieldAllowed(permission, name, fieldName, "create")) {
        const required =
          !meta.allowNull &&
          meta.defaultValue === undefined &&
          !meta.autoPopulated &&
          !meta.primaryKey;
        createShape[fieldName] = required ? base : base.optional();
      }
      if (isInputFieldAllowed(permission, name, fieldName, "update")) {
        updateShape[fieldName] = base.optional();
      }
    }
    if (isMutationAllowed(permission, name, "create")) {
      create[name] = z.object(createShape);
    }
    if (isMutationAllowed(permission, name, "update")) {
      update[name] = z.object(updateShape);
    }
  }

  return { entity, create, update };
}
