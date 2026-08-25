// Opt-in: excluded from the default `pnpm test` because TestWorkflowEnvironment
// downloads and boots a Temporal test-server binary on first run.
//
//   TEMPORALIZE_INTEGRATION=1 pnpm --filter @azerothian/temporalize test
//
// This is the only suite that exercises the workflow half for real: the sandbox
// bundle, the activity-name contract between `./workflows` and `./activities`,
// and non-retryable failure propagation across the workflow boundary. Everything
// else about temporalize is reachable by calling the activities directly.
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createRoleBasedPermissions } from "@azerothian/utilize";
import type { Permission, PermissionContext, RoleRules } from "@azerothian/utilize";
import { createActivities } from "../../src/activities";
import { createTemporalizeClient } from "../../src/client";
import { buildQueueMap } from "../../src/queue";
import { ErrorType } from "../../src/workflow-types";
import { buildOrm, ctx } from "../helper";

// Bundling the workflow code with webpack dominates this; the workflows
// themselves are a single activity each.
jest.setTimeout(120_000);

/** Plain-JSON row shape for the `Task` fixture model, as it leaves an activity. */
type TaskRow = { id: number; name: string };

const RULES: RoleRules = { admin: { model: "allow" }, reader: { mutation: "deny" } };
const permissions: { [role: string]: Permission } = {};
const resolvePermission = (context: PermissionContext): Permission =>
  (permissions[context.role] =
    permissions[context.role] || createRoleBasedPermissions(context.role, RULES, { defaultDeny: false }));

const options = { queuePrefix: "itest", resolvePermission };

describe("temporalize through a real Temporal workflow", () => {
  let env: TestWorkflowEnvironment;
  let workers: Worker[] = [];
  let running: Promise<void[]>;
  let t: ReturnType<typeof createTemporalizeClient>;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const orm = await buildOrm();
    const queueMap = buildQueueMap(orm, options);

    workers = await Promise.all(
      Object.keys(queueMap.byQueue).map((taskQueue) =>
        Worker.create({
          connection: env.nativeConnection,
          namespace: env.namespace,
          taskQueue,
          activities: createActivities(orm, options, queueMap.byQueue[taskQueue]),
          // Jest resolves the extensionless path to the .ts source; Temporal's
          // bundler compiles TypeScript workflow entrypoints itself. Consumers
          // use require.resolve("@azerothian/temporalize/workflows") instead.
          workflowsPath: require.resolve("../../src/workflows"),
        })
      )
    );
    running = Promise.all(workers.map((w) => w.run()));
    t = createTemporalizeClient(env.client, queueMap, options);
  });

  afterAll(async () => {
    workers.forEach((w) => w.shutdown());
    await running;
    await env?.teardown();
  });

  it("creates and reads back through the generic workflows", async () => {
    const created = await t.model<TaskRow>("Task").create({ context: ctx, input: { name: "alpha" } });
    expect(created[0].name).toBe("alpha");

    const list = await t.model<TaskRow>("Task").findAll({ context: ctx });
    expect(list.total).toBe(1);
    expect(list.rows[0].name).toBe("alpha");
  });

  it("dispatches a class method by name onto the model's own queue", async () => {
    await t.model("Item").create({ context: ctx, input: { label: "beta" } });
    const labels = await t.model("Item").classMethod("labelsUpper", { context: ctx });
    expect(labels).toContain("BETA");
  });

  it("fails a denied mutation instead of retrying it forever", async () => {
    // The default retry policy has no attempt limit, so a retryable failure
    // would never surface here at all — the workflow would still be retrying
    // when the test timed out. Rejecting is itself the proof of nonRetryable.
    const error = await t
      .model("Task")
      .create({ context: { userId: "u2", role: "reader" }, input: { name: "nope" } })
      .then(
        () => null,
        (e) => e
      );
    expect(error).toBeTruthy();

    // WorkflowFailedError -> ActivityFailure -> the ApplicationFailure we threw.
    // Callers have to walk the chain; there is no flattened `type` on the top.
    expect(error.cause?.name).toBe("ActivityFailure");
    expect(error.cause.cause).toMatchObject({
      name: "ApplicationFailure",
      type: ErrorType.Forbidden,
      nonRetryable: true,
    });
  });
});
