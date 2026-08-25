import { z } from "zod";
import type { INestApplication } from "@nestjs/common";
import type { Ormize } from "@azerothian/ormize";
import { generateZodSchemas } from "@azerothian/ormize-zod4";
import { isModelAllowed, isRelationshipAllowed } from "@azerothian/utilize";
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
