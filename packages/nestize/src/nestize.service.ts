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
  isModelAllowed,
  isMutationAllowed,
  isRelationshipAllowed,
} from "@azerothian/utilize";
import * as guards from "@azerothian/utilize/guards";
import { mutationInstanceMethods } from "@azerothian/utilize/exposed-methods";
import type { AdapterWhere, Association, Fail, GuardFailure } from "@azerothian/utilize";
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
 * How this service answers a shared guard rejection. The status codes are the
 * contract — a denied filter field is a bad request, not a 403, because saying
 * "forbidden" would itself confirm the field exists — so each kind is mapped
 * explicitly rather than collapsed onto one exception.
 */
const FAIL: Fail = (kind: GuardFailure, message: string): never => {
  if (kind === "read-only") {
    throw new HttpException(message, HttpStatus.METHOD_NOT_ALLOWED);
  }
  throw new BadRequestException(message);
};

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
    guards.assertWritable(this.options.readOnly, FAIL);
  }

  /** Refuse an unscoped bulk mutation — see `@azerothian/utilize/guards`. */
  private assertScopedMutation(where: unknown, optIn: boolean): void {
    guards.assertScopedMutation(where, optIn, "?all=true", FAIL);
  }

  /** Validate that every filter field is permitted — see `@azerothian/utilize/guards`. */
  private assertFilterAllowed(name: string, where: unknown): void {
    guards.assertFilterAllowed(this.permission, name, where, FAIL);
  }

  /** Validate that every `orderBy` field is permitted for the model. */
  private assertOrderAllowed(name: string, orderBy: unknown): void {
    guards.assertOrderAllowed(this.permission, name, orderBy, FAIL);
  }

  /**
   * `id` is `unknown` at this boundary — it comes straight off the route param —
   * so stringify only the shapes that produce a useful message and fall back to
   * `typeof` rather than risk "[object Object]" in a 404.
   */
  private idLabel(id: unknown): string {
    return typeof id === "string" || typeof id === "number" || typeof id === "bigint"
      ? String(id)
      : `<${typeof id}>`;
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
    return guards.toPlain(v);
  }

  /**
   * Serialize an ORM instance/list to plain JSON, keeping only the fields the
   * model's generated `entity` schema exposes — which is exactly the set that
   * passed the permission gate. See `project` in `@azerothian/utilize/guards`
   * for why the raw instance must not be serialized directly.
   */
  private present(name: string, v: unknown): unknown {
    const schema = this.registry.entity(name);
    return guards.present(v, schema && new Set(Object.keys(schema.shape)));
  }

  /** Load the raw model instance for a pk (needed for relationship accessors). */
  private async loadInstance(name: string, id: unknown, req: RestRequest): Promise<PlainRow> {
    const pk = this.pkName(name);
    const args = { where: { [pk]: { eq: this.coerceId(id) } }, first: 1 };
    const { models } = await this.orm.resolveFindAll(name, null, args, { req });
    if (!models || models.length === 0) {
      throw new NotFoundException(`${name} '${this.idLabel(id)}' not found`);
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
    const name = this.mustResolve(resource);
    if (!this.options.expose?.instanceMethods) {
      throw new NotFoundException(`Instance methods not exposed for ${name}`);
    }
    // The two `expose.instanceMethods` targets share one implementation
    // namespace, so which target declared a method is the only thing that says
    // whether it reads or writes. `assertNoExposedMethodCollisions` guarantees
    // the two sets are name-disjoint, so this is unambiguous. A method declared
    // under neither target — the common case, since `expose` is optional — keeps
    // the read-only treatment it has always had here.
    const isTransform = !!mutationInstanceMethods(this.orm.getDefinition(name))[method];
    const gate = isTransform ? this.permission?.mutationInstanceMethods : this.permission?.queryInstanceMethods;
    if (!isAllowed(gate, name, method, this.permission?.options)) {
      throw new ForbiddenException(`Method '${method}' not allowed for ${name}`);
    }
    if (isTransform) {
      this.assertWritable();
      // A transform is a write, so it answers to the same model-level update
      // gate every other write route here checks. `mutationInstanceMethods`
      // says which transforms a role may run; it does not say the role may
      // write at all.
      if (!isMutationAllowed(this.permission, name, "update")) {
        throw new ForbiddenException(`Update not allowed for ${name}`);
      }
      // A transform reshapes a row on its way to a write. Calling it and
      // serialising what it returned — which is what this route used to do —
      // drops everything it assigned to `this`. Routing it through the same
      // `processUpdate`/`apply` path gqlize's `apply` argument takes brings the
      // transaction, the proxy that records those writes, and the scope
      // enforcement with it, rather than reimplementing any of that here.
      //
      // The request itself is the ask, so an absent or empty body means "run it
      // with no params". gqlize's "named but not asked for" reading of a falsy
      // value only exists because its `apply` input lists every exposed
      // transform at once; a REST call names exactly one.
      const params = args === undefined || args === null || args === false ? true : args;
      const results = await this.orm.processUpdate(
        name,
        null,
        {
          input: {},
          where: { [this.pkName(name)]: { eq: this.coerceId(id) } },
          limit: 1,
          apply: { [method]: params },
        },
        { req },
      );
      if (!Array.isArray(results) || results.length === 0) {
        throw new NotFoundException(`${name} '${this.idLabel(id)}' not found`);
      }
      return this.present(name, results);
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
