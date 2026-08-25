import { beforeEach, describe, expect, it } from "@jest/globals";
import type { Ormize } from "@azerothian/ormize";
import type { ActivityMap } from "../src/types";
import { createActivities } from "../src/activities";
import { ErrorType } from "../src/workflow-types";
import { buildOrm, ctx, expectFailure, seenContexts } from "./helper";
import type { TestContext } from "./helper";

describe("context propagation", () => {
  let orm: Ormize;
  let acts: ActivityMap;

  beforeEach(async () => {
    orm = await buildOrm();
    acts = createActivities(orm);
  });

  it("rejects a call with no context", async () => {
    await expectFailure(acts["Task.findAll"]({}), ErrorType.ContextMissing);
    await expectFailure(acts["Task.findAll"](undefined), ErrorType.ContextMissing);
  });

  it("rejects a context that is not an object", async () => {
    await expectFailure(acts["Task.findAll"]({ context: "admin" }), ErrorType.ContextMissing);
    await expectFailure(acts["Task.findAll"]({ context: null }), ErrorType.ContextMissing);
  });

  it("rejects a context carrying a transaction key", async () => {
    // Ormize.withTransaction honours context.transaction as-is; letting workflow
    // input set it would opt the call out of transaction management.
    await expectFailure(
      acts["Task.create"]({ context: { ...ctx, transaction: "forged" }, input: { name: "a" } }),
      ErrorType.Validation
    );
  });

  it("installs the caller context as ormize's ambient context", async () => {
    let ambient: unknown;
    await acts["Task.create"]({
      context: ctx,
      input: { name: "alpha" },
    });
    orm.runWithContext(ctx, () => {
      ambient = orm.getContext();
    });
    expect(ambient).toBe(ctx);
  });

  it("hands the context to definition.before hooks", async () => {
    await acts["Item.findAll"]({ context: ctx });
    expect(seenContexts.length).toBeGreaterThan(0);
    // The engine shallow-copies the context to stamp a transaction handle onto
    // it, so compare identity fields rather than object identity.
    expect(seenContexts[seenContexts.length - 1]).toMatchObject({ userId: "u1", role: "admin" });
  });

  it("carries a distinct context per concurrent call", async () => {
    const a = { userId: "a", role: "admin" };
    const b = { userId: "b", role: "admin" };
    await Promise.all([acts["Item.findAll"]({ context: a }), acts["Item.findAll"]({ context: b })]);
    const users = seenContexts
      .map((c) => (typeof c === "object" && c !== null && "userId" in c ? (c as TestContext).userId : undefined))
      .filter(Boolean);
    expect(users).toContain("a");
    expect(users).toContain("b");
  });
});
