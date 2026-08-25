import type { Definition, Permission, PermissionContext } from "@azerothian/utilize";

export type QueueNameInput = {
  /** Definition (model) name, e.g. `"Task"`. */
  model: string;
  /** Adapter the model is registered against, from `orm.defsAdapters[model]`. */
  datasource: string;
  definition: Definition;
};

export interface TemporalizeOptions {
  /** Prepended to every generated queue name. */
  queuePrefix?: string;
  /** Joins the queue name segments. Defaults to `"."`. */
  queueSeparator?: string;
  /** Include the adapter name in the queue so cross-adapter models never collide. Defaults to `true`. */
  includeDatasource?: boolean;
  /** Per-model queue override, e.g. `{ Task: "legacy-tasks" }`. Wins over `queueName`. */
  queues?: { [model: string]: string };
  /** Full override of queue naming. Consulted when `queues` has no entry for the model. */
  queueName?: (input: QueueNameInput) => string;
  /** Allow-list of models to generate for. Defaults to every registered definition. */
  models?: string[];
  /**
   * Derives the permission gate from the per-call context (typically its role).
   * When omitted temporalize does no gating — it only propagates `context` into
   * ormize's ambient store for `definition.before`/`after` hooks to act on.
   */
  resolvePermission?: (context: PermissionContext) => Permission | undefined | Promise<Permission | undefined>;
  /** Validate `input` against the ormize-zod4 create/update schemas. Defaults to `true`. */
  validate?: boolean;
  /** Refuse every mutating activity. Defaults to `false`. */
  readOnly?: boolean;
  /** Wrap each mutating activity in `orm.transaction()`. Defaults to `true`. */
  transactional?: boolean;
  /** Generate class/instance method activities. Both default to `true`. */
  expose?: {
    classMethods?: boolean;
    instanceMethods?: boolean;
  };
  /** Include relationship keys in activity results. Defaults to `true`. */
  includeRelations?: boolean;
}

/** Map produced by `buildQueueMap`. Plain JSON so a client process needs no ormize. */
export type QueueMap = {
  /** model name -> task queue */
  byModel: { [model: string]: string };
  /** task queue -> models hosted on it (overrides may collide several models onto one queue) */
  byQueue: { [queue: string]: string[] };
};

/**
 * The generated activities, keyed by activity name. `req` stays `any`: this is a
 * heterogeneous dispatch map — `Task.findAll` and `Task.create` take different
 * argument shapes — and Temporal's `Worker.create` indexes it by string. The
 * per-model shapes are named by `ModelActivities` in `workflow-types`, which is
 * what a caller should reach for when it knows the model.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous dispatch map, see doc comment above
export type ActivityMap = { [activityName: string]: (req: any) => Promise<unknown> };
