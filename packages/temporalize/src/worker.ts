import type { NativeConnection, Worker, WorkerOptions } from "@temporalio/worker";
import type { Ormize } from "@azerothian/ormize";
import { createActivities } from "./activities";
import { buildQueueMap } from "./queue";
import { TemporalizeRegistry } from "./registry";
import type { QueueMap, TemporalizeOptions } from "./types";

export type CreateWorkersOptions = TemporalizeOptions & {
  /** Shared connection. Omit to let the SDK use its default (localhost:7233). */
  connection?: NativeConnection;
  namespace?: string;
  /**
   * Path to the workflow bundle entry. Pass
   * `require.resolve("@azerothian/temporalize/workflows")` to serve the generic
   * CRUD workflows, or your own module. Omit for activity-only workers.
   */
  workflowsPath?: string;
  /** Pre-built workflow bundle, preferred over `workflowsPath` in production. */
  workflowBundle?: WorkerOptions["workflowBundle"];
  /** Launch workers only for these queues (applied after the queue map is built). */
  onlyQueues?: string[];
  /** Extra Temporal `WorkerOptions`, merged last so they win. */
  workerOptions?: Partial<WorkerOptions>;
};

export interface TemporalizeWorker {
  /** Task queue this worker polls. */
  queue: string;
  /** Models whose activities are registered on it. */
  models: string[];
  worker: Worker;
  /** Poll until shutdown. Resolves once the worker has drained. */
  run(): Promise<void>;
  shutdown(): void;
}

export interface TemporalizeWorkers {
  workers: TemporalizeWorker[];
  queueMap: QueueMap;
  /** Run every worker concurrently; rejects if any of them fails. */
  runAll(): Promise<void>;
  shutdownAll(): void;
  /** Look up a worker by task queue. */
  get(queue: string): TemporalizeWorker | undefined;
}

/**
 * One Temporal worker per task queue, where a queue maps to a model (table).
 *
 * A `queues` override can land several models on one queue; that worker
 * registers all of their activities. `onlyQueues` / `models` let a process host
 * a subset, so queues can be scaled independently.
 *
 * `@temporalio/worker` is imported lazily — it loads a native addon, and callers
 * that only build activities or drive a client should not pay for it.
 */
export async function createWorkers(orm: Ormize, options: CreateWorkersOptions = {}): Promise<TemporalizeWorkers> {
  const { Worker } = await import("@temporalio/worker");
  const queueMap = buildQueueMap(orm, options);
  const registry = new TemporalizeRegistry(orm, options);
  const only = options.onlyQueues ? new Set(options.onlyQueues) : undefined;

  const queues = Object.keys(queueMap.byQueue).filter((queue) => !only || only.has(queue));

  const workers: TemporalizeWorker[] = [];
  for (const queue of queues) {
    const models = queueMap.byQueue[queue];
    const activities = createActivities(orm, options, models, registry);
    const workerOptions: WorkerOptions = Object.assign(
      {
        taskQueue: queue,
        activities,
      } as WorkerOptions,
      options.connection ? { connection: options.connection } : {},
      options.namespace ? { namespace: options.namespace } : {},
      options.workflowBundle
        ? { workflowBundle: options.workflowBundle }
        : options.workflowsPath
          ? { workflowsPath: options.workflowsPath }
          : {},
      options.workerOptions || {}
    );
    const worker = await Worker.create(workerOptions);
    workers.push({
      queue,
      models,
      worker,
      run: () => worker.run(),
      shutdown: () => worker.shutdown(),
    });
  }

  return {
    workers,
    queueMap,
    runAll: async () => {
      await Promise.all(workers.map((w) => w.run()));
    },
    shutdownAll: () => {
      for (const w of workers) {
        w.shutdown();
      }
    },
    get: (queue: string) => workers.find((w) => w.queue === queue),
  };
}
