import { z } from "zod";
import type { INestApplication } from "@nestjs/common";
import type { Ormize } from "@azerothian/ormize";
import { generateZodSchemas } from "@azerothian/ormize-zod4";
import { isModelAllowed, isMutationAllowed, isMutationCsvAllowed, isRelationshipAllowed } from "@azerothian/utilize";
import { CSV_OPERATIONS } from "./csv";
import { OpenApiOptions } from "./types";

/**
 * A node of the emitted document. OpenAPI path items, operation objects and JSON
 * schemas are open by specification — vendor extensions included — and nothing
 * here reads them back, so they are described as JSON rather than modelled.
 */
type JsonObject = { [key: string]: unknown };

// Minimal structural stand-ins so the builder needs no @nestjs/swagger types at
// compile time (swagger is a peer dependency). `setupSwagger` casts at the call.
type OpenAPIObject = {
  openapi: string;
  info: { title: string; version: string };
  tags?: { name: string }[];
  paths: Record<string, JsonObject>;
  components: { schemas: Record<string, JsonObject> };
};

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function toSchema(schema: z.ZodTypeAny | undefined): JsonObject {
  if (!schema) {
    return { type: "object" };
  }
  return z.toJSONSchema(schema, { target: "openapi-3.0", unrepresentable: "any" });
}

function joinPath(prefix: string | undefined, resource: string): string {
  const base = prefix ? `/${prefix.replace(/^\/|\/$/g, "")}` : "";
  return `${base}/${resource}`;
}

/**
 * Build a plain OpenAPI 3.0 document describing the REST surface Nestize generates
 * for `orm`. `components.schemas` carries `<Model>` / `<Model>CreateInput` /
 * `<Model>UpdateInput` (permission-filtered), and `paths` carries the CRUD +
 * relation routes. GraphQL-free.
 */
