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
  FindArgs,
  InstanceMethodArgs,
  MethodArgs,
  ModelActivities,
  SelectArgs,
  UpdateArgs,
  WorkflowRequest,
} from "./workflow-types";

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
export function createModelProxy<TInstance = any, TStatics = Record<string, any>>(
  model: string,
  activityOptions: ActivityOptions = DEFAULT_ACTIVITY_OPTIONS
): ModelActivities<TInstance, TStatics> {
  const activities = proxyActivities<Record<string, (req: any) => Promise<any>>>(activityOptions);

  const namespace = (build: (model: string, method: string) => string) =>
    new Proxy({} as any, {
      get: (_t, method: string | symbol) =>
        typeof method === "string" ? (req: any) => activities[build(model, method)](req) : undefined,
    });

  return new Proxy({} as any, {
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
      return (req: any) => activities[activityName(model, op)](req);
    },
  });
}

// --- generic, model-agnostic workflows ---------------------------------------
//
// Workflow code is static and cannot enumerate ormize models, so these take the
// model name as an argument and dispatch to the matching activity. They are what
// the client helpers in `./client` target; write your own workflows with
// `createModelProxy` when you need real orchestration.

function dispatch(model: string, op: string, req: any, activityOptions?: ActivityOptions) {
  return (createModelProxy(model, activityOptions || DEFAULT_ACTIVITY_OPTIONS) as any)[op](req);
}

type Req<T> = WorkflowRequest<T & { activityOptions?: ActivityOptions }>;

export async function createWorkflow(req: Req<CreateArgs>): Promise<any> {
  return dispatch(req.model, "create", req, req.activityOptions);
}

export async function findAllWorkflow(req: Req<FindArgs>): Promise<any> {
  return dispatch(req.model, "findAll", req, req.activityOptions);
}

export async function findOneWorkflow(req: Req<FindArgs>): Promise<any> {
  return dispatch(req.model, "findOne", req, req.activityOptions);
}

export async function findByPkWorkflow(req: Req<ByPkArgs>): Promise<any> {
  return dispatch(req.model, "findByPk", req, req.activityOptions);
}

export async function countWorkflow(req: Req<FindArgs>): Promise<any> {
  return dispatch(req.model, "count", req, req.activityOptions);
}

export async function updateWorkflow(req: Req<UpdateArgs>): Promise<any> {
  return dispatch(req.model, "update", req, req.activityOptions);
}

export async function destroyWorkflow(req: Req<DestroyArgs>): Promise<any> {
  return dispatch(req.model, "destroy", req, req.activityOptions);
}

export async function selectWorkflow(req: Req<SelectArgs>): Promise<any> {
  return dispatch(req.model, "select", req, req.activityOptions);
}

export async function classMethodWorkflow(req: Req<MethodArgs & { method: string }>): Promise<any> {
  return (createModelProxy(req.model, req.activityOptions) as any).classMethods[req.method](req);
}

export async function instanceMethodWorkflow(req: Req<InstanceMethodArgs & { method: string }>): Promise<any> {
  return (createModelProxy(req.model, req.activityOptions) as any).instanceMethods[req.method](req);
}
