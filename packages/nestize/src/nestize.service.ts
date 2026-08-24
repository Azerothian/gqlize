import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  isAllowed,
  isFieldAllowed,
  isModelAllowed,
  isMutationAllowed,
  isRelationshipAllowed,
} from "@azerothian/utilize";
import type { AdapterWhere, Association } from "@azerothian/utilize";
import type { MutationInputTree, Ormize } from "@azerothian/ormize";
import { NestizeSchemaRegistry } from "./schema-registry";
import {
  NESTIZE_OPTIONS,
  ORMIZE,
  type NestizeOptions,
  type PlainRow,
  type RestQuery,
  type RestRequest,
} from "./types";
import { parseListQuery, parseWhere } from "./query";

/** A list response: `total` always, `rows` unless the caller asked to count only. */
export type ListResult = { total: number; rows?: unknown };

/** Kind of `_actions` call, derived from the HTTP verb (GET → query, POST → mutation). */
export type MethodKind = "query" | "mutation";

/** Body of `POST /:resource/select`. */
export type SelectBody = {
  input?: MutationInputTree;
  where?: AdapterWhere;
  limit?: number;
  /** Required to run an unscoped (empty `where`) bulk select-mutation. */
  all?: boolean;
} | undefined;

/**
 * Generic REST facade over the graphql-free ormize resolution engine. Every method
 * resolves a `:resource` segment to a definition name (404 when unknown/denied),
 * gates the operation with the shared utilize permission helpers, validates request
 * bodies with the generated Zod create/update schema, then calls the engine with a
 * request-derived context and returns plain JSON.
 */
@Injectable()
export class NestizeService {
  constructor(
    @Inject(ORMIZE) private readonly orm: Ormize,
    @Inject(NESTIZE_OPTIONS) private readonly options: NestizeOptions,
    private readonly registry: NestizeSchemaRegistry
  ) {}

  private get permission() {
    return this.options.permission;
  }

  /** Resolve a resource segment to a definition name or throw 404. */
  private mustResolve(resource: string): string {
    const name = this.registry.resolve(resource);
    if (!name || !isModelAllowed(this.permission, name)) {
      throw new NotFoundException(`Unknown resource '${resource}'`);
    }
    return name;
  }

  private assertWritable(): void {
    if (this.options.readOnly) {
      throw new HttpException("Read-only API", HttpStatus.METHOD_NOT_ALLOWED);
    }
  }

  /**
   * Guard against unscoped bulk mutations. An empty `where` on a collection
   * update/delete would match — and mutate/destroy — every row in the table, so
   * a non-empty filter is required unless the caller explicitly opts in via
   * `?all=true` (or `all: true` in a select body).
   */
  private assertScopedMutation(where: unknown, optIn: boolean): void {
    const hasFilter = where && typeof where === "object" && Object.keys(where).length > 0;
    if (!hasFilter && !optIn) {
      throw new BadRequestException(
        "A 'filter' is required for a bulk update/delete. Pass ?all=true to intentionally affect every row."
      );
    }
  }

  /**
   * Validate that every field referenced by a filter is permitted for the model.
   * Without this, a client could filter on a permission-denied field (e.g. a
   * password hash) and use the row count as a boolean oracle to read its value,
   * even though the field never appears in a response body.
   */
  private assertFilterAllowed(name: string, where: unknown): void {
    if (!where || typeof where !== "object") {
      return;
    }
    const clause = where as AdapterWhere;
    const logical = new Set(["and", "or", "not"]);
    for (const key of Object.keys(clause)) {
      if (logical.has(key.toLowerCase())) {
        const branch = clause[key];
        if (Array.isArray(branch)) {
          branch.forEach((c) => this.assertFilterAllowed(name, c));
        } else {
          this.assertFilterAllowed(name, branch);
        }
        continue;
      }
      if (!isFieldAllowed(this.permission, name, key)) {
        throw new BadRequestException(`Unknown or not permitted filter field '${key}'`);
      }
    }
  }

