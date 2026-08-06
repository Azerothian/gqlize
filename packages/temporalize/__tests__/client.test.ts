import { beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { buildQueueMap } from "../src/queue";
import { createTemporalizeClient } from "../src/client";
import { buildOrm, ctx } from "./helper";

describe("createTemporalizeClient", () => {
  let orm: any;
  const calls: any[] = [];
  const client: any = {
    workflow: {
      execute: async (type: string, options: any) => (calls.push({ kind: "execute", type, options }), "result"),
      start: async (type: string, options: any) => (calls.push({ kind: "start", type, options }), { workflowId: options.workflowId }),
    },
  };

  beforeAll(async () => {
    orm = await buildOrm();
  });
  beforeEach(() => {
    calls.length = 0;
  });

  const build = (options: any = { queuePrefix: "myapp" }) => createTemporalizeClient(client, orm, options);

  it("dispatches each op to its generic workflow on the model's queue", async () => {
    await build().model("Task").create({ context: ctx, input: { name: "alpha" } });
    expect(calls[0].type).toBe("createWorkflow");
    expect(calls[0].options.taskQueue).toBe("myapp.sqlite.Task");
    expect(calls[0].options.args).toEqual([{ model: "Task", context: ctx, input: { name: "alpha" } }]);
  });

  it("threads the method name through for class and instance methods", async () => {
    const task = build().model("Item");
    await task.classMethod("labelsUpper", { context: ctx, args: { x: 1 } });
    expect(calls[0].type).toBe("classMethodWorkflow");
    expect(calls[0].options.args[0]).toEqual({ model: "Item", method: "labelsUpper", context: ctx, args: { x: 1 } });

    await task.instanceMethod("describe", { context: ctx, id: 7, args: {} });
    expect(calls[1].type).toBe("instanceMethodWorkflow");
    expect(calls[1].options.args[0]).toEqual({ model: "Item", method: "describe", context: ctx, id: 7, args: {} });
  });

  it("generates a unique workflow id and honors an explicit one", async () => {
    const task = build().model("Task");
    await task.count({ context: ctx });
    await task.count({ context: ctx });
    expect(calls[0].options.workflowId).toMatch(/^temporalize-Task-count-/);
    expect(calls[0].options.workflowId).not.toBe(calls[1].options.workflowId);

    await task.count({ context: ctx, workflowId: "stable-id" });
    expect(calls[2].options.workflowId).toBe("stable-id");
  });

  it("keeps client-side control fields out of the workflow argument", async () => {
    await build().model("Task").count({ context: ctx, workflowId: "x", workflowOptions: { taskQueue: "override" } });
    expect(calls[0].options.args[0]).toEqual({ model: "Task", context: ctx });
    // Per-call workflowOptions win over the factory's.
    expect(calls[0].options.taskQueue).toBe("override");
  });

  it("uses a custom workflow id prefix and merges factory workflow options", async () => {
    const t = createTemporalizeClient(client, orm, {
      queuePrefix: "myapp",
      workflowIdPrefix: "app:",
      workflowOptions: { workflowExecutionTimeout: "5m" } as any,
    });
    await t.model("Task").count({ context: ctx });
    expect(calls[0].options.workflowId).toMatch(/^app:Task-count-/);
    expect(calls[0].options.workflowExecutionTimeout).toBe("5m");
  });

  it("starts without waiting when asked", async () => {
    const handle = await build().model("Task").start("create", { context: ctx, input: { name: "a" } });
    expect(calls[0].kind).toBe("start");
    expect(handle.workflowId).toMatch(/^temporalize-Task-create-/);
  });

  it("rejects an unknown operation", async () => {
    expect(() => build().model("Task").start("nope", { context: ctx })).toThrow(/unknown operation 'nope'/);
  });

  it("builds from a plain queue map, with no ormize instance", async () => {
    // A client process should not need a database connection.
    const queueMap = JSON.parse(JSON.stringify(buildQueueMap(orm, { queuePrefix: "myapp" })));
    const t = createTemporalizeClient(client, queueMap);
    await t.model("Task").count({ context: ctx });
    expect(calls[0].options.taskQueue).toBe("myapp.sqlite.Task");
  });

  it("throws for a model with no queue", () => {
    expect(() => build().model("Nope")).toThrow(/no task queue for model 'Nope'/);
  });
});
