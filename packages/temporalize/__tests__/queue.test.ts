import { beforeAll, describe, expect, it } from "@jest/globals";
import type { Ormize } from "@azerothian/ormize";
import { buildQueueMap, listModels, resolveQueueName } from "../src/queue";
import type { QueueNameInput } from "../src/types";
import { buildOrm } from "./helper";

describe("queue naming", () => {
  let orm: Ormize;
  beforeAll(async () => {
    orm = await buildOrm();
  });

  it("composes prefix + datasource + model", () => {
    expect(resolveQueueName(orm, "Task", { queuePrefix: "myapp" })).toBe("myapp.sqlite.Task");
  });

  it("omits an absent prefix rather than leaving a leading separator", () => {
    expect(resolveQueueName(orm, "Task")).toBe("sqlite.Task");
  });

  it("honors a custom separator", () => {
    expect(resolveQueueName(orm, "Task", { queuePrefix: "myapp", queueSeparator: "-" })).toBe("myapp-sqlite-Task");
  });

  it("can drop the datasource segment", () => {
    expect(resolveQueueName(orm, "Task", { queuePrefix: "myapp", includeDatasource: false })).toBe("myapp.Task");
  });

  it("prefers a per-model override over everything else", () => {
    const options = { queuePrefix: "myapp", queues: { Task: "legacy-tasks" }, queueName: () => "never" };
    expect(resolveQueueName(orm, "Task", options)).toBe("legacy-tasks");
    expect(resolveQueueName(orm, "Item", options)).toBe("never");
  });

  it("passes model, datasource and definition to a queueName callback", () => {
    const seen: QueueNameInput[] = [];
    resolveQueueName(orm, "Task", { queueName: (i) => (seen.push(i), "q") });
    expect(seen[0].model).toBe("Task");
    expect(seen[0].datasource).toBe("sqlite");
    expect(seen[0].definition.name).toBe("Task");
  });

  it("throws for an unregistered model", () => {
    expect(() => resolveQueueName(orm, "Nope")).toThrow(/unknown model 'Nope'/);
  });

  it("restricts generation to the models allow-list", () => {
    expect(listModels(orm).sort()).toEqual(["Item", "Task"]);
    expect(listModels(orm, { models: ["Task"] })).toEqual(["Task"]);
  });

  describe("buildQueueMap", () => {
    it("maps each model to its own queue", () => {
      const map = buildQueueMap(orm, { queuePrefix: "myapp" });
      expect(map.byModel).toEqual({ Item: "myapp.sqlite.Item", Task: "myapp.sqlite.Task" });
      expect(map.byQueue["myapp.sqlite.Task"]).toEqual(["Task"]);
    });

    it("groups colliding overrides onto one queue", () => {
      const map = buildQueueMap(orm, { queues: { Item: "shared", Task: "shared" } });
      expect(map.byQueue).toEqual({ shared: ["Item", "Task"] });
    });
  });
});
