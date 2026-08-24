// Applying the relationship sub-mutations nested in a create/update input.
//
// The eight verbs — `create`, `update`, `delete`, `remove`, `add`, `set`,
// `restore`, `select` — were eight independent top-level `if (args.X)` blocks
// inside one 215-line method: a dispatch table wearing an if-chain. They are a
// table here, so each verb is one named function that can be read on its own and
// the order they run in is stated once, in `VERBS`, rather than being implied by
// the order of eight statements.

import waterfall from "@azerothian/utilize/utils/waterfall";
import type {
  AdapterQueryOptions, AdapterRow, AdapterWhere, Association, Definition, OrmAdapter,
  RequestContext, Selection,
} from "@azerothian/utilize/types/index";
import Events from "./events";
import type {
  InstanceRow, MutationFilter, MutationHost, MutationInput, MutationInputTree,
  RelationshipMutation, ResolveOptions,
} from "./types/engine";

/** One entry of a `belongsToMany` `add`/`set`: which rows, plus join-row columns. */
type LinkEntry = { where?: MutationFilter; through?: MutationInput };

/** One entry of `select`: which rows, plus the sub-tree to apply to each. */
type SelectEntry = { where?: MutationFilter; input?: MutationInput };

/**
 * Everything the verb handlers share for one association on one source row,
 * computed once by {@link applyRelationshipMutations} before the table runs.
 */
export interface MutationScope {
  host: MutationHost;
  association: Association;
  /** The related model — every adapter call below is aimed at *its* adapter. */
  targetName: string;
  targetDef: Definition;
  targetAdapter: OrmAdapter;
  /**
   * Options and context carrying the *target* adapter's transaction handle. The
   * ones in `defaultOptions`/`context` were opened by the source's adapter and
   * are meaningless to the target's when the two differ.
   */
  targetOptions: AdapterQueryOptions;
  targetContext: RequestContext;
  /** Built for the source's adapter — what the relationship accessors take. */
  defaultOptions: ResolveOptions;
  context: RequestContext;
  selection?: Selection;
  source: AdapterRow;
  /** `source` reached through its accessor names — see {@link InstanceRow}. */
  row: InstanceRow;
  /** The whole sub-tree, which `update` and `delete` re-enter recursively. */
  input: MutationInputTree;
  args: RelationshipMutation;
  /** belongsTo/hasOne: one record where a collection takes a list of them. */
  singular: boolean;
  isBtm: boolean;
  /** A caller filter with relay global ids translated out, ready for the target. */
  where(filter: unknown): Promise<AdapterWhere>;
  /** A singular accessor returns one record or null; every verb wants a list. */
  asList(res: unknown): InstanceRow[];
}

/** Existing target rows matching a caller filter, on the target's own adapter. */
async function findByFilter(s: MutationScope, filter: unknown): Promise<AdapterRow[]> {
  return s.targetAdapter.findAll(s.targetName, Object.assign({where: await s.where(filter)}, s.targetOptions));
}

/** Related rows through the relationship's `get` accessor, so its hooks fire. */
async function getRelated(s: MutationScope, options: AdapterQueryOptions): Promise<InstanceRow[]> {
  return s.asList(await s.row[s.association.accessors.get](Object.assign({}, options, s.defaultOptions)));
}

/** Create new target records and attach each one to the source. */
const applyCreate = async(s: MutationScope, values: MutationInput[]) => {
  await waterfall(values, async(arg: MutationInput) => {
    if (s.targetDef.before) {
      arg = await s.targetDef.before({
        params: arg, args: s.args, context: s.context, info: s.selection?.raw,
        modelDefinition: s.targetDef,
        type: Events.MUTATION_CREATE,
      });
    }
    const [result] = await s.host.processCreate(s.targetName, s.source, {input: arg}, s.targetContext, s.selection);
    // `associationType` is an open string, so this stays a test for the two
    // collection types rather than reusing `singular`: an unrecognised type
    // falls through to `set`, which is what it did before.
    const collection = s.association.associationType === "hasMany" || s.association.associationType === "belongsToMany";
    await s.row[collection ? s.association.accessors.add : s.association.accessors.set](result, s.defaultOptions);
  });
};

