/**
 * Query selection, include plans, and ordering — the graphql-free description
 * of what a resolver wants fetched, threaded from the API surface to the adapter.
 */

import type {
  AdapterWhere,
  AdapterQueryOptions,
  RequestContext,
  FieldArgs,
  ExecutionInfo,
  LoadedRow,
} from "./primitives";
import type { Definition } from "./definitions";
import type { Permission } from "../gate";

/**
 * How a read treats soft-deleted rows: exclude them (the default, and what a
 * paranoid backend does on its own), include them alongside live rows, or return
 * only them — a trash view.
 *
 * Spelled as the GraphQL enum's value names because that is what arrives on the
 * argument; the adapter that understands soft deletes translates it.
 */
export type DeletedFilter = "EXCLUDE" | "INCLUDE" | "ONLY";

/**
 * One ORDER BY entry: a column, and the direction to sort it. This is the value
 * carried by a generated `${defName}OrderBy` enum member, so it is what arrives
 * on an `orderBy` argument and what an adapter translates into backend ordering.
 * The direction stays a plain `string` rather than `"ASC" | "DESC"` because a
 * backend may accept more (`NULLS LAST`, a collation), and this type is the
 * hand-off, not the vocabulary.
 */
export type OrderEntry = [column: string, direction: string];

/**
 * A query-shaping hook contributed by an exposed method's `input`, bound to the
 * occurrence it came from. Carried on {@link Selection.optionHooks}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `params` is the adapter-native options bag the hook reshapes and hands back, and the return is that same bag — the backend's vocabulary, not this package's.
export type OptionHook = (params: any, context?: RequestContext) => any | Promise<any>;

/**
 * Descriptor for a single relationship that should be eager-loaded as part of
 * the parent's root query. A superset of what an adapter's include handling
 * consumes (`required`, `where`, `orderBy`, `include`), enriched with pagination
 * and `separate` so collections can be batched at the root with correct
 * per-parent limits.
 *
 * Lives here rather than in gqlize because it is what {@link Selection.include}
 * carries, and `Selection` is the graphql-free hand-off between the two.
 */
export interface IncludeDescriptor {
  target: string;
  associationType: string;
  required?: boolean;
  where?: AdapterWhere;
  orderBy?: OrderEntry[];
  limit?: number;
  offset?: number;
  separate?: boolean;
  /**
   * How this node treats soft-deleted rows. Carried per node rather than once at
   * the root because a backend's soft-delete filter does not propagate into an
   * eager-loaded join — a parent fetched with deleted rows included still gets
   * only live children unless the include says otherwise.
   */
  deleted?: DeletedFilter;
  include?: IncludeMap[];
  /**
   * A `belongsToMany` in through mode (`Association.throughModel`): the join
   * model, and a filter on its rows. Such a descriptor is never handed to an
   * adapter. The engine only ever plans one for a `required` relation, and
   * turns it into a key filter on the parent before the query runs (see
   * `applyEngineRequired` in ormize), so it behaves the same on every adapter.
   */
  through?: { model: string; where?: AdapterWhere };
}

/** One level of the include plan, keyed by relationship name. */
export interface IncludeMap {
  [relName: string]: IncludeDescriptor;
}

/**
 * An include plan as a definition *declares* it, rather than as the engine
 * carries it. `target` and `associationType` are properties of the relationship,
 * not choices — they are looked up from the live association — so a declaration
 * is just `{items: {}}`, or `{items: {required: true}}` to shape the join.
 */
export interface DeclaredIncludeMap {
  [relName: string]: Partial<IncludeDescriptor>;
}

/**
 * The type a global key points at, keyed by field name: a primary key targets
 * its own model, a foreign key targets whatever the relationship points at.
 *
 * This is the half {@link globalKeysFromFields} throws away. Without it a decoder
 * has a value and no idea what it is *supposed* to be, so a `Task` id handed to a
 * `Post`-typed foreign key decodes happily and filters on the wrong row.
 */
