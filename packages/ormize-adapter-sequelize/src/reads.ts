// Read operations: findAll, count, snapshot/restore, single and many
// relationship resolution, and inline-count extraction. Extracted from
// `index.ts` so the adapter class delegates to these free functions.

import { Utils, type Sequelize } from "sequelize";
import logger from "@azerothian/utilize/utils/logger";
import type {
  AdapterListOptions,
  AdapterListRequest,
  AdapterQueryOptions,
  AdapterRelationshipPage,
  AdapterRelationshipRequest,
  AdapterWhere,
  Association,
  DeletedFilter,
} from "@azerothian/utilize/types/index";
import type { ListArgs, SequelizeInclude, SequelizeRow } from "./types/query";
import { rowFields, markWindowedIncludes, snapshotRow, isWindowed } from "./row-helpers";
import { deletedOverlay } from "./query-options";
import type { QueryOptionsHost } from "./query-options";

const log = logger("gqlize::adapter::sequelize::");

/**
 * What the read functions reach into. Extends `QueryOptionsHost` with the
 * additional members the read layer itself needs.
 */
export interface ReadHost extends QueryOptionsHost {
  asInstance(defName: string, row: SequelizeRow): SequelizeRow;
  processListArgsToOptions(defName: string, request: AdapterListRequest): Promise<AdapterListOptions>;
  countRelationship(
    relationship: Association,
    source: SequelizeRow,
    where: AdapterWhere,
    options: AdapterQueryOptions,
    deleted?: DeletedFilter,
  ): Promise<number>;
}

export async function findAllImpl(
  sequelize: Sequelize,
  defName: string,
  options: AdapterQueryOptions,
): Promise<SequelizeRow[]> {
  const TargetModel = sequelize.models[defName];
  const rows = await TargetModel.findAll(options);
  markWindowedIncludes(rows, (options as {include?: SequelizeInclude[]}).include);
  return rows;
}

export function countImpl(
  sequelize: Sequelize,
  defName: string,
  options: AdapterQueryOptions,
): Promise<number> {
  const TargetModel = sequelize.models[defName];
  // Sequelize's `count` is declared to return a grouped row array when the
  // options carry a `group`; ormize never counts by group, so the number
  // overload is the only one this can produce.
  return TargetModel.count(options);
}

/**
 * Reads `dataValues`, not `get()`. A getter's output would otherwise go
 * through the getter again on the way back. Eager-loaded relations and a
 * `belongsToMany` through row are instances inside `dataValues`, so this
 * recurses into them. An inline `full_count` is a plain value there too.
 */
export function snapshotRowsImpl(
  _defName: string,
  rows: SequelizeRow[],
): unknown[] {
  return rows.map(snapshotRow);
}

/**
 * Builds rows the way Sequelize builds a query result: `raw`, not new, over
 * the same include tree. That puts every relation where the resolvers read
 * it. The tree is cloned because building validates it in place, and the
 * options belong to the caller.
 */
export function restoreRowsImpl(
  sequelize: Sequelize,
  defName: string,
  snapshot: unknown[],
  options: AdapterQueryOptions,
): SequelizeRow[] {
  const {include, attributes} = options as {include?: SequelizeInclude[], attributes?: unknown};
  const TargetModel = sequelize.models[defName];
  const buildOptions: Record<string, unknown> = {
    isNewRecord: false,
    raw: true,
    include: include ? Utils.cloneDeep(include) : undefined,
    // Only the list form. `{include, exclude}` is resolved inside `findAll`,
    // and `bulkBuild` would try to `map` it.
    ...(Array.isArray(attributes) ? {attributes: [...attributes as unknown[]]} : {}),
  };
  // Validate the include tree once, as `findAll` does before it builds a
  // result. `bulkBuild` validates its own copy and never marks it validated,
  // so each root row's constructor validated the whole tree again. That was
  // more than half the cost of a restore on a page of eager-loaded rows. These
  // statics are Sequelize internals: without them, fall back to the slow path.
  const internals = TargetModel as unknown as Partial<{
    _conformIncludes(options: object, model: unknown): void;
    _expandIncludeAll(options: object): void;
    _validateIncludedElements(options: object): void;
  }>;
  if (include && internals._conformIncludes && internals._expandIncludeAll && internals._validateIncludedElements) {
    // Sequelize's own sequence (`bulkBuild`, `findAll`): conforming deletes an
    // empty `include`, which is then not expanded or validated.
    internals._conformIncludes(buildOptions, TargetModel);
    if (buildOptions.include) {
      internals._expandIncludeAll(buildOptions);
      internals._validateIncludedElements(buildOptions);
    }
    buildOptions.includeValidated = true;
  }
  const rows = TargetModel.bulkBuild(snapshot as Record<string, unknown>[], buildOptions);
  markWindowedIncludes(rows, include);
  return rows;
}

