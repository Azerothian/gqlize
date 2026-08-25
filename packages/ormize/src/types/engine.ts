// The types the resolution and mutation engine is written against.
//
// They live apart from `../manager` because the cross-adapter wiring and the
// relationship-mutation table are built over them, and would otherwise have to
// import back through the file that imports those modules. `../manager`
// re-exports every type here, which is where they have always been imported
// from.

import type {
  AdapterQueryOptions, AdapterRow, AdapterWhere, Association, Definition, GlobalKeyTargets,
  OrmAdapter, PortableWhere, RequestContext, Selection,
} from "@azerothian/utilize/types/index";
import type { ResolvedScope, ScopeOperation } from "@azerothian/utilize/gate";

/**
 * An adapter row seen through its dynamically-named members: the relationship
 * accessors an adapter installs (`addFiles`, `setItem`, ...), `dataValues`,
 * `restore`. {@link AdapterRow} is `unknown` by contract, so the engine narrows
 * to this at the points that have to reach a member whose name is only known at
 * runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- members are read AND called (`row[accessors.get](...)`) by a name only known at runtime; `unknown` would block the call without a cast at every one of the many call sites below
export type InstanceRow = { [member: string]: any };

/**
 * The options bag ormize builds for an adapter call. `getGraphQLArgs` is what
 * hooks read to reach the caller's context and — under gqlize — the execution
 * `info`, so it is the one member every adapter can count on being there.
 */
export type ResolveOptions = AdapterQueryOptions & {
  getGraphQLArgs: () => { context: RequestContext; info: unknown; source: AdapterRow };
};

/**
 * A caller-supplied filter, before relay global ids have been translated out of
 * it — and before `processFilterArgument` has translated it into the backend's
 * vocabulary.
 *
 * This was aliased to `AdapterWhere`, which is the adapter-*native* shape and so
 * the exact opposite of what a caller's filter is. Nothing depended on the
 * distinction until `permission.scope`, which returns a filter that must be
 * merged while it is still portable.
 */
export type MutationFilter = PortableWhere;

/** A caller-supplied field bag for a create or an update. */
export type MutationInput = { [field: string]: unknown };

/**
 * The instance-method transforms one create/update asked to run, keyed by exposed
 * method name. A transform declaring args carries its arg bag; one declaring none
 * is a `Boolean` flag, and only `true` runs it.
 */
export type MutationApply = { [methodName: string]: unknown };

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
  /** `permission.scope` for one model and operation, memoised for the request. */
  resolveScope(defName: string, operation: ScopeOperation, context: RequestContext): Promise<ResolvedScope>;
  /** Throw or stay quiet when a scope denies a write outright, per `onScopeMiss`. */
  scopeMiss(defName: string, operation: ScopeOperation): void;
  /**
   * A model's scope for one operation, translated into *its own* adapter's
   * vocabulary and ANDed onto `where`. `false` when the scope denies outright:
   * there is no adapter-native "match nothing" to hand back, so the caller
   * short-circuits instead.
   *
   * The cross-adapter accessors reach past `resolveFindAll` by design — they run
   * one query on each of two datastores — so they need the filter already in the
   * shape the adapter they are about to call expects, which only the manager can
   * build (it owns the definitions and the `whereOperators` derived from them).
   */
  scopedWhere(
    defName: string, operation: ScopeOperation, context: RequestContext,
    where: AdapterWhere | undefined, options: AdapterQueryOptions | undefined,
  ): Promise<AdapterWhere | undefined | false>;
}

/** {@link AdapterRoutingHost} plus what the relationship-mutation verbs re-enter. */
export interface MutationHost extends AdapterRoutingHost {
  getAssociations(defName: string): { [relName: string]: Association };
  getDefinition(defName: string): Definition;
  getGlobalKeys(defName: string): string[];
  getGlobalKeyTargets(defName: string): GlobalKeyTargets;
  processInputs(defName: string, input: MutationInputTree, args: unknown, context: RequestContext, info: unknown, model?: AdapterRow, operation?: ScopeOperation): Promise<MutationInput>;
  processCreate(defName: string, source: AdapterRow, args: { input: MutationInputTree; apply?: MutationApply }, context: RequestContext, selection?: Selection): Promise<AdapterRow[]>;
  processDelete(defName: string, source: AdapterRow, args: MutationFilter, context: RequestContext, selection?: Selection): Promise<AdapterRow[]>;
  processRelationshipMutation(defName: string, source: AdapterRow, input: MutationInputTree | undefined, context: RequestContext, selection?: Selection): Promise<AdapterRow>;
  /**
   * Assert rows a write has already produced still satisfy the model's scope,
   * throwing if any of them does not. A no-op when nothing is imposed.
   *
   * The relationship verbs need this because `add`/`set` move a row by
   * re-pointing a foreign key: there is no field write for a scope's `set` to
   * hold in place, and no filter left to merge into once the accessor has run.
   */
  assertRowsInScope(defName: string, operation: ScopeOperation, context: RequestContext, rows: AdapterRow[], options: AdapterQueryOptions | undefined): Promise<void>;
}
