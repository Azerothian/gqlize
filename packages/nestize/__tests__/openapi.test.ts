import { describe, it, expect, beforeAll } from "@jest/globals";
import { buildOpenApiDocument } from "../src";
import type { Ormize } from "@azerothian/ormize";
import { buildOrm } from "./helper";
import type { Permission } from "@azerothian/utilize";

describe("nestize - buildOpenApiDocument", () => {
  let orm: Ormize;
  beforeAll(async () => {
    orm = await buildOrm();
  });

  it("emits entity/create/update component schemas and CRUD paths", () => {
    const doc = buildOpenApiDocument(orm);
    expect(doc.components.schemas.Task).toBeDefined();
    expect(doc.components.schemas.TaskCreateInput).toBeDefined();
    expect(doc.components.schemas.TaskUpdateInput).toBeDefined();
    expect(doc.paths["/task"]).toBeDefined();
    expect(doc.paths["/task/{id}"]).toBeDefined();
    expect(doc.paths["/task"].get).toBeDefined();
    expect(doc.paths["/task"].post).toBeDefined();
  });

  it("includes a relation path for Item.tasks", () => {
    const doc = buildOpenApiDocument(orm);
    expect(doc.paths["/item/{id}/tasks"]).toBeDefined();
  });

  it("respects a permission that denies Task.name in create input", () => {
    // `mutationCreateInput` gates create-input fields (isInputFieldAllowed).
    const permission: Permission = {
      mutationCreateInput: (model: string, field: string) => !(model === "Task" && field === "name"),
    };
    const doc = buildOpenApiDocument(orm, { permission });
    // The document is emitted as open JSON — see `JsonObject` in openapi.ts — so
    // a test that reaches into a schema node says what it expects to find.
    const createProps = (doc.components.schemas.TaskCreateInput.properties || {}) as Record<string, unknown>;
    expect(createProps.name).toBeUndefined();
  });

  it("omits write paths when readOnly", () => {
    const doc = buildOpenApiDocument(orm, { readOnly: true });
    expect(doc.paths["/task"].get).toBeDefined();
    expect(doc.paths["/task"].post).toBeUndefined();
    expect(doc.paths["/task"].patch).toBeUndefined();
    expect(doc.paths["/task"].delete).toBeUndefined();
  });
});