/** Write fields onto the related records a filter selects, then recurse into them. */
const applyUpdate = async(s: MutationScope, entries: { where?: MutationFilter; limit?: number; input?: MutationInput }[]) => {
  await waterfall(entries, async(arg: { where?: MutationFilter; limit?: number; input?: MutationInput }) => {
    const {where, limit, input} = arg;
    const targets = await getRelated(s, {limit, where: await s.where(where)});
    let i: MutationInput = await s.host.processInputs(s.targetName, input as MutationInputTree, s.args, s.targetContext, s.selection?.raw);
    if (s.targetDef.before) {
      i = await s.targetDef.before({
        params: input, args: s.args, context: s.context, info: s.selection?.raw,
        modelDefinition: s.targetDef,
        type: Events.MUTATION_UPDATE,
      });
    }
    await Promise.all(targets.map(async(model: InstanceRow) => {
      const m = await s.targetAdapter.update(model, i, s.targetOptions);
      await s.host.processRelationshipMutation(s.targetDef.name as string, m, input as MutationInputTree, s.targetContext, s.selection);
      return m;
    }));
  });
};

/** Delete the related records a filter selects, recursing into them first. */
const applyDelete = async(s: MutationScope, filters: MutationFilter[]) => {
  await waterfall(filters, async(arg: MutationFilter) => {
    const targets = await getRelated(s, {where: await s.where(arg)});
    await Promise.all(targets.map(async(model: InstanceRow) => {
      const defName = s.targetDef.name as string;
      await s.host.processRelationshipMutation(defName, model, s.input, s.targetContext, s.selection);
      if (s.targetDef.before) {
        await s.targetDef.before({
          params: model, args: s.args, context: s.context, info: s.selection?.raw,
          model, modelDefinition: s.targetDef,
          type: Events.MUTATION_DELETE,
        });
      }
      await s.host.processDelete(defName, s.source, arg, s.targetContext, s.selection);
      return model;
    }));
  });
};

/** Detach related records without deleting them. */
const applyRemove = async(s: MutationScope, value: true | MutationFilter[]) => {
  if (s.singular) {
    // belongsTo/hasOne: disassociate by nulling the relationship.
    if (value === true) {
      await s.row[s.association.accessors.set](null, s.defaultOptions);
    }
    return;
  }
  // The list forms are the collection branch of each pair — a singular
  // relationship takes one filter, and is handled above.
  await waterfall(value as MutationFilter[], async(arg: MutationFilter) => {
    const results = await findByFilter(s, arg);
    if (results.length > 0) {
      await s.row[s.association.accessors.removeMultiple](results, s.defaultOptions);
    }
  });
};

/** Attach existing records that a filter selects. */
const applyAdd = async(s: MutationScope, entries: (MutationFilter | LinkEntry)[]) => {
  await waterfall(entries, async(arg: MutationFilter | LinkEntry) => {
    // belongsToMany add entries are `{where, through}`; other collections
    // pass the filter directly.
    const entry = (arg || {}) as LinkEntry;
    const through = s.isBtm ? entry.through : undefined;
    const results = await findByFilter(s, s.isBtm ? entry.where : (arg as MutationFilter));
    if (results.length > 0) {
      await s.row[s.association.accessors.addMultiple](results, withThrough(s, through));
    }
  });
};

/** Replace what the relationship points at with the records a filter selects. */
const applySet = async(s: MutationScope, value: MutationFilter | (MutationFilter | LinkEntry)[]) => {
  if (s.singular) {
    // belongsTo/hasOne: associate one existing record found by filter.
    const found = await s.targetAdapter.findAll(s.targetName, Object.assign({where: await s.where(value as MutationFilter), limit: 1}, s.targetOptions));
    await s.row[s.association.accessors.set](found[0] || null, s.defaultOptions);
    return;
  }
  // Collections: replace the entire set with all matching existing records.
  const all: AdapterRow[] = [];
  let through: MutationInput | undefined;
  await waterfall(value as (MutationFilter | LinkEntry)[], async(arg: MutationFilter | LinkEntry) => {
    const entry = (arg || {}) as LinkEntry;
    if (s.isBtm && entry.through !== undefined) {
      through = entry.through;
    }
    all.push(...await findByFilter(s, s.isBtm ? entry.where : (arg as MutationFilter)));
  });
  await s.row[s.association.accessors.set](all, withThrough(s, through));
};

/** Restore soft-deleted (paranoid) related records scoped to this relationship. */
const applyRestore = async(s: MutationScope, value: MutationFilter | MutationFilter[]) => {
  await eachFilter(s, value, async(arg: MutationFilter) => {
    const records = await getRelated(s, {where: await s.where(arg), paranoid: false});
    await Promise.all(records
      .filter((r) => r && r.deletedAt)
      .map((r) => r.restore(s.targetOptions)));
  });
};

/**
 * Find related records and run further relationship mutations on them via
 * `arg.input`. The selected records themselves are NOT modified — no field
 * write, no create/update/delete; scalar fields in `input` are ignored (only
 * relationship sub-mutations are applied).
 */