// eslint-disable-next-line @typescript-eslint/require-await -- `OrmAdapter.resolveSingleRelationship` is declared `Promise<AdapterRow>` (utilize/src/types/index.ts:313); the eager-loaded branch returns synchronously, so `async` is what satisfies the contract's return type
export async function resolveSingleRelationshipImpl(
  host: ReadHost,
  _defName: string,
  relationship: Association,
  source: SequelizeRow,
  request: AdapterRelationshipRequest,
): Promise<SequelizeRow> {
  const options = request.options || {};
  // Both the eager-loaded value and the generated accessor are reached off the
  // instance by name — see {@link rowFields}.
  const fields = rowFields(source);
  // `!== undefined`, not truthy. A relation that was eager-loaded and matched
  // nothing is `null` on the instance, and a truthy test read that as "not
  // loaded" and issued the accessor query anyway — which returned the same
  // null after a wasted round trip, once per parent row. Absent means absent;
  // `null` is an answer.
  if (fields[relationship.name] !== undefined) {
    return fields[relationship.name];
  }
  return rowFields(host.asInstance(relationship.source, source))[relationship.accessors.get](options);
}

// Count a relationship for its `total`. For hasMany, count the target directly
// with the foreign-key filter so the child's beforeCount hook fires (Sequelize's
// hasMany count accessor runs via findAll, which would fire beforeFind instead).
// belongsToMany and others use the through-table-aware association accessor.
export async function countRelationshipImpl(
  host: ReadHost,
  relationship: Association,
  source: SequelizeRow,
  where: AdapterWhere,
  options: AdapterQueryOptions,
  deleted?: DeletedFilter,
): Promise<number> {
  // Both branches build their own options bag from scratch, so the soft-delete
  // overlay has to be applied to each of them explicitly. Miss it and a nested
  // connection reports a `total` counting live rows only while its `edges`
  // return deleted ones.
  const overlay = deletedOverlay(host, relationship.target, deleted, where);
  const countWhere = overlay && overlay.where !== undefined ? overlay.where : where;
  const paranoid = overlay ? { paranoid: false } : {};
  if (relationship.associationType === "hasMany") {
    const TargetModel = host.sequelize.models[relationship.target];
    const filter = Object.assign({}, countWhere, {
      [relationship.foreignKey]: host.asInstance(relationship.source, source).get(relationship.sourceKey),
    });
    // `getGraphQLArgs` is this project's own addition to the options bag — the
    // hooks read it off `options`; Sequelize itself ignores it.
    return TargetModel.count(Object.assign({
      where: filter,
      getGraphQLArgs: options?.getGraphQLArgs,
    }, paranoid) as AdapterQueryOptions);
  }
  return rowFields(host.asInstance(relationship.source, source))[relationship.accessors.count](
    Object.assign({ where: countWhere, getGraphQLArgs: options?.getGraphQLArgs }, paranoid),
  );
}

