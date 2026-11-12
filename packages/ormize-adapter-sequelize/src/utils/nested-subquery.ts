/**
 * The slice of a validated Sequelize include this reads and corrects. Sequelize
 * computes `subQuery` on every node in `Model._validateIncludedElements`.
 */
type ValidatedInclude = {
  subQuery?: boolean;
  subQueryFilter?: boolean;
  required?: boolean;
  include?: ValidatedInclude[];
};

/**
 * Keep the paginated subquery to the joins that decide which roots are on the
 * page: those under an unbroken chain of `required` includes. Two Sequelize 6
 * placement bugs are corrected here.
 *
 * First, keep an include's join out of the paginated subquery when its
 * parent's join is not in there either (#70).
 *
 * Sequelize 6 marks a non-duplicating child `subQuery` whenever it and some
 * ancestor are `required` (`hasParentRequired && hasRequired`), without asking
 * whether that ancestor is itself in the subquery. A required hasMany or
 * belongsToMany is not: it is joined in the outer query and filters the
 * parents through its own EXISTS (`subQueryFilter`). So a required child of one
 * — `items(required) { task(required) }` under a limit — had its JOIN emitted
 * inside the subquery, joining through a table that is not there, and the
 * database rejected the SQL (`no such column: items.taskId`). An explicit
 * `subQuery: false` on the include does not help; validation overwrites it.
 *
 * Second, an include that is not required — or sits under one that is not —
 * never filters the root: see the comment in the walk.
 *
 * Runs as a `beforeFindAfterOptions` hook: the one that fires after validation
 * and before the SQL is generated. In place, because Sequelize executes the
 * very object it hands the hook.
 */
export function keepNestedJoinsOutOfSubQuery(options: { include?: unknown }): void {
  const walk = (includes: ValidatedInclude[] | undefined, parentInSubQuery: boolean, chainRequired: boolean) => {
    for (const inc of includes || []) {
      // `required` filters its *own* parent's rows, and the root's only when
      // every level between them is required too. Sequelize decides placement
      // from `hasRequired`, which counts descendants: a non-required include
      // with a required child somewhere below was pulled into the paginated
      // subquery or given an EXISTS filter on the root, so a deep `required`
      // silently filtered roots — but only for some shapes of the chain. Kept
      // out of the subquery and off the root filter, the include is LEFT JOINed
      // in the outer query, where Sequelize nests a required child inside it
      // (`LEFT JOIN (parent INNER JOIN child)`): the child then removes the
      // parent's rows and nothing above them.
      const required = chainRequired && inc.required === true;
      if (!required) {
        inc.subQueryFilter = false;
        inc.subQuery = false;
      }
      // A subquery can never join through a table joined only outside it.
      if (!parentInSubQuery && inc.subQuery) {
        inc.subQuery = false;
      }
      walk(inc.include, Boolean(inc.subQuery), required);
    }
  };
  // The root query owns the subquery: its direct includes start inside it.
  walk(Array.isArray(options.include) ? options.include as ValidatedInclude[] : [], true, true);
}

/** The slice of Sequelize's query generator the through-join fix wraps. */
type ThroughJoinGenerator = {
  quoteIdentifier(identifier: string): string;
  // A function-typed property, not a method: it is read off the generator and
  // called back with `this` re-bound explicitly.
  generateThroughJoin: (
    this: ThroughJoinGenerator,
    include: ThroughJoinInclude, includeAs: unknown, parentTableName: string, topLevelInfo: ThroughJoinTopLevel,
  ) => { condition: string };
};
type ThroughJoinInclude = {
  subQuery?: boolean;
  association: { sourceKey: string };
  parent: { subQuery?: boolean; association?: unknown; model: { name: string } };
};
type ThroughJoinTopLevel = { subQuery?: boolean; options: { model: { name: string } } };

/**
 * Point a belongsToMany's join at the column the paginated subquery exposes.
 *
 * When a belongsToMany is joined in the outer query under a parent that lives
 * in the subquery — `toB(required) { toA(required) { linkB(required) } }`
 * under a limit — Sequelize 6's `generateThroughJoin` names the parent's key
 * as one identifier, `"toB->toA.id"`. The subquery projects that column as
 * `"toB.toA.id"` (its external alias), so the database rejected the SQL with
 * `no such column`. Its sibling `generateJoin` makes exactly this `->` to `.`
 * rewrite; the through-join path forgot it.
 *
 * Wrapped on this Sequelize instance's own query generator, so other instances
 * in the process are untouched; the rewrite only fires on the one shape the
 * bug produces, and only replaces the identifier it built.
 */
export function fixNestedThroughJoin(queryGenerator: unknown): void {
  const generator = queryGenerator as ThroughJoinGenerator;
  const original = generator.generateThroughJoin;
  generator.generateThroughJoin = function(include, includeAs, parentTableName, topLevelInfo) {
    const result = original.call(this, include, includeAs, parentTableName, topLevelInfo);
    const parentIsTop = !include.parent.association && include.parent.model.name === topLevelInfo.options.model.name;
    if (topLevelInfo.subQuery && !include.subQuery && include.parent.subQuery && !parentIsTop
      && typeof parentTableName === "string" && parentTableName.includes("->")) {
      const key = include.association.sourceKey;
      const broken = this.quoteIdentifier(`${parentTableName}.${key}`);
      const fixed = this.quoteIdentifier(`${parentTableName.replace(/->/g, ".")}.${key}`);
      result.condition = result.condition.split(broken).join(fixed);
    }
    return result;
  };
}