  /** Validate that every `orderBy` field is permitted for the model. */
  private assertOrderAllowed(name: string, orderBy: unknown): void {
    if (!Array.isArray(orderBy)) {
      return;
    }
    for (const entry of orderBy) {
      const field = Array.isArray(entry) ? entry[0] : entry;
      if (typeof field === "string" && field && !isFieldAllowed(this.permission, name, field)) {
        throw new BadRequestException(`Unknown or not permitted order field '${field}'`);
      }
    }
  }

  private pkName(name: string): string {
    const adapter = this.orm.getModelAdapter(name);
    const keys = adapter.getPrimaryKeyNameForModel(name);
    return (keys && keys[0]) || "id";
  }

  private coerceId(id: unknown): unknown {
    if (typeof id === "string" && /^\d+$/.test(id)) {
      return Number(id);
    }
    return id;
  }

  private toPlain(v: unknown): unknown {
    if (Array.isArray(v)) {
      return v.map((x) => this.toPlain(x));
    }
    // Duck-typed rather than instance-checked: the ORM instance type belongs to
    // the adapter, and nestize only knows that one of these two escape hatches
    // yields plain JSON.
    const instance = v as { toJSON?: () => unknown; get?: (options: { plain: boolean }) => unknown };
    if (v && typeof instance.toJSON === "function") {
      return instance.toJSON();
    }
    if (v && typeof instance.get === "function") {
      return instance.get({ plain: true });
    }
    return v;
  }

  /**
   * Strip permission-denied fields from an output value for model `name`.
   *
   * The generated `entity` schema only contains fields/relationships that pass
   * `isFieldAllowed`/`isRelationshipAllowed`, so its shape keys are exactly the
   * output allow-list. This closes the leak where a denied column (e.g. a
   * password hash) or an adapter-internal attribute (e.g. `full_count`) would
   * otherwise be serialized straight from the raw ORM instance. When no schema
   * exists for the model (nothing gated), the value is returned unchanged.
   */
  private project(name: string, v: unknown): unknown {
    if (Array.isArray(v)) {
      return v.map((x) => this.project(name, x));
    }
    if (!v || typeof v !== "object") {
      return v;
    }
    const schema = this.registry.entity(name);
    if (!schema) {
      return v;
    }
    const row = v as PlainRow;
    const allowed = new Set(Object.keys(schema.shape));
    const out: PlainRow = {};
    for (const key of Object.keys(row)) {
      if (allowed.has(key)) {
        out[key] = row[key];
      }
    }
    return out;
  }

  /** Serialize an ORM instance/list to plain JSON, filtered to allowed fields. */
  private present(name: string, v: unknown): unknown {
    return this.project(name, this.toPlain(v));
  }

  /** Load the raw model instance for a pk (needed for relationship accessors). */
  private async loadInstance(name: string, id: unknown, req: RestRequest): Promise<PlainRow> {
    const pk = this.pkName(name);
    const args = { where: { [pk]: { eq: this.coerceId(id) } }, first: 1 };
    const { models } = await this.orm.resolveFindAll(name, null, args, { req });
    if (!models || models.length === 0) {
      throw new NotFoundException(`${name} '${id}' not found`);
    }
    // An adapter row is opaque by contract, so the engine hands it back as
    // `unknown`. Callers here read a relationship accessor or method off it by
    // name, which is exactly what the raw instance is loaded for.
    return models[0] as PlainRow;
  }

  private relationOrThrow(name: string, relation: string): Association {
    if (this.options.includeRelations === false) {
      throw new NotFoundException(`Unknown relation '${relation}'`);
    }
    const assoc = (this.orm.getAssociations(name) || {})[relation];
    if (!assoc) {
      throw new NotFoundException(`Unknown relation '${relation}' on ${name}`);
    }
    if (!isRelationshipAllowed(this.permission, name, relation, assoc.target)) {
      throw new NotFoundException(`Unknown relation '${relation}' on ${name}`);
    }
    return assoc;
  }