const applySelect = async(s: MutationScope, value: SelectEntry | SelectEntry[]) => {
  await eachFilter(s, value, async(arg: SelectEntry) => {
    const records = await getRelated(s, {where: await s.where(arg.where)});
    await waterfall(records, async(m: InstanceRow) => {
      await s.host.processRelationshipMutation(s.targetDef.name as string, m, arg.input as MutationInputTree, s.targetContext, s.selection);
    });
  });
};

/** Accessor options with a `belongsToMany` join row's own column values, if any. */
function withThrough(s: MutationScope, through: MutationInput | undefined) {
  return through !== undefined ? Object.assign({through}, s.defaultOptions) : s.defaultOptions;
}

/** A singular relationship's verb takes one filter where a collection's takes a list. */
async function eachFilter<T>(s: MutationScope, value: T | T[], fn: (arg: T) => Promise<void>) {
  if (s.singular) {
    await fn(value as T);
    return;
  }
  await waterfall(value as T[], fn);
}

/** `undefined`/`null` is "not asked for"; every other value, `false` included, is. */
const isSet = (value: unknown) => value !== undefined && value !== null;

/**
 * The verbs, in the order they are applied — which is part of the contract, so it
 * is stated here once instead of being implied by the order of eight statements.
 *
 * `present` differs per verb on purpose: the four list verbs are absent-or-a-list,
 * so truthiness is the test the if-chain used; `remove`/`set`/`restore`/`select`
 * take scalars whose falsy values are still a request, so those test for null.
 */
const VERBS: {
  name: keyof RelationshipMutation;
  present: (value: unknown) => boolean;
  apply: (scope: MutationScope, value: any) => Promise<void>;
}[] = [
  {name: "create", present: Boolean, apply: applyCreate},
  {name: "update", present: Boolean, apply: applyUpdate},
  {name: "delete", present: Boolean, apply: applyDelete},
  {name: "remove", present: isSet, apply: applyRemove},
  {name: "add", present: Boolean, apply: applyAdd},
  {name: "set", present: isSet, apply: applySet},
  {name: "restore", present: isSet, apply: applyRestore},
  {name: "select", present: isSet, apply: applySelect},
];

/**
 * Apply the relationship sub-mutations nested under each association name of
 * `input` to the row that was just created, updated or selected. Returns `source`
 * so callers can keep chaining off it.
 */
export async function applyRelationshipMutations(
  host: MutationHost,
  defName: string,
  source: AdapterRow,
  input: MutationInputTree | undefined,
  context: RequestContext,
  defaultOptions: ResolveOptions,
  selection?: Selection,
): Promise<AdapterRow> {
  if (!input) {
    // A select with no `input` is a plain find — there is nothing nested to
    // apply. Reading `input[key]` per association would throw on the way past.
    return source;
  }
  const translateFilter = selection?.translateFilter || (<W,>(w: W) => w);
  // A collection's getter returns an array, a singular relationship's returns one
  // record or null — every verb treats what it got back as a list.
  const asList = (res: unknown): InstanceRow[] => Array.isArray(res) ? res : (res ? [res] : []);
  const associations = host.getAssociations(defName);
  // The relationship accessors are reached off the row by name — see {@link InstanceRow}.
  const row = source as InstanceRow;
  await waterfall(Object.keys(associations), async(key: string) => {
    const association = associations[key];
    const targetName = association.target;
    const targetAdapter = host.getModelAdapter(targetName);
    const targetGlobalKeys = host.getGlobalKeys(targetName);
    const targetDef = host.getDefinition(targetName);
    if (!input[key]) {
      return;
    }
    // Anything handed to the target's adapter needs that adapter's transaction
    // handle: for a cross-adapter relationship the one in `defaultOptions` /
    // `context` was opened by this model's adapter and is meaningless there.
    // (Resolving it enrols the target adapter in the unit of work, so only do
    // it for a relationship the mutation actually touches.)
    const targetOptions = await host.optionsForAdapter(defName, targetName, defaultOptions);
    const targetContext = await host.optionsForAdapter(defName, targetName, context);
    const args = input[key] as RelationshipMutation;
    const scope: MutationScope = {
      host, association, targetName, targetDef, targetAdapter,
      targetOptions, targetContext, defaultOptions, context, selection,
      source, row, input, args,
      singular: association.associationType === "belongsTo" || association.associationType === "hasOne",
      isBtm: association.associationType === "belongsToMany",
      where: async(filter) => targetAdapter.processFilterArgument(
        translateFilter(filter as AdapterWhere, targetGlobalKeys),
        targetDef.whereOperators,
        targetOptions,
      ),
      asList,
    };
    for (const verb of VERBS) {
      const value = args[verb.name];
      if (verb.present(value)) {
        await verb.apply(scope, value);
      }
    }
  });
  return source;
}