export type GlobalKeyTargets = {[fieldName: string]: string};

/**
 * Backend-agnostic description of what a resolver wants fetched. Replaces the
 * GraphQL execution `info` in the ormize engine so the engine stays graphql-free.
 * GraphQL callers (gqlize) populate this from `info`; other callers (e.g. REST)
 * build it directly. `translateFilter`/`translateId` default to identity — gqlize
 * injects relay global-id translation.
 */
export type Selection = {
  /** eager-include plan (relations to JOIN) */
  include?: IncludeMap[];
  /** selected scalar field names */
  fields?: string[];
  /** fetch count without rows */
  countOnly?: boolean;
  /** raw arg variables (caller-provided) */
  variableValues?: {[name: string]: FieldArgs};
  /** opaque passthrough; gqlize stashes the real GraphQLResolveInfo here so hooks still see `info` */
  raw?: unknown;
  /**
   * default identity; gqlize passes replaceIdDeep bound to variableValues.
   * Generic so an absent filter stays absent: a relationship sub-mutation may
   * carry no `where` at all, and translating one is not what supplies it.
   */
  /**
   * `targets` names the type each global key points at (see
   * {@link GlobalKeyTargets}), so the decoder can reject an id minted for another
   * model instead of filtering on its raw pk. Optional: a caller that does not
   * know the targets gets the untyped decode this always did.
   */
  translateFilter?: <W extends AdapterWhere | undefined>(where: W, globalKeys: string[], targets?: GlobalKeyTargets) => W;
  /**
   * default identity; gqlize passes the configured id codec's decode, falling
   * back to the value untouched when it is not one of that codec's ids.
   *
   * `fieldName` is the global key the value arrived on, which is what lets the
   * codec check the id against that key's declared target type.
   */
  translateId?: (value: unknown, fieldName?: string) => unknown;
  /**
   * The permission bag of the projection making the call — for gqlize, the bag
   * its schema was built with. The write engine reads it where an input's shape
   * or a payload depends on what the projection offered: whether a
   * `belongsToMany` is in through mode, and which join-row columns a `through`
   * payload may write (`isThroughMode`, `isThroughInputField`). Absent means a
   * trusted server-side caller, held only to the structural rules.
   */
  permission?: Permission;
  /**
   * Query-shaping hooks contributed by the `input` of each selected exposed
   * method. Run after `processListArgsToOptions` **and after
   * `definition.before`**, in selection order, so a method's `input` sees the
   * final options and gets the last word on them.
   *
   * Each returns the params to carry forward; returning nothing keeps the
   * params it was handed (a hook that mutated them in place).
   */
  optionHooks?: OptionHook[];
};

/**
 * Context handed to an exposed method's declarative hooks. `source` is the
 * loaded row for `output` (absent for `input`, which runs before any row is
 * fetched); the rest mirror what a resolver sees.
 */
export type ExposedMethodContext = {
  /** The loaded row, for `output`. Absent on the query-building hooks. */
  source?: LoadedRow;
  /** The arguments the field was selected with, after `before`. */
  args?: FieldArgs;
  /** The request context. */
  context?: RequestContext;
  /** The raw GraphQL execution info, when the caller is GraphQL. */
  info?: ExecutionInfo;
  /** The definition the method is declared on. */
  modelDefinition?: Definition;
};

/**
 * The list arguments `Ormize.resolveFindAll` accepts.
 *
 * Only the cursor keys are named, because `cursorOffset` is the one thing ormize
 * itself reads off the bag; everything else — `where`, `orderBy`, `first`,
 * `include`, and whatever vocabulary a backend adds — is forwarded verbatim to
 * `adapter.processListArgsToOptions`, whose own `args` parameter is equally open.
 * Naming *only* the cursor keys and nothing else would make this a weak type, and
 * TypeScript rejects a weak type outright when the value shares no key with it —
 * which is every caller that passes just `where` and `first`.
 */
