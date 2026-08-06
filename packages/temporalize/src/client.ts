import type { Client, WorkflowHandle, WorkflowStartOptions } from "@temporalio/client";
import { buildQueueMap } from "./queue";
import type { QueueMap, TemporalizeOptions } from "./types";
import type {
  ActivityRequest,
  ByPkArgs,
  CreateArgs,
  DestroyArgs,
  FindAllResult,
  FindArgs,
  InstanceMethodArgs,
  MethodArgs,
  SelectArgs,
  UpdateArgs,
} from "./workflow-types";

/** Op -> the generic workflow in `@azerothian/temporalize/workflows` that runs it. */
const WORKFLOW_FOR: { [op: string]: string } = {
  create: "createWorkflow",
  findAll: "findAllWorkflow",
  findOne: "findOneWorkflow",
  findByPk: "findByPkWorkflow",
  count: "countWorkflow",
  update: "updateWorkflow",
  destroy: "destroyWorkflow",
  select: "selectWorkflow",
  classMethod: "classMethodWorkflow",
  instanceMethod: "instanceMethodWorkflow",
};

export type TemporalizeClientOptions = TemporalizeOptions & {
  /** Prepended to every generated workflow id. Defaults to `"temporalize-"`. */
  workflowIdPrefix?: string;
  /** Merged into every `client.workflow.start`/`execute` call. */
  workflowOptions?: Partial<WorkflowStartOptions>;
};

type Call<T> = ActivityRequest<T> & {
  /** Override the generated workflow id (use a stable one for deduplication). */
  workflowId?: string;
  workflowOptions?: Partial<WorkflowStartOptions>;
};

export interface ModelClient<TRow = any> {
  /** Task queue this model's work is dispatched to. */
  queue: string;
  create(req: Call<CreateArgs>): Promise<TRow[]>;
  findAll(req: Call<FindArgs>): Promise<FindAllResult<TRow>>;
  findOne(req: Call<FindArgs>): Promise<TRow | null>;
  findByPk(req: Call<ByPkArgs>): Promise<TRow | null>;
  count(req: Call<FindArgs>): Promise<number>;
  update(req: Call<UpdateArgs>): Promise<TRow[]>;
  destroy(req: Call<DestroyArgs>): Promise<TRow[]>;
  select(req: Call<SelectArgs>): Promise<TRow[]>;
  classMethod(method: string, req: Call<MethodArgs>): Promise<any>;
  instanceMethod(method: string, req: Call<InstanceMethodArgs>): Promise<any>;
  /** Fire-and-forget: start the workflow and return its handle without waiting. */
  start(op: string, req: Call<any>, method?: string): Promise<WorkflowHandle>;
}

/** Accepts a live ormize instance or a pre-built (JSON) queue map. */
function toQueueMap(target: any, options: TemporalizeOptions): QueueMap {
  if (target && target.byModel && target.byQueue) {
    return target as QueueMap;
  }
  return buildQueueMap(target, options);
}

/**
 * Start temporalize's generic workflows against the right task queue for a model.
 *
 * Built from a plain queue map when given one, so a client process needs no
 * ormize instance and no database connection:
 *
 * ```ts
 * const t = createTemporalizeClient(client, queueMap);
 * await t.model("Task").create({ context: { userId, role }, input: { name: "alpha" } });
 * ```
 */
export function createTemporalizeClient(client: Client, target: any, options: TemporalizeClientOptions = {}) {
  const queueMap = toQueueMap(target, options);
  const idPrefix = options.workflowIdPrefix ?? "temporalize-";

  const queueFor = (model: string): string => {
    const queue = queueMap.byModel[model];
    if (!queue) {
      throw new Error(`temporalize: no task queue for model '${model}'`);
    }
    return queue;
  };

  const startOptions = (model: string, op: string, req: Call<any>): WorkflowStartOptions => {
    return Object.assign(
      {
        taskQueue: queueFor(model),
        workflowId: req.workflowId || `${idPrefix}${model}-${op}-${globalThis.crypto.randomUUID()}`,
      } as WorkflowStartOptions,
      options.workflowOptions || {},
      req.workflowOptions || {}
    );
  };

  const args = (model: string, req: Call<any>, method?: string) => {
    const { workflowId, workflowOptions, ...rest } = req as any;
    return [Object.assign({ model }, method ? { method } : {}, rest)];
  };

  const execute = (model: string, op: string, req: Call<any>, method?: string) =>
    client.workflow.execute(WORKFLOW_FOR[op], Object.assign(startOptions(model, op, req), { args: args(model, req, method) }));

  const model = <TRow = any>(name: string): ModelClient<TRow> => ({
    queue: queueFor(name),
    create: (req) => execute(name, "create", req),
    findAll: (req) => execute(name, "findAll", req),
    findOne: (req) => execute(name, "findOne", req),
    findByPk: (req) => execute(name, "findByPk", req),
    count: (req) => execute(name, "count", req),
    update: (req) => execute(name, "update", req),
    destroy: (req) => execute(name, "destroy", req),
    select: (req) => execute(name, "select", req),
    classMethod: (method, req) => execute(name, "classMethod", req, method),
    instanceMethod: (method, req) => execute(name, "instanceMethod", req, method),
    start: (op, req, method) => {
      const workflow = WORKFLOW_FOR[op];
      if (!workflow) {
        throw new Error(`temporalize: unknown operation '${op}'`);
      }
      return client.workflow.start(workflow, Object.assign(startOptions(name, op, req), { args: args(name, req, method) }));
    },
  });

  return { model, queueMap, queueFor };
}
