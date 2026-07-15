import { Permission } from "@azerothian/utilize";

/** DI token for the initialised ormize instance. */
export const ORMIZE = "NESTIZE_ORMIZE";
/** DI token for the resolved `NestizeOptions`. */
export const NESTIZE_OPTIONS = "NESTIZE_OPTIONS";

/** Which exposed model methods (if any) to surface as `_actions` routes. */
export type NestizeExposeOptions = {
  /** Expose `Model.<method>` statics via `/:resource/_actions/:method`. Default `false`. */
  classMethods?: boolean;
  /** Expose `row.<method>()` instance methods via `/:resource/:id/_actions/:method`. Default `false`. */
  instanceMethods?: boolean;
};

/** Options for the generated REST API. */
export type NestizeOptions = {
  /**
   * Permission object (e.g. from `createRoleBasedPermissions`) gating which
   * models/fields/relationships/mutations are exposed — same rules as gqlize.
   * When omitted, nothing is gated.
   */
  permission?: Permission;
  /** Path prefix applied to every generated route (e.g. `api` → `/api/task`). */
  pathPrefix?: string;
  /** Expose nested relationship routes (`/:resource/:id/:relation`). Default `true`. */
  includeRelations?: boolean;
  /** Only register read (GET) routes; write verbs 405. Default `false`. */
  readOnly?: boolean;
  /** Which exposed class/instance methods to surface as `_actions` routes. */
  expose?: NestizeExposeOptions;
};

/** Options for building the OpenAPI document / Swagger UI. */
export type OpenApiOptions = NestizeOptions & {
  /** Document title. Default `"Nestize API"`. */
  title?: string;
  /** Document version. Default `"1.0.0"`. */
  version?: string;
  /** Swagger UI mount path (used by `setupSwagger`). Default `"docs"`. */
  path?: string;
};