export type FindAllArgs = {
  after?: { index: number };
  before?: { index: number };
  limit?: number;
  [arg: string]: unknown;
};

/**
 * Everything an adapter needs to turn one list request into fetch options.
 *
 * Named fields rather than a positional tail. The 8-parameter form this replaces
 * had already drifted apart in a way the compiler could not see: the contract
 * named `graphQLArgs` at the position every implementation used for `options`,
 * one internal caller passed 6 of the 8 and so silently dropped `selectedFields`
 * and `runHook`, and test call sites carried runs of bare `undefined`.
 */
export interface AdapterListRequest {
  /** The GraphQL-style list args — `where`, `orderBy`, `first`/`last`, `include`. */
  args: {[name: string]: FieldArgs};
  /** Row offset, already resolved from a cursor by the caller. */
  offset?: number;
  /** What the caller wants fetched: selected fields, eager includes, count-only. */
  selection?: Selection;
  /** Per-field operator overrides applied when translating `where`. */
  whereOperators?: WhereOperators;
  /**
   * Caller-supplied base options — the transaction handle, the request context.
   * Values the adapter computes for this request (`attributes`, `include`,
   * `limit`, ...) take precedence: they encode the permission-filtered column
   * list, so letting a caller override them would widen the query.
   */
  options?: AdapterQueryOptions;
  /** Scalar field names to fetch, when the caller has already resolved them. */
  selectedFields?: string[];
  /** Hook dispatcher, so options-building can fire `beforeFind` on eager includes. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- this is the hook *dispatcher*: `value` and the trailing arguments differ per hook name (`beforeFind` gets an options bag, `afterCreate` a row), so it is the one place that cannot know which it is forwarding.
  runHook?: (defName: string, hookName: string, value: any, ...args: any[]) => Promise<any>;
}

/** An {@link AdapterListRequest} for the rows hanging off one parent row. */
export interface AdapterRelationshipRequest extends AdapterListRequest {
  /** Resolve only `total`, skipping the rows. */
  countOnly?: boolean;
  /** The caller's request context (`resolveSingleRelationship` forwards it to hooks). */
  context?: RequestContext;
}

/**
 * What `processListArgsToOptions` returns: the options for the fetch, plus the
 * options for a separate count query on backends without an inline count.
 */
export type AdapterListOptions = {
  getOptions: AdapterQueryOptions;
  countOptions?: AdapterQueryOptions;
};

// Forward import — WhereOperator/WhereOperators are defined in definitions.ts
// but needed here for AdapterListRequest and ExposedMethodWhere. Using
// `import type` to avoid runtime circularity.
import type { WhereOperator, WhereOperators } from "./definitions";

/**
 * How an exposed method contributes a filter to its model's `where` input.
 *
 * The `string` form is portable: it names a real column, and the method's
 * operator object is applied to that column instead. The object form is the
 * adapter-shaped escape hatch — `resolve` is an ordinary
 * {@link WhereOperator}, so it receives `(whereObject, options, value)` where
 * `value` is the operator object the client sent (`{like: "%smith%"}`) and
 * returns a real where-fragment.
 */
export type ExposedMethodWhere = string | {
  /** See {@link DefinitionField.type}. The value type each operator compares against; defaults to `String`. */
  type?: unknown;
  /** Restrict the generated operators to this list. Defaults to the adapter's full vocabulary. */
  operators?: string[];
  resolve: WhereOperator;
};

/**
 * How an exposed method contributes to its model's `orderBy` enum.
 *
 * The `string[]` form is portable: the named columns are ordered in sequence,
 * each in the requested direction. The function form is the adapter-shaped
 * escape hatch and returns the {@link OrderEntry} list to splice in.
 *
 * Both must produce push-down ordering. There is no in-memory post-sort: it
 * would break `first`/`last`, cursor offsets and `total`.
 */
export type ExposedMethodOrderBy =
  | string[]
  | ((direction: string, ctx: ExposedMethodContext) => OrderEntry[]);