  // --- collection ------------------------------------------------------------

  async list(resource: string, query: RestQuery, req: RestRequest): Promise<ListResult> {
    const name = this.mustResolve(resource);
    const { args, count } = parseListQuery(query);
    this.assertFilterAllowed(name, args.where);
    this.assertOrderAllowed(name, args.orderBy);
    if (count) {
      const { total } = await this.orm.resolveFindAll(name, null, args, { req }, { countOnly: true });
      return { total };
    }
    const { total, models } = await this.orm.resolveFindAll(name, null, args, { req });
    return { total, rows: this.present(name, models) };
  }

  async findOne(resource: string, id: unknown, req: RestRequest): Promise<unknown> {
    const name = this.mustResolve(resource);
    const row = await this.loadInstance(name, id, req);
    return this.present(name, row);
  }

  async create(resource: string, body: PlainRow, req: RestRequest): Promise<unknown> {
    this.assertWritable();
    const name = this.mustResolve(resource);
    if (!isMutationAllowed(this.permission, name, "create")) {
      throw new ForbiddenException(`Create not allowed for ${name}`);
    }
    const schema = this.registry.create(name);
    const input = schema ? schema.parse(body) : body;
    const results = await this.orm.processCreate(name, null, { input }, { req });
    // `processCreate` always returns a list; a single-row create is unwrapped so
    // the REST response is the resource itself rather than a one-element array.
    const plain = this.present(name, results);
    return Array.isArray(plain) && plain.length === 1 ? plain[0] : plain;
  }

  async update(resource: string, query: RestQuery, body: PlainRow, req: RestRequest): Promise<unknown> {
    this.assertWritable();
    const name = this.mustResolve(resource);
    if (!isMutationAllowed(this.permission, name, "update")) {
      throw new ForbiddenException(`Update not allowed for ${name}`);
    }
    const schema = this.registry.update(name);
    const input = schema ? schema.parse(body) : body;
    const where = parseWhere(query) || {};
    this.assertFilterAllowed(name, where);
    this.assertScopedMutation(where, query?.all === "true" || query?.all === true);
    const { limit } = parseListQuery(query);
    const results = await this.orm.processUpdate(name, null, { input, where, limit }, { req });
    return this.present(name, results);
  }

  async remove(resource: string, query: RestQuery, req: RestRequest): Promise<{ deleted: unknown }> {
    this.assertWritable();
    const name = this.mustResolve(resource);
    if (!isMutationAllowed(this.permission, name, "delete")) {
      throw new ForbiddenException(`Delete not allowed for ${name}`);
    }
    const where = parseWhere(query) || {};
    this.assertFilterAllowed(name, where);
    this.assertScopedMutation(where, query?.all === "true" || query?.all === true);
    const deleted = await this.orm.processDelete(name, null, where, { req });
    return { deleted: this.present(name, deleted) };
  }

  async select(resource: string, body: SelectBody, req: RestRequest): Promise<{ rows: unknown }> {
    const name = this.mustResolve(resource);
    const { input, where, limit } = body || {};
    this.assertFilterAllowed(name, where);
    // `select` becomes a mutation the moment `input` is supplied: the engine
    // forwards it into relationship create/update/delete on matched rows. Gate
    // it with the same write-authorization the other mutating routes use, and
    // refuse an unscoped bulk mutation.
    if (input !== undefined && input !== null) {
      this.assertWritable();
      if (!isMutationAllowed(this.permission, name, "update")) {
        throw new ForbiddenException(`Update not allowed for ${name}`);
      }
      this.assertScopedMutation(where, body?.all === true);
    }
    const found = await this.orm.processSelect(name, null, { input, where, limit }, { req });
    return { rows: this.present(name, found) };
  }

  // --- relationships ---------------------------------------------------------

