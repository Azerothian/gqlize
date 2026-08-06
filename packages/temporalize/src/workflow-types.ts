// Shared vocabulary between the Node half (activities/worker/client) and the
// Temporal workflow sandbox (`./workflows`).
//
// This module MUST stay free of imports. Workflow code is bundled into an
// isolated V8 context that cannot resolve ormize, Node built-ins, or anything
// with side effects, and both halves have to agree on activity names — so the
// naming functions live here as pure string builders.

/** CRUD operations generated for every model. */
export const CRUD_OPS = [
  "create",
  "findAll",
  "findOne",
  "findByPk",
  "count",
  "update",
  "destroy",
  "select",
] as const;

export type CrudOp = (typeof CRUD_OPS)[number];

/**
 * Operations that write. `select` is included deliberately: `Ormize.processSelect`
 * finds rows by `where` and then runs relationship mutations against them, so it
 * is a mutation that happens to start with a read (scalar `input` fields are
 * ignored and the matched rows themselves are never written).
 */
export const MUTATION_OPS: readonly CrudOp[] = ["create", "update", "destroy", "select"];

/** The `Permission` mutation kind each write op is gated by. */
export const MUTATION_KIND: { [op: string]: "create" | "update" | "delete" } = {
  create: "create",
  update: "update",
  destroy: "delete",
  select: "update",
};

export const CLASS_METHOD_SEGMENT = "classMethods";
export const INSTANCE_METHOD_SEGMENT = "instanceMethods";

/** `activityName("Task", "create")` -> `"Task.create"` */
export function activityName(model: string, op: string): string {
  return `${model}.${op}`;
}

/** `classMethodActivityName("Task", "reverseName")` -> `"Task.classMethods.reverseName"` */
export function classMethodActivityName(model: string, method: string): string {
  return `${model}.${CLASS_METHOD_SEGMENT}.${method}`;
}

/** `instanceMethodActivityName("Task", "touch")` -> `"Task.instanceMethods.touch"` */
export function instanceMethodActivityName(model: string, method: string): string {
  return `${model}.${INSTANCE_METHOD_SEGMENT}.${method}`;
}

/**
 * Every activity input carries an opaque `context`. temporalize does not
 * prescribe its shape — it is passed verbatim to `Ormize.runWithContext` so
 * `definition.before`/`after` hooks can read it, and to the optional
 * `resolvePermission(context)` option that derives the permission gate. Carrying
 * the caller's identity and role on it is the whole point; a missing or
 * non-object `context` fails the activity non-retryably.
 */
export type ActivityRequest<T = {}> = { context: any } & T;

/** Sort entry: `"name"` or `["name", "DESC"]`. */
export type OrderEntry = string | [string, string];

export type FindArgs = {
  where?: any;
  orderBy?: OrderEntry[];
  limit?: number;
  offset?: number;
};

export type FindAllResult<TRow = any> = { total: number; rows: TRow[] };

export type CreateArgs<TInput = any> = { input: TInput };

export type UpdateArgs<TInput = any> = {
  input: TInput;
  where?: any;
  limit?: number;
  /** Required to run an unscoped (empty `where`) bulk update. */
  all?: boolean;
};

export type DestroyArgs = {
  where?: any;
  /** Required to run an unscoped (empty `where`) bulk delete. */
  all?: boolean;
};

/**
 * `select` matches rows by `where` and applies relationship verbs
 * (`create`/`update`/`delete`/`add`/`set`/`remove`/`restore`) from `input`
 * against each match without writing the matched rows themselves.
 */
export type SelectArgs<TInput = any> = {
  input: TInput;
  where?: any;
  limit?: number;
  all?: boolean;
};

export type ByPkArgs = { id: any };

export type MethodArgs = { args?: any };

export type InstanceMethodArgs = { id: any; args?: any };

/**
 * Shape of the per-model activity surface, for `proxyActivities` typing.
 * `TInstance` is the row type and `TStatics` the model's class methods, so a
 * typed ormize definition can be threaded straight through:
 * `ModelActivities<TaskInstance, TaskStatics>`.
 */
export type ModelActivities<TInstance = any, TStatics = Record<string, any>> = {
  create(req: ActivityRequest<CreateArgs<Partial<TInstance>>>): Promise<TInstance[]>;
  findAll(req: ActivityRequest<FindArgs>): Promise<FindAllResult<TInstance>>;
  findOne(req: ActivityRequest<FindArgs>): Promise<TInstance | null>;
  findByPk(req: ActivityRequest<ByPkArgs>): Promise<TInstance | null>;
  count(req: ActivityRequest<FindArgs>): Promise<number>;
  update(req: ActivityRequest<UpdateArgs<Partial<TInstance>>>): Promise<TInstance[]>;
  destroy(req: ActivityRequest<DestroyArgs>): Promise<TInstance[]>;
  select(req: ActivityRequest<SelectArgs>): Promise<TInstance[]>;
  classMethods: {
    [K in keyof TStatics]: (req: ActivityRequest<MethodArgs>) => Promise<any>;
  };
  instanceMethods: {
    [name: string]: (req: ActivityRequest<InstanceMethodArgs>) => Promise<any>;
  };
};

/** Error `type` strings carried on the non-retryable `ApplicationFailure`s we raise. */
export const ErrorType = {
  ContextMissing: "TemporalizeContextMissing",
  UnknownModel: "TemporalizeUnknownModel",
  UnknownMethod: "TemporalizeUnknownMethod",
  Forbidden: "TemporalizeForbidden",
  Validation: "TemporalizeValidation",
  NotFound: "TemporalizeNotFound",
  UnscopedMutation: "TemporalizeUnscopedMutation",
} as const;

/** Argument shape of the generic, model-agnostic workflows in `./workflows`. */
export type WorkflowRequest<T = {}> = { model: string; context: any } & T;
