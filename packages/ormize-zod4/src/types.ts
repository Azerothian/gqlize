import { z } from "zod";
import { Permission } from "@azerothian/utilize";

/** Map of model name → generated Zod object schema. */
export type ZodObjectMap = { [modelName: string]: z.ZodObject<any> };

/** The three schema projections generated per model. */
export type GeneratedZodSchemas = {
  /** Full fetched-row schema (all exposed columns + optional nested relations). */
  entity: ZodObjectMap;
  /** Create-input schema (required unless nullable/defaulted/auto/PK). */
  create: ZodObjectMap;
  /** Update-input schema (all fields optional). */
  update: ZodObjectMap;
};

export type GenerateOptions = {
  /**
   * Permission object (e.g. from `createRoleBasedPermissions`) gating which
   * models/fields/relationships/mutations appear — same rules as gqlize. When
   * omitted, nothing is gated.
   */
  permission?: Permission;
  /** Include nested relation fields (via `z.lazy`) in the entity schema. Default `true`. */
  includeRelations?: boolean;
  /** Translate Sequelize `validate` rules into Zod refinements. Default `true`. */
  translateValidators?: boolean;
};