export function buildOpenApiDocument(orm: Ormize, options: OpenApiOptions = {}): OpenAPIObject {
  const { permission, pathPrefix, includeRelations = true, readOnly = false } = options;
  const title = options.title || "Nestize API";
  const version = options.version || "1.0.0";

  // Entity components omit nested relations (they would emit cyclic JSON-schema
  // refs); relations are still reachable via their own routes.
  const entitySchemas = generateZodSchemas(orm, { permission, includeRelations: false });
  const inputSchemas = generateZodSchemas(orm, { permission });

  const components: { schemas: Record<string, JsonObject> } = { schemas: {} };
  const paths: Record<string, JsonObject> = {};
  const tags: { name: string }[] = [];
  /** The `<resource>.<operation>` file parts `POST /_csv` would take. */
  const importParts: string[] = [];

  const defs = orm.getDefinitions() || {};
  const names = Object.keys(defs).filter((n) => isModelAllowed(permission, n));

  for (const name of names) {
    const resource = name.toLowerCase();
    tags.push({ name });

    components.schemas[name] = toSchema(entitySchemas.entity[name]);
    if (inputSchemas.create[name]) {
      components.schemas[`${name}CreateInput`] = toSchema(inputSchemas.create[name]);
    }
    if (inputSchemas.update[name]) {
      components.schemas[`${name}UpdateInput`] = toSchema(inputSchemas.update[name]);
    }

    const collectionPath = joinPath(pathPrefix, resource);
    const itemPath = joinPath(pathPrefix, `${resource}/{id}`);

    const listResponse = {
      "200": {
        description: `List of ${name}`,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                total: { type: "integer" },
                rows: { type: "array", items: ref(name) },
              },
            },
          },
        },
      },
    };

    const collection: JsonObject = {
      get: {
        tags: [name],
        summary: `List ${name}`,
        parameters: [
          { name: "filter", in: "query", required: false, schema: { type: "string" }, description: "JSON filter DSL" },
          { name: "order", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          { name: "offset", in: "query", required: false, schema: { type: "integer" } },
          { name: "count", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: listResponse,
      },
    };
    if (!readOnly && inputSchemas.create[name]) {
      collection.post = {
        tags: [name],
        summary: `Create ${name}`,
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref(`${name}CreateInput`) } },
        },
        responses: {
          "201": { description: `Created ${name}`, content: { "application/json": { schema: ref(name) } } },
          "400": { description: "Validation failed" },
        },
      };
    }
    if (!readOnly && inputSchemas.update[name]) {
      collection.patch = {
        tags: [name],
        summary: `Update ${name} matching a filter`,
        parameters: [{ name: "filter", in: "query", required: false, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref(`${name}UpdateInput`) } },
        },
        responses: {
          "200": { description: `Updated ${name}`, content: { "application/json": { schema: { type: "array", items: ref(name) } } } },
        },
      };
    }
    if (!readOnly) {
      collection.delete = {
        tags: [name],
        summary: `Delete ${name} matching a filter`,
        parameters: [{ name: "filter", in: "query", required: false, schema: { type: "string" } }],
        responses: { "200": { description: `Deleted ${name}` } },
      };
    }
    paths[collectionPath] = collection;

    // CSV uploads: documented exactly when the route would accept one — CSV on
    // for the model, `mutationCsv` allowed, and at least one operation the
    // caller may perform (the enum lists only those).
    const csvOperations = CSV_OPERATIONS.filter((op) => isMutationAllowed(permission, name, op)
      && (op !== "create" || inputSchemas.create[name]) && (op !== "update" || inputSchemas.update[name]));
    if (!readOnly && orm.csvLimits(name) && isMutationCsvAllowed(permission, name) && csvOperations.length > 0) {
      for (const op of csvOperations) {
        if (op !== "delete") {
          importParts.push(`${resource}.${op}`);
        }
      }
      paths[joinPath(pathPrefix, `${resource}/_csv/{operation}`)] = {
        post: {
          tags: [name],
          summary: `Create, update or delete ${name} rows from a CSV file`,
          description:
            "One write per data row, all-or-nothing. The header names the fields. update and delete match rows on `keys` " +
            "(default: the primary key); delete takes only those columns. An empty cell is left out; `\\N` is null.",
          parameters: [
            { name: "operation", in: "path", required: true, schema: { type: "string", enum: csvOperations } },
            { name: "keys", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated columns to match rows on" },
            { name: "delimiter", in: "query", required: false, schema: { type: "string" }, description: "Field separator. Default `,`" },
            {
              name: "apply", in: "query", required: false, schema: { type: "string" },
              description: "create and update only: a JSON object of instance-method transforms to run on each row, "
                + "each `true` or an object of arguments. An update that applies a transform may carry only its key columns",
            },
          ],
          requestBody: {
            required: true,
            content: { "text/csv": { schema: { type: "string" } } },
          },
          responses: {
            "200": {
              description: `The ${name} rows written`,
              content: {
                "application/json": {
                  schema: { type: "object", properties: { rows: { type: "array", items: ref(name) } } },
                },
              },
            },
            "400": { description: "The CSV, or one of its rows, was refused; nothing was written" },
            "413": { description: "The CSV is over the byte or row limit" },
          },
        },
      };
    }

    // Advanced select. NOTE: when `input` is supplied this route performs
    // relationship create/update/delete on matched rows (it is not a pure read),
    // so it is omitted in read-only mode.
    if (!readOnly) {
      paths[joinPath(pathPrefix, `${resource}/select`)] = {
        post: {
          tags: [name],
          summary: `Advanced select for ${name}`,
          description:
            "Body: { where, limit, input }. When `input` is present it applies relationship create/update/delete to matched rows and requires update permission.",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    where: { type: "object" },
                    limit: { type: "integer" },
                    input: { type: "object" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: `Rows of ${name}`,
              content: {
                "application/json": {
                  schema: { type: "object", properties: { rows: { type: "array", items: ref(name) } } },
                },
              },
            },
          },
        },
      };
    }

    const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
    paths[itemPath] = {
      get: {
        tags: [name],
        summary: `Fetch a ${name} by id`,
        parameters: [idParam],
        responses: {
          "200": { description: name, content: { "application/json": { schema: ref(name) } } },
          "404": { description: "Not found" },
        },
      },
    };

    if (includeRelations && orm.getAssociations) {
      const associations = orm.getAssociations(name) || {};
      for (const relName of Object.keys(associations)) {
        const assoc = associations[relName];
        if (!isRelationshipAllowed(permission, name, relName, assoc.target)) {
          continue;
        }
        const single = assoc.associationType === "belongsTo" || assoc.associationType === "hasOne";
        const relPath = joinPath(pathPrefix, `${resource}/{id}/${relName}`);
        const relSchema = single
          ? ref(assoc.target)
          : {
              type: "object",
              properties: {
                total: { type: "integer" },
                rows: { type: "array", items: ref(assoc.target) },
              },
            };
        paths[relPath] = {
          get: {
            tags: [name],
            summary: `Fetch ${name}.${relName}`,
            parameters: [idParam],
            responses: {
              "200": {
                description: `${name}.${relName}`,
                content: { "application/json": { schema: relSchema } },
              },
            },
          },
        };
        // Relationship write routes (to-many relations only, mutation-enabled).
        if (!readOnly && !single) {
          paths[relPath].post = {
            tags: [name],
            summary: `Add/set ${name}.${relName}`,
            parameters: [idParam],
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object" } } },
            },
            responses: { "200": { description: `Updated ${name}` } },
          };
          const relIdParam = { name: "relId", in: "path", required: true, schema: { type: "string" } };
          paths[joinPath(pathPrefix, `${resource}/{id}/${relName}/{relId}`)] = {
            delete: {
              tags: [name],
              summary: `Remove a ${relName} from ${name}`,
              parameters: [idParam, relIdParam],
              responses: { "200": { description: `Removed from ${name}.${relName}` } },
            },
          };
        }
      }
    }
  }

  // The multi-file import: documented when at least one file part would be taken.
  if (importParts.length > 0) {
    paths[joinPath(pathPrefix, "_csv")] = {
      post: {
        tags: ["CSV"],
        summary: "Create or update rows of several resources from CSV files, as one unit",
        description:
          "multipart/form-data, one file part per CSV, named `<resource>.create` or `<resource>.update` (a bare " +
          "`<resource>` creates). Text parts `<part>.keys`, `<part>.delimiter` and `<part>.apply` (a JSON object of " +
          "instance-method transforms) set a file's options. A file's `@ref` " +
          "column labels its rows; a `<foreignKey>.@ref` column in any file writes a labelled row's key. Files run in the " +
          "order their references need, all-or-nothing. Parts: " + importParts.join(", "),
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: Object.fromEntries(importParts.map((part) => [part, { type: "string", format: "binary" }])),
              },
            },
          },
        },
        responses: {
          "200": {
            description: "What each file wrote, and each label's key",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    files: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          resource: { type: "string" },
                          operation: { type: "string", enum: ["create", "update"] },
                          rows: { type: "array", items: { type: "object" } },
                        },
                      },
                    },
                    refs: { type: "object", additionalProperties: true },
                  },
                },
              },
            },
          },
          "400": { description: "A file, row or reference was refused; nothing was written" },
          "403": { description: "A file's resource or operation is not allowed" },
          "413": { description: "Too many files, or a file over its byte or row limit" },
        },
      },
    };
  }

  return {
    openapi: "3.0.0",
    info: { title, version },
    tags,
    paths,
    components,
  };
}

/**
 * Build the OpenAPI document for `orm` and mount Swagger UI on the Nest `app` at
 * `options.path` (default `docs`) using `@nestjs/swagger`'s `SwaggerModule.setup`.
 */
export function setupSwagger(app: INestApplication, orm: Ormize, options: OpenApiOptions = {}): OpenAPIObject {
  const doc = buildOpenApiDocument(orm, options);
  // Required lazily so @nestjs/swagger stays a peer dependency (not needed for the
  // pure `buildOpenApiDocument` path).
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- `import()` would make this async and change the API
  const { SwaggerModule } = require("@nestjs/swagger");
  // `SwaggerModule` above is untyped (it comes from a lazy `require`, not a static
  // import), so this call already isn't checked against `@nestjs/swagger`'s own
  // `OpenAPIObject` — casting `doc` here added nothing.
  SwaggerModule.setup(options.path || "docs", app, doc);
  return doc;
}