export async function resolveManyRelationshipImpl(
  host: ReadHost,
  defName: string,
  relationship: Association,
  source: SequelizeRow,
  request: AdapterRelationshipRequest,
): Promise<AdapterRelationshipPage> {
  const {whereOperators, options = {}, countOnly} = request;
  const args = (request.args || {}) as ListArgs;
  // The eager-loaded value and the generated accessors are reached off the
  // instance by name — see {@link rowFields}.
  const fields = rowFields(source);
  if (countOnly && !(fields[relationship.name] !== undefined && fields[relationship.name] !== null)) {
    // Only `total` requested: run a count instead of fetching rows.
    const where = await host.processFilterArgument(args.where || {}, whereOperators, options);
    const total = await host.countRelationship(relationship, source, where, options, args.deleted);
    return { total, models: [] };
  }
  if (fields[relationship.name] !== undefined && fields[relationship.name] !== null) {
    // Eager-loaded at the root level (JOIN or `separate:true`). The rows are
    // already filtered and sorted, so return them — but when a per-parent
    // limit was applied the loaded length is the page size, not the true total,
    // so fetch an accurate count (fires the child's beforeCount natively).
    const val = fields[relationship.name];
    let models = Array.isArray(val) ? val : [val];
    // ...and "already limited" holds only on the `separate` path, where the
    // window went into SQL. A `required` relation keeps its INNER JOIN even
    // when paginated — the join is what filters the parents, and a per-parent
    // query cannot do that — so its window has to be applied here instead.
    //
    // Unconditional because it is a no-op whenever SQL already did the work:
    // that page is at most `limit` rows starting at `offset`. Doing it only
    // for the cases believed to need it is how the bound got lost in the
    // first place.
    const window = args.first != null ? args.first : args.last;
    if (window != null && models.length > 0) {
      // A `separate` include already applied the window in SQL — those rows
      // *are* the page, and slicing them again dropped rows whenever the page
      // held more rows than the cursor's offset. Only rows a JOIN loaded in
      // full (a `required` relation) are windowed here.
      if (!isWindowed(val)) {
        const start = request.offset || 0;
        models = models.slice(start, start + window);
      }
    }
    let total = models.length;
    if (args && (args.first != null || args.last != null)) {
      try {
        const where = await host.processFilterArgument(args.where || {}, whereOperators, options);
        total = await host.countRelationship(relationship, source, where, options, args.deleted);
      } catch (e) {
        // Fall back to the already-loaded page length, but surface the error —
        // silently returning a plausible-but-wrong count hides real defects
        // (e.g. a bug in filter processing) behind a valid-looking response.
        log.error("countRelationship failed; falling back to loaded page length", {
          relationship: relationship.name,
          err: e,
        });
        total = models.length;
      }
    }
    return {
      total,
      models,
    };
  }
  // Forwards the whole request: the positional form this replaced passed six of
  // eight arguments, so `selectedFields` and `runHook` were dropped here and a
  // JOIN-include `beforeFind` never fired on the relationship path.
  const { getOptions, countOptions } = await host.processListArgsToOptions(defName, request);
  const instance = rowFields(host.asInstance(relationship.source, source));
  const models = await instance[relationship.accessors.get](getOptions);
  let total;
  if (host.hasInlineCountFeature()) {
    total = await getInlineCountImpl(models);
  } else {
    total = await instance[relationship.accessors.count](countOptions);
  }
  return {
    total,
    models,
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- OrmAdapter.getInlineCount is declared `Promise<number>`; this reads synchronously but must stay async to satisfy that return type
export async function getInlineCountImpl(values: SequelizeRow[]): Promise<number> {
  // The count rides along as a `full_count` column on every row of the page
  // (a window function — see `processListArgsToOptions`), so the first row is
  // enough. It is not a declared attribute, hence the plain-object view.
  const first = values[0] ? rowFields(values[0]) : undefined;
  const row = first ? (first.dataValues || first) : undefined;
  if (!row || !row.full_count) {
    return 0;
  }
  return parseInt(row.full_count, 10);
}

/**
 * The row as a model instance, built around it when it is not one.
 *
 * A class or instance method can return plain objects typed as a model, and
 * gqlize resolves that model's relationships on them like any other row. The
 * association accessors (`getItems`, `countItems`, `get`) live on the model
 * prototype, so a plain object has none of them (#72). Building an instance
 * over its values — not a new record — gives it the accessors, keyed off
 * whatever primary and foreign keys it carries.
 */
export function asInstanceImpl(
  sequelize: Sequelize,
  defName: string,
  row: SequelizeRow,
): SequelizeRow {
  if (row && typeof (row as {get?: unknown}).get === "function") {
    return row;
  }
  return sequelize.models[defName].build(row as unknown as Record<string, unknown>, {isNewRecord: false});
}