  async relationGet(resource: string, id: unknown, relation: string, query: RestQuery, req: RestRequest): Promise<unknown> {
    const name = this.mustResolve(resource);
    const assoc = this.relationOrThrow(name, relation);
    const source = await this.loadInstance(name, id, req);
    const single = assoc.associationType === "belongsTo" || assoc.associationType === "hasOne";
    const { args } = parseListQuery(query);
    if (single) {
      const row = await this.orm.resolveSingleRelationship(assoc.target, assoc, source, args, { req });
      return this.present(assoc.target, row);
    }
    const { total, models } = await this.orm.resolveManyRelationship(assoc.target, assoc, source, args, { req });
    return { total, rows: this.present(assoc.target, models) };
  }

  async relationMutate(resource: string, id: unknown, relation: string, body: unknown, req: RestRequest): Promise<unknown> {
    this.assertWritable();
    const name = this.mustResolve(resource);
    this.relationOrThrow(name, relation);
    if (!isMutationAllowed(this.permission, name, "update")) {
      throw new ForbiddenException(`Update not allowed for ${name}`);
    }
    const pk = this.pkName(name);
    const where = { [pk]: { eq: this.coerceId(id) } };
    const results = await this.orm.processUpdate(
      name,
      null,
      { input: { [relation]: body }, where, limit: 1 },
      { req }
    );
    return this.present(name, results);
  }

  async relationRemove(resource: string, id: unknown, relation: string, relId: unknown, req: RestRequest): Promise<unknown> {
    this.assertWritable();
    const name = this.mustResolve(resource);
    const assoc = this.relationOrThrow(name, relation);
    if (!isMutationAllowed(this.permission, name, "update")) {
      throw new ForbiddenException(`Update not allowed for ${name}`);
    }
    const single = assoc.associationType === "belongsTo" || assoc.associationType === "hasOne";
    const pk = this.pkName(name);
    const where = { [pk]: { eq: this.coerceId(id) } };
    let subOp: unknown;
    if (single) {
      subOp = { remove: true };
    } else {
      const targetPk = this.pkName(assoc.target);
      subOp = { remove: [{ [targetPk]: { eq: this.coerceId(relId) } }] };
    }
    const results = await this.orm.processUpdate(
      name,
      null,
      { input: { [relation]: subOp }, where, limit: 1 },
      { req }
    );
    return this.present(name, results);
  }

  // --- class / instance methods (`_actions`) ---------------------------------

  async callClassMethod(resource: string, method: string, args: unknown, kind: MethodKind, req: RestRequest): Promise<unknown> {
    const name = this.mustResolve(resource);
    if (kind === "mutation") {
      this.assertWritable();
    }
    if (!this.options.expose?.classMethods) {
      throw new NotFoundException(`Class methods not exposed for ${name}`);
    }
    const gate = kind === "mutation" ? this.permission?.mutationClassMethods : this.permission?.queryClassMethods;
    if (!isAllowed(gate, name, method, this.permission?.options)) {
      throw new ForbiddenException(`Method '${method}' not allowed for ${name}`);
    }
    const result = await this.orm.resolveClassMethod(name, method, args, { req });
    return this.toPlain(result);
  }

  async callInstanceMethod(resource: string, id: unknown, method: string, args: unknown, req: RestRequest): Promise<unknown> {
    this.assertWritable();
    const name = this.mustResolve(resource);
    if (!this.options.expose?.instanceMethods) {
      throw new NotFoundException(`Instance methods not exposed for ${name}`);
    }
    const gate = this.permission?.queryInstanceMethods;
    if (!isAllowed(gate, name, method, this.permission?.options)) {
      throw new ForbiddenException(`Method '${method}' not allowed for ${name}`);
    }
    const row = await this.loadInstance(name, id, req);
    const instanceMethod = row[method];
    if (typeof instanceMethod !== "function") {
      throw new NotFoundException(`Unknown method '${method}' on ${name}`);
    }
    const result = await instanceMethod.call(row, args, { req });
    return this.toPlain(result);
  }
}
