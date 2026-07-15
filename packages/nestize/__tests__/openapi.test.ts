import { describe, it, expect, beforeAll } from "@jest/globals";
import { buildOpenApiDocument } from "../src";
import { buildOrm } from "./helper";

describe("nestize - buildOpenApiDocument", () => {
  let orm: any;
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
    const permission: any = {
      mutationCreateInput: (model: string, field: string) => !(model === "Task" && field === "name"),
    };
    const doc = buildOpenApiDocument(orm, { permission });
    const createProps = doc.components.schemas.TaskCreateInput.properties || {};
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
