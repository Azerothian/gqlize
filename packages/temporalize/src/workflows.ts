// Temporal workflow half. Bundled into an isolated V8 sandbox, so this module —
// and everything it imports — must stay free of ormize, Node built-ins and side
// effects. `./workflow-types` is import-free by construction and holds the
// activity-name contract both halves share.
//
// Published as `@azerothian/temporalize/workflows`; point a worker at it with
// `workflowsPath: require.resolve("@azerothian/temporalize/workflows")`.
import { proxyActivities } from "@temporalio/workflow";
import type { ActivityOptions } from "@temporalio/workflow";
import {
  activityName,
  classMethodActivityName,
  instanceMethodActivityName,
  CLASS_METHOD_SEGMENT,
  INSTANCE_METHOD_SEGMENT,
} from "./workflow-types";
import type {
  ByPkArgs,
  CreateArgs,
  DestroyArgs,
  FindAllResult,
  FindArgs,
  InstanceMethodArgs,
  MethodArgs,
  ModelActivities,
  PlainRow,
  SelectArgs,
  UpdateArgs,
  WorkflowRequest,
} from "./workflow-types";

/**
 * How an activity looks once the flat, dotted registry is indexed by name: the
 * argument shape differs per activity, and only the caller knows which one it
 * asked for. `createModelProxy` is what puts the names back on it.
 */
type AnyActivity = (req: unknown) => Promise<unknown>;

/** Applied when a caller does not pass their own activity options. */
export const DEFAULT_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "1 minute",
};

/**
 * A typed handle onto one model's activities.
 *
 * ```ts
 * const task = createModelProxy<TaskInstance, TaskStatics>("Task");
 * await task.create({ context, input: { name: "alpha" } });
 * await task.classMethods.reverseName({ context, args: { id: 1 } });
 * ```
 *
 * Activities are registered under flat, dotted names (`"Task.create"`,
 * `"Task.classMethods.reverseName"`), so this wraps `proxyActivities` in a Proxy
 * that maps property access onto those names — including the nested
 * `classMethods` / `instanceMethods` namespaces.
 */
export function createModelProxy<TInstance = PlainRow, TStatics = Record<string, unknown>>(
  model: string,
  activityOptions: ActivityOptions = DEFAULT_ACTIVITY_OPTIONS
): ModelActivities<TInstance, TStatics> {
  const activities = proxyActivities<Record<string, AnyActivity>>(activityOptions);

  const namespace = (build: (model: string, method: string) => string) =>
    new Proxy({}, {
      get: (_t, method: string | symbol) =>
        typeof method === "string" ? (req: unknown) => activities[build(model, method)](req) : undefined,
    });

  // The target is empty because every property is synthesized by the handler;
  // the assertion is what gives the caller the named shape it stands in for.
  return new Proxy({} as ModelActivities<TInstance, TStatics>, {
    get: (_t, op: string | symbol) => {
      if (typeof op !== "string") {
        return undefined;
      }
      if (op === CLASS_METHOD_SEGMENT) {
        return namespace(classMethodActivityName);
      }
      if (op === INSTANCE_METHOD_SEGMENT) {
        return namespace(instanceMethodActivityName);
      }
      return (req: unknown) => activities[activityName(model, op)](req);
    },
  });
}

// --- generic, model-agnostic workflows ---------------------------------------
//
// Workflow code is static and cannot enumerate ormize models, so these take the
// model name as an argument and dispatch to the matching activity. They are what
// the client helpers in `./client` target; write your own workflows with
// `createModelProxy` when you need real orchestration.

/**
 * `TResult` is the caller's claim about what the named activity returns — the
 * proxy is indexed by a runtime `op` string, so nothing static can check it.
 * Each workflow below states the shape its own activity produces.
 */
function dispatch<TResult>(model: string, op: string, req: unknown, activityOptions?: ActivityOptions): Promise<TResult> {
  const proxy = createModelProxy(model, activityOptions || DEFAULT_ACTIVITY_OPTIONS) as unknown as {
    [op: string]: (req: unknown) => Promise<TResult>;
  };
  return proxy[op](req);
}

type Req<T> = WorkflowRequest<T & { activityOptions?: ActivityOptions }>;

export async function createWorkflow(req: Req<CreateArgs>): Promise<PlainRow[]> {
  return dispatch<PlainRow[]>(req.model, "create", req, req.activityOptions);
}

export async function findAllWorkflow(req: Req<FindArgs>): Promise<FindAllResult> {
  return dispatch<FindAllResult>(req.model, "findAll", req, req.activityOptions);
}

export async function findOneWorkflow(req: Req<FindArgs>): Promise<PlainRow | null> {
  return dispatch<PlainRow | null>(req.model, "findOne", req, req.activityOptions);
}

export async function findByPkWorkflow(req: Req<ByPkArgs>): Promise<PlainRow | null> {
  return dispatch<PlainRow | null>(req.model, "findByPk", req, req.activityOptions);
}

export async function countWorkflow(req: Req<FindArgs>): Promise<number> {
  return dispatch<number>(req.model, "count", req, req.activityOptions);
}

export async function updateWorkflow(req: Req<UpdateArgs>): Promise<PlainRow[]> {
  return dispatch<PlainRow[]>(req.model, "update", req, req.activityOptions);
}

export async function destroyWorkflow(req: Req<DestroyArgs>): Promise<PlainRow[]> {
  return dispatch<PlainRow[]>(req.model, "destroy", req, req.activityOptions);
}

export async function selectWorkflow(req: Req<SelectArgs>): Promise<PlainRow[]> {
  return dispatch<PlainRow[]>(req.model, "select", req, req.activityOptions);
}

export async function classMethodWorkflow(req: Req<MethodArgs & { method: string }>): Promise<unknown> {
  return createModelProxy(req.model, req.activityOptions).classMethods[req.method](req);
}

export async function instanceMethodWorkflow(req: Req<InstanceMethodArgs & { method: string }>): Promise<unknown> {
  return createModelProxy(req.model, req.activityOptions).instanceMethods[req.method](req);
}
