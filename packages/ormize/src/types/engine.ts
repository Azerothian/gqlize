// The types the resolution and mutation engine is written against.
//
// They live apart from `../manager` because the cross-adapter wiring and the
// relationship-mutation table are built over them, and would otherwise have to
// import back through the file that imports those modules. `../manager`
// re-exports every type here, which is where they have always been imported
// from.

import type {
  AdapterQueryOptions, AdapterRow, AdapterWhere, Association, Definition, OrmAdapter,
  RequestContext, Selection,
} from "@azerothian/utilize/types/index";

/**
 * An adapter row seen through its dynamically-named members: the relationship
 * accessors an adapter installs (`addFiles`, `setItem`, ...), `dataValues`,
 * `restore`. {@link AdapterRow} is `unknown` by contract, so the engine narrows
 * to this at the points that have to reach a member whose name is only known at
 * runtime.
 */
export type InstanceRow = { [member: string]: any };

/**
 * The options bag ormize builds for an adapter call. `getGraphQLArgs` is what
 * hooks read to reach the caller's context and — under gqlize — the execution
 * `info`, so it is the one member every adapter can count on being there.
 */
export type ResolveOptions = AdapterQueryOptions & {
  getGraphQLArgs: () => { context: RequestContext; info: unknown; source: AdapterRow };
};

/** A caller-supplied filter, before relay global ids have been translated out of it. */
export type MutationFilter = AdapterWhere;

/** A caller-supplied field bag for a create or an update. */
export type MutationInput = { [field: string]: unknown };

/**
 * The relationship sub-mutations for one relationship, as they arrive nested in a
 * create/update input: `{files: {create: [...], add: [...]}}`. Every operation is
 * optional, and the singular forms (`belongsTo`/`hasOne`) take a single filter
 * where a collection takes a list of them.
 */
export type RelationshipMutation = {
  create?: MutationInput[];
  update?: { where?: MutationFilter; limit?: number; input?: MutationInput }[];
  delete?: MutationFilter[];
  /** `true` to detach a singular relationship; filters to detach from a collection. */
  remove?: true | MutationFilter[];
  /** `belongsToMany` entries are `{where, through}`; other collections pass the filter directly. */
  add?: (MutationFilter | { where?: MutationFilter; through?: MutationInput })[];
  set?: MutationFilter | (MutationFilter | { where?: MutationFilter; through?: MutationInput })[];
  restore?: MutationFilter | MutationFilter[];
  select?: { where?: MutationFilter; input?: MutationInput } | { where?: MutationFilter; input?: MutationInput }[];
};

/**
 * A mutation input as the engine reads it: scalar columns alongside a
 * {@link RelationshipMutation} under each relationship name. The two cannot be
 * told apart structurally, so `processInputs` allow-lists the scalars by field
 * name and `processRelationshipMutation` picks out the relationships by
 * association name.
 */
export type MutationInputTree = { [name: string]: unknown };

/**
 * The slice of the manager that anything crossing an adapter boundary needs:
 * which adapter owns a model, and how to re-point a transaction handle at it.
 *
 * A structural interface rather than the class itself, so the modules below can
 * be read (and tested) without the 1,000-line manager — and because
 * `optionsForAdapter` is private, which a structurally-required public member
 * cannot be satisfied by. The manager therefore hands over a small object
 * literal rather than `this`.
 */
export interface AdapterRoutingHost {
  getModelAdapter(modelName: string): OrmAdapter;
  optionsForAdapter<T extends AdapterQueryOptions | undefined>(fromDefName: string, toDefName: string, options: T): Promise<T>;
}

/** {@link AdapterRoutingHost} plus what the relationship-mutation verbs re-enter. */
export interface MutationHost extends AdapterRoutingHost {
  getAssociations(defName: string): { [relName: string]: Association };
  getDefinition(defName: string): Definition;
  getGlobalKeys(defName: string): string[];
  processInputs(defName: string, input: MutationInputTree, args: unknown, context: RequestContext, info: unknown, model?: AdapterRow): Promise<MutationInput>;
  processCreate(defName: string, source: AdapterRow, args: { input: MutationInputTree }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]>;
  processDelete(defName: string, source: AdapterRow, args: MutationFilter, context: RequestContext, selection?: Selection): Promise<AdapterRow[]>;
  processRelationshipMutation(defName: string, source: AdapterRow, input: MutationInputTree | undefined, context: RequestContext, selection?: Selection): Promise<AdapterRow>;
}
