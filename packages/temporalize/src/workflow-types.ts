// Shared vocabulary between the Node half (activities/worker/client) and the
// Temporal workflow sandbox (`./workflows`).
//
// This module MUST stay free of imports. Workflow code is bundled into an
// isolated V8 context that cannot resolve ormize, Node built-ins, or anything
// with side effects, and both halves have to agree on activity names — so the
// naming functions live here as pure string builders.

/**
 * The caller-supplied context every activity and workflow carries. Deliberately
 * `any`: its shape belongs to the application, and temporalize only passes it
 * through (see {@link ActivityRequest}). This module may not import, so it
 * cannot name `PermissionContext` from `@azerothian/utilize` — it is the same
 * idea.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- caller-owned shape, see doc comment above
export type CallerContext = any;

/**
 * A backend `where` clause: field names mapped to a value or an operator object.
 * The operator vocabulary belongs to the adapter, so only the shape is described
 * here.
 */
export type WhereClause = { [field: string]: unknown };

/** A primary-key value as it survives JSON serialization into workflow input. */
export type PrimaryKeyValue = string | number;

/**
 * A row as it leaves an activity: plain JSON, projected to the permitted fields.
 * Every generic below defaults to this, so an untyped `ModelActivities` is still
 * usable while a typed definition can be threaded through instead.
 */
export type PlainRow = { [column: string]: unknown };

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
export type ActivityRequest<T = {}> = { context: CallerContext } & T;

/**
 * Sort entry: `"name"` or `["name", "DESC"]`.
 *
 * Named `SortEntry`, not `OrderEntry`. It used to be the latter, which collided
 * with `@azerothian/utilize`'s `OrderEntry` — a different, non-assignable shape
 * (`[column, direction]`, no bare string) exported from the barrel of a package
 * this one depends on. Anyone importing both got two same-named types that do
 * not substitute for each other.
 *
 * The shapes genuinely differ and should: the bare-string spelling is a
 * convenience this public layer accepts, and the engine passes it through to the
 * adapter untouched. So the fix is one name each, not one type.
 *
 * Restated rather than imported, deliberately — see the module header: this file
 * is bundled into the workflow sandbox and must stay import-free. A `import type`
 * would erase at compile time, but the rule is worth keeping simple.
 */
export type SortEntry = string | [string, string];

export type FindArgs = {
  where?: WhereClause;
  orderBy?: SortEntry[];
  limit?: number;
  offset?: number;
};

export type FindAllResult<TRow = PlainRow> = { total: number; rows: TRow[] };

export type CreateArgs<TInput = PlainRow> = { input: TInput };

export type UpdateArgs<TInput = PlainRow> = {
  input: TInput;
  where?: WhereClause;
  limit?: number;
  /** Required to run an unscoped (empty `where`) bulk update. */
  all?: boolean;
};

export type DestroyArgs = {
  where?: WhereClause;
  /** Required to run an unscoped (empty `where`) bulk delete. */
  all?: boolean;
};

/**
 * `select` matches rows by `where` and applies relationship verbs
 * (`create`/`update`/`delete`/`add`/`set`/`remove`/`restore`) from `input`
 * against each match without writing the matched rows themselves.
 */
export type SelectArgs<TInput = PlainRow> = {
  input: TInput;
  where?: WhereClause;
  limit?: number;
  all?: boolean;
};

export type ByPkArgs = { id: PrimaryKeyValue };

export type MethodArgs = { args?: unknown };

export type InstanceMethodArgs = { id: PrimaryKeyValue; args?: unknown };

/**
 * Shape of the per-model activity surface, for `proxyActivities` typing.
 * `TInstance` is the row type and `TStatics` the model's class methods, so a
 * typed ormize definition can be threaded straight through:
 * `ModelActivities<TaskInstance, TaskStatics>`.
 */
export type ModelActivities<TInstance = PlainRow, TStatics = Record<string, unknown>> = {
  create(req: ActivityRequest<CreateArgs<Partial<TInstance>>>): Promise<TInstance[]>;
  findAll(req: ActivityRequest<FindArgs>): Promise<FindAllResult<TInstance>>;
  findOne(req: ActivityRequest<FindArgs>): Promise<TInstance | null>;
  findByPk(req: ActivityRequest<ByPkArgs>): Promise<TInstance | null>;
  count(req: ActivityRequest<FindArgs>): Promise<number>;
  update(req: ActivityRequest<UpdateArgs<Partial<TInstance>>>): Promise<TInstance[]>;
  destroy(req: ActivityRequest<DestroyArgs>): Promise<TInstance[]>;
  select(req: ActivityRequest<SelectArgs>): Promise<TInstance[]>;
  classMethods: {
    [K in keyof TStatics]: (req: ActivityRequest<MethodArgs>) => Promise<unknown>;
  };
  instanceMethods: {
    [name: string]: (req: ActivityRequest<InstanceMethodArgs>) => Promise<unknown>;
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
export type WorkflowRequest<T = {}> = { model: string; context: CallerContext } & T;
