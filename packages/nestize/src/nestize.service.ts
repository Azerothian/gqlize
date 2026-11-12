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
  isMutationCsvAllowed,
  isQueryCsvAllowed,
  isRelationshipAllowed,
} from "@azerothian/utilize";
import * as guards from "@azerothian/utilize/guards";
import { regexOperatorsEnabled } from "@azerothian/utilize/filter-operators";
import { mutationInstanceMethods } from "@azerothian/utilize/exposed-methods";
import { coerceTransformParams } from "@azerothian/utilize/transform-params";
import type { AdapterWhere, Association, Fail, GuardFailure, Selection } from "@azerothian/utilize";
import { CsvUploadError, ThroughInputError, writeCsv } from "@azerothian/ormize";
import type { CsvImportFile, CsvImportOperation, MutationInputTree, Ormize } from "@azerothian/ormize";
import { csvApply, csvHttpError, csvUploadOf, isCsvOperation, restCsvRequest } from "./csv";
import { readCsvParts } from "./csv-multipart";
import { checkInputTree, type RelationshipInputHost } from "./relationship-input";
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

function isImportOperation(operation: string): operation is CsvImportOperation {
  return operation === "create" || operation === "update";
}

/** What `POST /_csv` answers: each file's written rows, and each label's key. */
export type CsvImportResponse = {
  files: { name: string; resource: string; operation: CsvImportOperation; rows: unknown }[];
  refs: { [label: string]: unknown };
};

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

  /** What `checkInputTree` needs to hold a nested relationship input to the permissions. */
  private get relationshipInputHost(): RelationshipInputHost {
    return {
      orm: this.orm,
      permission: this.permission,
      schema: (name, kind) => (kind === "create" ? this.registry.create(name) : this.registry.update(name)),
      assertFilterAllowed: (name, where) => this.assertFilterAllowed(name, where),
    };
  }

  /** Validate every filter field and operator — see `@azerothian/utilize/guards`. */
  private assertFilterAllowed(name: string, where: unknown): void {
    guards.assertFilterAllowed(this.permission, name, where, FAIL, this.orm.getDefinition(name), {
      regexOperators: regexOperatorsEnabled(this.orm.getModelAdapter(name)),
    });
  }

  /** Validate that every `orderBy` field is permitted for the model. */
  private assertOrderAllowed(name: string, orderBy: unknown): void {
    guards.assertOrderAllowed(this.permission, name, orderBy, FAIL, this.orm.getDefinition(name));
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

  /**
   * {@link present}, for a route that addresses exactly one row.
   *
   * The engine's write paths always answer with a list, but `POST /task`,
   * `GET /task/:id` and `POST /task/:id/_actions/:method` each name a single
   * resource, so the REST response is that resource rather than a one-element
   * array. A result that is not a single row is handed back untouched — a bulk
   * update genuinely is a list, and silently unwrapping a longer one would hide
   * how many rows it touched.
   */
  private presentOne(name: string, v: unknown): unknown {
    const plain = this.present(name, v);
    return Array.isArray(plain) && plain.length === 1 ? plain[0] : plain;
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

  /**
   * What every write hands the engine: this module's permission bag. The
   * relationship and `select` routes pass their body through unvalidated, so
   * the engine applies the bag to what depends on it — the shape of a
   * `belongsToMany` `add`/`set` entry and the columns a `through` payload may
   * write. Built per call: `permission` is fixed, but a getter keeps it in
   * one place.
   */
  private get selection(): Selection {
    return { permission: this.permission };
  }

  /** Run an engine write, answering a refused `through` entry with 403 rather than 500. */
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ThroughInputError) {
        throw new ForbiddenException(err.message);
      }
      throw err;
    }
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

  /**
   * `GET /:resource/_csv`: the rows `GET /:resource` would list, as CSV text.
   *
   * 404 unless the instance has CSV on for the model, as for the upload routes;
   * 403 when `queryCsv` denies it. The filter, order and paging are the list
   * route's, under the same guards, and the columns are the ones `present`
   * keeps, so a file holds nothing the JSON list would not. At most the model's
   * `maxRows` rows: the most an upload of the same model may carry back.
   * `?columns=a,b` picks and orders the columns, `?delimiter=;` and
   * `?header=false` shape the file.
   */
  async csvExport(resource: string, query: RestQuery, req: RestRequest): Promise<string> {
    const name = this.mustResolve(resource);
    const limits = this.orm.csvLimits(name);
    if (!limits) {
      throw new NotFoundException(`Cannot GET /${resource}/_csv`);
    }
    if (!isQueryCsvAllowed(this.permission, name)) {
      throw new ForbiddenException(`CSV export not allowed for ${name}`);
    }
    const { args } = parseListQuery(query);
    this.assertFilterAllowed(name, args.where);
    this.assertOrderAllowed(name, args.orderBy);
    args.first = Math.min(args.first ?? limits.maxRows, limits.maxRows);
    const readable = Object.keys(this.registry.entity(name)?.shape || {});
    const requested = typeof query?.columns === "string" ? query.columns.split(",").map((c) => c.trim()).filter((c) => c !== "") : undefined;
    for (const column of requested || []) {
      if (!readable.includes(column)) {
        throw new BadRequestException(`"${column}" is not a column this CSV can hold`);
      }
    }
    if (requested && new Set(requested).size !== requested.length) {
      throw new BadRequestException("A column is named twice");
    }
    const { models } = await this.orm.resolveFindAll(name, null, args, { req });
    const rows = this.present(name, models) as { [column: string]: unknown }[];
    try {
      return writeCsv(requested || readable, Array.isArray(rows) ? rows : [], {
        delimiter: typeof query?.delimiter === "string" ? query.delimiter : undefined,
        header: query?.header !== "false" && query?.header !== false,
      });
    } catch (e) {
      throw e instanceof CsvUploadError ? csvHttpError(e) : e;
    }
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
    const results = await this.write(() => this.orm.processCreate(name, null, { input }, { req }, this.selection));
    // `processCreate` always returns a list; a single-row create is unwrapped so
    // the REST response is the resource itself rather than a one-element array.
    return this.presentOne(name, results);
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
    const results = await this.write(() => this.orm.processUpdate(name, null, { input, where, limit }, { req }, this.selection));
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

  /**
   * `POST /:resource/_csv/:operation` — a CSV body applied as one create,
   * update or delete per row, all-or-nothing (ormize's `processCsv`).
   *
   * 404 unless the instance has CSV on for the model, so the route is as
   * absent as gqlize's `createCsv` argument would be. Then the same gates a
   * JSON write passes, plus `mutationCsv`.
   */
  async csv(resource: string, operation: string, query: RestQuery, req: RestRequest): Promise<{ rows: unknown }> {
    this.assertWritable();
    const name = this.mustResolve(resource);
    if (!isCsvOperation(operation) || !this.orm.csvLimits(name)) {
      throw new NotFoundException(`Cannot POST /${resource}/_csv/${operation}`);
    }
    if (!isMutationAllowed(this.permission, name, operation)) {
      throw new ForbiddenException(`${operation[0].toUpperCase()}${operation.slice(1)} not allowed for ${name}`);
    }
    if (!isMutationCsvAllowed(this.permission, name)) {
      throw new ForbiddenException(`CSV uploads not allowed for ${name}`);
    }
    try {
      const request = restCsvRequest(this.orm, name, operation, csvUploadOf(req), query, {
        input: operation === "create" ? this.registry.create(name) : operation === "update" ? this.registry.update(name) : undefined,
        assertFilterAllowed: (where) => this.assertFilterAllowed(name, where),
      }, { apply: csvApply(this.orm, this.permission, name, operation, query?.apply) });
      // The bag goes with every row's write, as on the JSON routes, so whatever
      // the engine decides by it decides the same way here.
      const rows = await this.orm.processCsv(name, operation, request, { req }, this.selection);
      return { rows: this.present(name, rows) };
    } catch (e) {
      throw e instanceof CsvUploadError ? csvHttpError(e) : e;
    }
  }

  /**
   * `POST /_csv`: several CSV files in one multipart body, each a create or an
   * update on its own model, applied as one all-or-nothing unit with `@ref`
   * labels linking rows across them.
   *
   * A file part's field name says what it is: `<resource>.create` or
   * `<resource>.update` (a bare `<resource>` creates). Text parts named
   * `<field>.keys`, `<field>.delimiter` and `<field>.apply` set that file's
   * options. Each file
   * passes the gates its own `POST /:resource/_csv/:operation` would, checked
   * as its part arrives, so a refused file is not even buffered.
   */
  async csvImport(req: RestRequest): Promise<CsvImportResponse> {
    this.assertWritable();
    const maxFiles = this.orm.csvMaxFiles();
    if (maxFiles === undefined) {
      throw new NotFoundException("Cannot POST /_csv");
    }
    const targets = new Map<string, { resource: string; name: string; operation: CsvImportOperation }>();
    const target = (field: string) => {
      const known = targets.get(field);
      if (known) {
        return known;
      }
      const [resource, operation = "create", ...rest] = field.split(".");
      if (rest.length > 0 || !isImportOperation(operation)) {
        throw new CsvUploadError("CSV_UNSUPPORTED", `"${field}": name a file part <resource>.create or <resource>.update`, { file: field });
      }
      let name: string;
      try {
        name = this.mustResolve(resource);
      } catch {
        throw new CsvUploadError("CSV_UNSUPPORTED", `"${field}": there is no resource "${resource}"`, { file: field });
      }
      if (!this.orm.csvLimits(name)) {
        throw new CsvUploadError("CSV_UNSUPPORTED", `"${field}": ${name} does not accept CSV uploads`, { file: field });
      }
      if (!isMutationAllowed(this.permission, name, operation)) {
        throw new ForbiddenException(`"${field}": ${operation[0].toUpperCase()}${operation.slice(1)} not allowed for ${name}`);
      }
      if (!isMutationCsvAllowed(this.permission, name)) {
        throw new ForbiddenException(`"${field}": CSV uploads not allowed for ${name}`);
      }
      const found = { resource, name, operation };
      targets.set(field, found);
      return found;
    };
    try {
      const parts = await readCsvParts(req, {
        maxFiles,
        maxBytes: (field) => (this.orm.csvLimits(target(field).name) as { maxBytes: number }).maxBytes,
      });
      const files: CsvImportFile[] = parts.files.map((part) => {
        const { name, operation } = target(part.field);
        const query = { keys: parts.fields[`${part.field}.keys`], delimiter: parts.fields[`${part.field}.delimiter`] };
        const apply = csvApply(this.orm, this.permission, name, operation, parts.fields[`${part.field}.apply`], part.field);
        return {
          name: part.field,
          defName: name,
          operation,
          request: restCsvRequest(this.orm, name, operation, part.data, query, {
            input: operation === "create" ? this.registry.create(name) : this.registry.update(name),
            assertFilterAllowed: (where) => this.assertFilterAllowed(name, where),
          }, { refs: true, apply }),
        };
      });
      const key = (defName: string, row: unknown) => this.orm.getValueFromInstance(defName, row, this.pkName(defName));
      const result = await this.orm.processCsvImport({ files, refValue: key, selection: () => this.selection }, { req });
      return {
        files: result.files.map((file) => ({
          name: file.name,
          resource: targets.get(file.name)?.resource ?? file.defName,
          operation: file.operation,
          rows: this.present(file.defName, file.rows),
        })),
        refs: Object.fromEntries(Object.entries(result.refs).map(([label, ref]) => [label, key(ref.defName, ref.row)])),
      };
    } catch (e) {
      throw e instanceof CsvUploadError ? csvHttpError(e) : e;
    }
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
    // `select`'s input is an update-shaped tree whose relationship operations
    // run on the matched rows; hold it to what GraphQL's types would allow.
    const checked = input !== undefined && input !== null
      ? checkInputTree(this.relationshipInputHost, name, input, "update")
      : input;
    const found = await this.write(() => this.orm.processSelect(name, null, { input: checked, where, limit }, { req }, this.selection));
    return { rows: this.present(name, found) };
  }

  // --- relationships ---------------------------------------------------------

  async relationGet(resource: string, id: unknown, relation: string, query: RestQuery, req: RestRequest): Promise<unknown> {
    const name = this.mustResolve(resource);
    const assoc = this.relationOrThrow(name, relation);
    const source = await this.loadInstance(name, id, req);
    const single = assoc.associationType === "belongsTo" || assoc.associationType === "hasOne";
    const { args } = parseListQuery(query);
    // The related rows are filtered and ordered like a list of the target:
    // held to the same field and operator allow-list as `GET /:target`.
    this.assertFilterAllowed(assoc.target, args.where);
    this.assertOrderAllowed(assoc.target, args.orderBy);
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
    const input = checkInputTree(this.relationshipInputHost, name, { [relation]: body }, "update");
    const pk = this.pkName(name);
    const where = { [pk]: { eq: this.coerceId(id) } };
    const results = await this.write(() => this.orm.processUpdate(
      name,
      null,
      { input, where, limit: 1 },
      { req },
      this.selection,
    ));
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
    // A to-many `remove` rewrites the related row's foreign key: the same
    // check a body sent to `POST /:resource/:id/:relation` gets.
    const input = checkInputTree(this.relationshipInputHost, name, { [relation]: subOp }, "update");
    const results = await this.orm.processUpdate(
      name,
      null,
      { input, where, limit: 1 },
      { req },
      this.selection,
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
    return guards.toPlain(result);
  }

  async callInstanceMethod(resource: string, id: unknown, method: string, args: unknown, req: RestRequest): Promise<unknown> {
    const name = this.mustResolve(resource);
    if (!this.options.expose?.instanceMethods) {
      throw new NotFoundException(`Instance methods not exposed for ${name}`);
    }
    // The two `expose.instanceMethods` targets share one implementation
    // namespace, so which target declared a method is the only thing that says
    // whether it reads or writes.
    //
    // A name under both targets is a definition error, and gqlize refuses to
    // build a schema containing one — but `assertNoExposedMethodCollisions` runs
    // from `create-model-type.ts` alone, so a nestize-only consumer never reaches
    // it. Here the mutation lane simply wins, deterministically: the stricter of
    // the two gates, which is the right way for an unrefused ambiguity to land.
    //
    // A method declared under neither target — the common case, since `expose`
    // is optional — keeps the read-only treatment it has always had here.
    const transforms = mutationInstanceMethods(this.orm.getDefinition(name));
    const isTransform = Object.hasOwn(transforms, method);
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
      //
      // The params are then held to the transform's declared `args`, as
      // gqlize's `apply` input type holds them: a transform never sees a key
      // or a value its declaration did not offer.
      const checked = coerceTransformParams(
        transforms[method], args === undefined || args === null || args === false ? true : args, method,
      );
      if (!checked.ok) {
        throw new BadRequestException(checked.message);
      }
      const params = checked.value;
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
      // `:id` names one row, so the response is that row — the same shape
      // `show` and `create` answer with, and the reason the id-addressed routes
      // share `presentOne`.
      return this.presentOne(name, results);
    }
    const row = await this.loadInstance(name, id, req);
    const instanceMethod = row[method];
    if (typeof instanceMethod !== "function") {
      throw new NotFoundException(`Unknown method '${method}' on ${name}`);
    }
    const result = await instanceMethod.call(row, args, { req });
    return guards.toPlain(result);
  }
}
