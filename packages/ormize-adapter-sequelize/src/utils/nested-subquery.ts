/**
 * The slice of a validated Sequelize include this reads and corrects. Sequelize
 * computes `subQuery` on every node in `Model._validateIncludedElements`.
 */
type ValidatedInclude = {
  subQuery?: boolean;
  include?: ValidatedInclude[];
};

/**
 * Keep an include's join out of the paginated subquery when its parent's join
 * is not in there either (#70).
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
 * Always safe to flip: a subquery can never join through a table joined only
 * outside it, so every node this changes was going to produce invalid SQL. The
 * parent filter is unaffected — the EXISTS is built from `required`, not from
 * these flags — and the root's own includes are left exactly as computed.
 *
 * Runs as a `beforeFindAfterOptions` hook: the one that fires after validation
 * and before the SQL is generated. In place, because Sequelize executes the
 * very object it hands the hook.
 */
export function keepNestedJoinsOutOfSubQuery(options: { include?: unknown }): void {
  const walk = (includes: ValidatedInclude[] | undefined, parentInSubQuery: boolean) => {
    for (const inc of includes || []) {
      if (!parentInSubQuery && inc.subQuery) {
        inc.subQuery = false;
      }
      walk(inc.include, Boolean(inc.subQuery));
    }
  };
  // The root query owns the subquery, so its direct includes are judged by
  // Sequelize alone.
  const roots = Array.isArray(options.include) ? options.include as ValidatedInclude[] : [];
  for (const inc of roots) {
    walk(inc.include, Boolean(inc.subQuery));
  }
}
