import { beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Worker, WorkerOptions } from "@temporalio/worker";
import type { CreateWorkersOptions } from "../src/worker";
import { buildOrm } from "./helper";

// `@temporalio/worker` loads a native addon and Worker.create() opens a
// connection, so the factory's wiring is asserted against a stubbed SDK: which
// queues get a worker, and which activities each one registers.
const created: WorkerOptions[] = [];
jest.mock("@temporalio/worker", () => ({
  Worker: {
    // eslint-disable-next-line @typescript-eslint/require-await -- stands in for Worker.create, which returns a Promise<Worker>
    create: async (options: WorkerOptions) => {
      created.push(options);
      return {
        // eslint-disable-next-line @typescript-eslint/require-await -- stands in for Worker.run, which returns a Promise<void>
        run: async () => undefined,
        shutdown: () => undefined,
        // The real Worker carries much more (a native handle, poll loops, etc.);
        // only run/shutdown are ever called through temporalize's worker factory.
      } as unknown as Worker;
    },
  },
}));

import { createWorkers } from "../src/worker";

describe("createWorkers", () => {
  let orm: Awaited<ReturnType<typeof buildOrm>>;
  beforeAll(async () => {
    orm = await buildOrm();
  });

  const build = async (options: CreateWorkersOptions = {}) => {
    created.length = 0;
    return createWorkers(orm, options);
  };

  it("creates one worker per queue and registers only that queue's activities", async () => {
    const workers = await build({ queuePrefix: "myapp" });
    expect(workers.workers.map((w) => w.queue).sort()).toEqual(["myapp.sqlite.Item", "myapp.sqlite.Task"]);

    const task = workers.get("myapp.sqlite.Task")!;
    expect(task.models).toEqual(["Task"]);
    const keys = Object.keys(created.find((o) => o.taskQueue === "myapp.sqlite.Task")!.activities!);
    expect(keys).toContain("Task.create");
    expect(keys).toContain("Task.findAll");
    expect(keys.some((k) => k.startsWith("Item."))).toBe(false);
  });

  it("registers every model's activities when overrides share a queue", async () => {
    const workers = await build({ queues: { Item: "shared", Task: "shared" } });
    expect(workers.workers).toHaveLength(1);
    expect(workers.workers[0].models).toEqual(["Item", "Task"]);
    const keys = Object.keys(created[0].activities!);
    expect(keys).toContain("Item.create");
    expect(keys).toContain("Task.create");
  });

  it("restricts launched workers with onlyQueues", async () => {
    const workers = await build({ queuePrefix: "myapp", onlyQueues: ["myapp.sqlite.Task"] });
    expect(workers.workers.map((w) => w.queue)).toEqual(["myapp.sqlite.Task"]);
    // The queue map still describes every model, so a client built from it can
    // address models this process does not serve.
    expect(Object.keys(workers.queueMap.byModel).sort()).toEqual(["Item", "Task"]);
  });

  it("restricts generated models with the models allow-list", async () => {
    const workers = await build({ queuePrefix: "myapp", models: ["Task"] });
    expect(workers.workers.map((w) => w.queue)).toEqual(["myapp.sqlite.Task"]);
    expect(Object.keys(workers.queueMap.byModel)).toEqual(["Task"]);
  });

  it("passes workflowsPath, namespace and extra worker options through", async () => {
    await build({
      queuePrefix: "myapp",
      namespace: "prod",
      workflowsPath: "/tmp/workflows.js",
      workerOptions: { maxConcurrentActivityTaskExecutions: 3 },
    });
    expect(created[0].namespace).toBe("prod");
    expect(created[0].workflowsPath).toBe("/tmp/workflows.js");
    expect(created[0].maxConcurrentActivityTaskExecutions).toBe(3);
  });

  it("omits workflow options entirely for activity-only workers", async () => {
    await build({ queuePrefix: "myapp" });
    expect(created[0]).not.toHaveProperty("workflowsPath");
    expect(created[0]).not.toHaveProperty("workflowBundle");
  });

  it("prefers a prebuilt bundle over workflowsPath", async () => {
    await build({ queuePrefix: "myapp", workflowsPath: "/tmp/workflows.js", workflowBundle: { code: "x" } });
    expect(created[0].workflowBundle).toEqual({ code: "x" });
    expect(created[0]).not.toHaveProperty("workflowsPath");
  });

  it("runs and shuts down every worker", async () => {
    const workers = await build({ queuePrefix: "myapp" });
    await expect(workers.runAll()).resolves.toBeUndefined();
    expect(() => workers.shutdownAll()).not.toThrow();
  });
});
