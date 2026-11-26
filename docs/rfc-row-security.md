# RFC: Row security — relationship filters, global filters and Postgres RLS

> **Status:** Phases 1 and 2 are implemented.
>
> Phase 1 (relationship filters) is documented in [`specifications.md`](specifications.md) (§7,
> "Relationship quantifiers in scope" and "`via` leaf and `not` combinator") and
> [`guide.md`](guide.md) (§8, "Relationship quantifiers", "`via` leaf", "`not` combinator").
>
> Phase 2 (global filters) is documented in [`specifications.md`](specifications.md) (§4 model
> definition schema, §5 soft delete, §7 permissions) and [`guide.md`](guide.md) (§8 "Global
> filters" section and the soft-delete section). The design text is preserved below.
> Two deviations from §5: soft delete still runs on the adapter's own `paranoid` mechanism rather
> than being re-expressed as a built-in global filter (the `deleted` argument now reaches
> single-valued relationships and `node(id:)`, which was the user-visible goal of §5.4); and a
> global filter an adapter can't express fails at its first query, not at `initialise` (§10 Q6).
>
> Phase 3a (declaration, compilation, reconciliation) is implemented.
> Phase 3b (per-request runtime enforcement) is partially implemented.
>
> **Implemented:**
> - Adapter config (`rls` on `SequelizeAdapterOptions`): `settings(ctx)`, `role(ctx)`,
>   `bypassRole`, `enforce`. Names validated at construction.
> - `beginTransaction(context?)` applies `set_config` (bound values) and `SET LOCAL ROLE`.
> - **Database enforcement is tied to the transaction's identity.** The engine skips its scope
>   for a model only when the operation runs on a transaction *that model's adapter* opened with
>   a request's settings and role applied, and only for the same identity (role and settings) the
>   transaction was opened with. Any other transaction, whether bare, opened by the caller, or
>   from another adapter, and any principal switched mid-transaction, keeps the engine scope:
>   enforcement is "both", never "neither".
> - **Read wrapping** (§6.5) for root, many- and single-relationship reads of RLS models.
> - **No identity → deny** (§6.5): no query runs under the connection's own role.
> - Scope predicate (read/delete), scope hooks and post-write re-check skipped under the
>   condition above; scope `set` on create/update still applied; global filters still applied.
> - Error mapping: `42501` → `ScopeEscapeError`; on soft delete/restore → configuration error.
> - Build-time checks (§6.7).
>
> **Deferred, and what that means in practice:**
> - **Direct-model surfaces** (class/instance methods, raw SQL, `extend` fields) don't run inside
>   an RLS transaction, so on an RLS model they still need `scopeAware` / `unscoped` (and raw SQL a
>   `:scope…` parameter), exactly as without RLS. `unscoped` under `bypassRole` and `orm.asSystem`
>   are not implemented.
> - **`onScopeMiss: "throw"`** on an RLS model behaves as `"empty"` (warned at build).
> - **`softDeleteFlag`** is refused at construction rather than accepted and ignored.
> - **Read cache**: correctness is pinned by `ormize/__tests__/rls-engine.test.ts` (two principals,
>   cache on); keying cached RLS reads on the identity, so they can be served from cache, is not done.
> - **Insert divergence** (§4.5): a row visible only through a child the same mutation creates is
>   refused under RLS and allowed by the engine.
>
> **Parity** for the §7 group-manager rules runs in `gqlize/__tests__/rls-parity.test.ts`: the same
> assertions on SQLite (engine scope) and on Postgres (generated policies only, no scope clause in
> the SQL, role switch proven by a superuser read that sees every row). Writing it found and fixed:
> `via` hops compiled with hasMany columns on belongsTo, unqualified policy columns binding to the
> subquery's table, an `allow` rule emitting a column named `__rawTrue`, insert `WITH CHECK`
> dropping quantifier branches out of `all`, policy recursion (now hop functions, §7), `not` dropped
> on creates, a created row vouching for itself (§4.5), and, in Phase 1, an `and`/`or` at the top of
> a quantifier's inner filter being dropped by the Sequelize compiler (the scope silently widened).

## Contents

1. [Motivation](#1-motivation)
2. [What exists today](#2-what-exists-today)
3. [Design overview](#3-design-overview)
4. [Phase 1: Relationship filters](#4-phase-1-relationship-filters)
5. [Phase 2: Global filters](#5-phase-2-global-filters)
6. [Phase 3: Postgres row-level security](#6-phase-3-postgres-row-level-security)
7. [Worked example: group managers](#7-worked-example-group-managers)
8. [Testing](#8-testing)
9. [Prior art: Drizzle](#9-prior-art-drizzle)
10. [Open questions](#10-open-questions)

---

## 1. Motivation

Two kinds of row rule come up in every non-trivial deployment, and the library handles only part of
each:

- **Global rules** hold for every caller: soft-deleted rows are hidden, archived rows are hidden,
  rows of another tenant never appear. They don't depend on who is asking.
- **Self rules** depend on the caller: "my rows", "rows in my tenant", and the structured kind,
  "users in a group I manage". The last one is the hard case, because the answer lives in a
  different table from the row being filtered.

On top of that, deployments on Postgres want the database itself to enforce the self rules, so that
raw SQL, a forgotten class method, or a bug in the engine can't leak rows. That is Postgres
row-level security (RLS).

This RFC adds three things, in order:

1. **Relationship filters** in the portable filter vocabulary, so a scope can say "a membership
   exists such that…".
2. **Global filters** declared on the model, with soft delete re-expressed as one of them.
3. **Postgres RLS**: policies declared on the model, applied by `sync()`, and enforced at query
   time by running each request under its own settings and role.

## 2. What exists today

See [`specifications.md` §7](specifications.md#7-permissions) and
[`guide.md` §8](guide.md#row-level-scope-permissionscope) for the full description.

- `permission.scope(defName, operation, options, context)` is resolved per request, may be async,
  and returns `undefined` (unscoped), `false` (deny), a filter, or `{where, set, native}`. The
  engine merges it at its read and write chokepoints (`ormize/src/engine/scope-bridge.ts`), the
  sequelize model hooks impose a second copy (`ormize/src/scope-hooks.ts`), a post-write re-check
  refuses a write that moves a row out of scope, and `scope-audit.ts` refuses a direct-model surface
  that has not declared itself `scopeAware` or `unscoped`.
- `createRoleBasedPermissions` compiles `own` / `tenant` / `group` / `none` leaves with `any` / `all`
  into a scope.
- Soft delete comes from the adapter (`OrmAdapter.softDeletes`, Sequelize `paranoid`), with a
  `deleted: EXCLUDE | INCLUDE | ONLY` argument on list fields gated by `permission.queryDeleted`.

What is missing:

| Need | Gap |
| --- | --- |
| "Users in a group I manage" | `PortableWhere` cannot follow a relationship. The `group` leaf only compares a column on the row with a list carried on the principal, which needs a `groupId` column on `User` and the list loaded up front. |
| Global rules other than soft delete | No way to declare one. Each deployment writes it into `scope`, mixed in with the caller-dependent rules. |
| Soft delete everywhere | `belongsTo` / `hasOne` fields and `node(id:)` take no `deleted` argument (spec §13). |
| Database-enforced rules | Nothing. The engine is the only enforcement point on Postgres. |

## 3. Design overview

The three phases layer, and each one is useful alone:

```
                    client where
                         │  AND
          global filters (phase 2)       ← same for every caller, always applied by the engine
                         │  AND
            ┌────────────┴─────────────┐
   model is RLS-enabled on an       any other model
   RLS-capable datasource?          (SQLite, Valkey, Postgres without rls)
            │                              │
   Postgres RLS policies (phase 3)   permission.scope (phase 1 can follow relationships),
   enforced by the database under    merged by the engine + sequelize scope hooks
   SET LOCAL ROLE; the engine        (both exist today)
   injects no scope filter
```

Principles carried through every phase:

- **One enforcement point per model.** Where the datasource supports RLS and the model has it
  enabled, the database policy is the row rule and the engine does **not** inject the scope's
  filter into the query (§6.6). Everywhere else, the engine's `scope` is the row rule, as it is
  today. Self rules are never enforced twice by default; `enforce: "both"` exists for deployments
  that want the layered behaviour back.
- **One source for both enforcement points where possible.** A policy can be written in the same
  filter vocabulary the scope uses and compiled to SQL, so a rule means the same thing on SQLite
  (engine) and Postgres (policy). Raw SQL stays available for what the vocabulary can't say.
- **Fail closed.** A filter that can't be expressed is a `ScopeConfigurationError`, never a
  silently dropped clause. An unset RLS setting reads as `NULL`, which matches no row.
- **Building a schema never opens a DB connection.** Nothing here changes that. Only `sync()` and
  query execution touch the database.

---

## 4. Phase 1: Relationship filters

### 4.1 Vocabulary

A relationship name may appear in a `PortableWhere` wherever a field name may. Its value is a
quantifier over the related rows, following Prisma's spelling because it is the most widely known:

| Relationship | Quantifiers | Meaning |
| --- | --- | --- |
| `hasMany`, `belongsToMany` | `some: Where` | At least one related row matches. |
| | `none: Where` | No related row matches. |
| | `every: Where` | Every related row matches (vacuously true when there are none). |
| `belongsTo`, `hasOne` | `is: Where` | The related row exists and matches. |
| | `isNot: Where` | The related row is absent or does not match. |

Quantifiers nest, and the inner `Where` is the related model's vocabulary, so relationships chain:

```ts
{ memberships: { some: {
    group: { is: { memberships: { some: { userId: { eq: me }, role: { eq: "manager" } } } } },
} } }
```

An empty inner filter is allowed and means "any related row": `{ tags: { some: {} } }` is "has at
least one tag".

Field and relationship names already share one namespace per model (both become fields of the
GraphQL type), so there is no ambiguity in the key.

### 4.2 Scope

Phase 1 adds the vocabulary to `PortableWhere` as consumed by the **engine**, which means `scope`,
global filters (phase 2), policy compilation (phase 3), and direct `orm` callers. It does **not**
add the quantifiers to the generated GraphQL `where` input. That is a schema change with its own
permission questions (filtering on a relationship leaks whether a related row exists), and it is
left for a follow-up behind a build-time permission key (§10).

### 4.3 Adapter support

| Adapter | Behaviour |
| --- | --- |
| Sequelize | Compiled to a correlated `EXISTS (SELECT 1 FROM … WHERE …)` / `NOT EXISTS`. `every` is `NOT EXISTS (… AND NOT (inner))`. Identifiers are quoted through the dialect's query generator and values bound, never interpolated. `belongsToMany` goes through the join table. A registered join model (`Association.throughModel`) is read with its own read scope applied inside the subquery, matching `engine/through-reads.ts`. |
| Valkey | `ScopeConfigurationError`. The adapter has no join to express it with. |
| MikroORM | `ScopeConfigurationError` in the first cut. MikroORM's own relation filters (`{ rel: { $some: … } }`) are the natural follow-up. |
| Any | A quantifier over a relationship whose target lives on a **different adapter** is a `ScopeConfigurationError`: one statement can't reach another database. |

The compiler lives in a new `ormize-adapter-sequelize/src/relationship-filters.ts`, called from
`processFilterArgument`. Nothing in `gqlize/src/graphql/*` changes.

### 4.4 Role-based sugar

A new `via` leaf in the `scope` rules compiles to a relationship filter:

```ts
scope: {
  User: {
    via: "memberships.group.memberships",
    match: { userId: "$principal.id", role: "manager" },
  },
}
```

`via` is a dot-separated relationship path from the scoped model. Every hop except the last becomes
`some` (or `is` on a single-valued hop), and `match` is the innermost filter. A value beginning with
`$principal.` is read from the principal, through the same `principal` reader as the other leaves.
A missing principal value is a deny, consistent with `own` and `group`.

A `not` combinator joins `any` and `all`, compiling to the portable `not`. Under `not`, a branch
that denies (a missing principal value) still denies the whole leaf rather than inverting to
"allow everything", so `not` can never widen a scope through a missing value.

### 4.5 Writes

Read filtering is unchanged in shape. Writes need two rules:

- **Creates.** `set` can't force a value through a relationship, so a create on a model whose scope
  uses a quantifier has no `set` to impose. The post-write re-check is what enforces it, and it must
  run **after** the mutation's nested relationship writes. Otherwise creating a user together with
  their membership in one mutation is refused, because at the moment the `User` row is inserted the
  membership doesn't exist yet. The re-check moves from the end of the row's own write to the end of
  `mutationEntry`, inside the same transaction, so a failed check still rolls everything back.

  An RLS model (§6.6) has no such ordering to move: Postgres checks `WITH CHECK` when each row is
  inserted and can't defer it, so an insert policy that requires the membership fails before the
  nested write could create it. *As implemented*, `compileRlsPolicies` keeps the full rule in the
  insert `WITH CHECK`. An earlier draft left quantifier branches out, which widens any `all` or
  `not` a branch sits in: the §7 `Membership` write rule lost its "you manage this group" half and
  let any member add anyone to any group. A brand-new row has no children yet, so the full rule
  costs nothing a dropped branch would have allowed safely. The consequence is a known divergence:
  creating a row visible only through a child the same mutation creates is refused under RLS, and
  allowed by the engine. Insert with `RETURNING` also requires the new row to pass the `SELECT`
  policy, which no deferral could get around.

  A created row never vouches for itself. The engine's re-check leaves the rows a create wrote out of
  every quantifier over their own model; Postgres evaluates `WITH CHECK` before the row is visible,
  so both answer alike (found by the §7 parity test: a member could insert `role: "manager"` into a
  group and pass the "you manage this group" check with that very row).
- **The join model is a privilege boundary.** A rule that grants access through `Membership.role`
  is only as strong as the write scope on `Membership`. A manager who can update their own
  membership row, or create one in another group, can grant themselves anything. The guide section
  for this feature has to say so in its first paragraph, and the worked example (§7) scopes
  `Membership` writes explicitly.

### 4.6 Cache

No change. A relationship filter is part of the adapter options after scope resolution, which the
read cache already fingerprints. The read's touched-models set must include every model a
quantifier reaches, so a write to `Membership` invalidates cached `User` reads filtered through it.
`read-cache-bridge.ts` collects that set from the include plan today; it gains the quantifier walk.

---

## 5. Phase 2: Global filters

### 5.1 Declaration

```ts
const Task = {
  name: "Task",
  define: { /* … */ },
  options: {
    filters: {
      archived: { where: { archived: { eq: false } } },
      published: { where: { publishedAt: { ne: null } }, operations: ["read"] },
    },
  },
};
```

| Key | Meaning |
| --- | --- |
| `where` | A `PortableWhere`, including phase 1 quantifiers. Cannot reference the principal: a global filter is the same for every caller, and that is what lets it be cached and reasoned about separately. Anything caller-dependent belongs in `scope`. |
| `operations` | Which of `read` / `update` / `delete` it applies to. Defaults to all three. `create` has no `where` to filter and is never listed. |

### 5.2 Where it applies

Global filters are AND-ed in at the same chokepoints as `scope`, through `scope-bridge.ts`, so they
reach every place a read or write already does: root lists, `total`, `node(id:)`, eager-loaded and
lazy relationship fields of every arity, `through-reads.ts`, nestize, temporalize, and the `update`
/ `delete` / `select` write paths. The sequelize scope hooks impose them as well.

Order of composition: `clientWhere AND globalFilters AND scope`. The order has no effect on the
result, but it is fixed so the cache fingerprint is stable.

### 5.3 Bypass

A global filter is lifted only server-side, never by a client argument:

```ts
await orm.withoutFilters(["archived"], async () => {
  // reads here include archived rows; scope still applies
});
```

`withoutFilters` sets an `AsyncLocalStorage` entry, like `runWithContext`, and the bypass is part of
the read-cache key. Lifting a filter does not lift `scope` or RLS. A client-facing bypass argument
is an open question (§10).

### 5.4 Soft delete as a global filter

Soft delete keeps its storage mechanism (the adapter's `paranoid`), and the engine models it as a
built-in global filter named `deleted`, driven by the existing `deleted` argument instead of
`withoutFilters`. Two things change:

- `belongsTo` / `hasOne` fields and `node(id:)` gain the `deleted` argument, gated by
  `permission.queryDeleted` exactly as list fields are. This closes the spec §13 gap.
  **This changes the generated schema**: `schema:build` and the golden snapshots must be updated in
  the same change.
- `update` and `delete` keep their implicit live-rows-only predicate. Restore first, then write.

---

## 6. Phase 3: Postgres row-level security

### 6.1 Declaring policies

```ts
import { rls, sql } from "@azerothian/ormize/rls";

const Task = {
  name: "Task",
  define: { /* … */ },
  options: {
    rls: {
      enabled: true,
      force: true,
      policies: {
        own: {
          for: "all",
          to: "app_member",
          using: { ownerId: { eq: rls.setting("app.user_id", "uuid") } },
        },
        audit: {
          for: "select",
          to: "app_auditor",
          using: sql`true`,
        },
      },
    },
  },
};
```

`options.rls`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | `ENABLE ROW LEVEL SECURITY` on the table. |
| `force` | `true` | `FORCE ROW LEVEL SECURITY`. Without it the table owner bypasses every policy, and in most deployments the owner is the role the app connects as. Opting out has to be written down. |
| `policies` | `{}` | Keyed by policy name. The key is the Postgres policy name, prefixed with the table name (`Task_own`) so names are unique per database. |

Each policy, following Postgres and Drizzle's option names:

| Key | Default | Meaning |
| --- | --- | --- |
| `as` | `"permissive"` | `permissive` (OR-ed with other permissive policies) or `restrictive` (AND-ed). |
| `for` | `"all"` | `all`, `select`, `insert`, `update` or `delete`. |
| `to` | `"public"` | A role name, an array of them, or `public`. |
| `using` | — | Which existing rows are visible / targetable. A `PortableWhere` or `sql\`…\``. |
| `withCheck` | same as `using` for `all` / `insert` / `update` | Which new rows may be written. A `PortableWhere` or `sql\`…\``. |

A table with `enabled: true` and no policies denies every row. That is legal and occasionally wanted
(a table only a bypass role touches), so it is a build-time **warning**, not an error.

Adapters other than Postgres ignore `options.rls`. A definition can carry it and still run on SQLite
in tests, where only the app-layer scope applies.

### 6.2 Compiling a `PortableWhere` to a policy

A policy written as a filter is compiled to SQL by the Postgres adapter, using the same operator
table as the runtime filter compiler, plus phase 1 quantifiers as correlated `EXISTS` subqueries.

Values in a policy can't be concrete (the policy is created once, for every request), so they are
**setting references**:

```ts
rls.setting("app.user_id", "uuid")
// → (SELECT nullif(current_setting('app.user_id', true), '')::uuid)
rls.setting("app.group_ids", "uuid[]")
// → (SELECT string_to_array(nullif(current_setting('app.group_ids', true), ''), ',')::uuid[])
```

- The `true` argument makes a setting that was never defined return `NULL` instead of raising.
- The `nullif(…, '')` is required, not cosmetic. Once a connection has set a custom setting with
  `set_config(…, true)`, it reads back as `''` (not `NULL`) after that transaction ends. On a pooled
  connection that is the normal state. Without `nullif`, a text comparison against `''` happens to
  match nothing, but a cast fails: `''::uuid` raises `invalid input syntax for type uuid`, so every
  query by a request that forgot its settings would error instead of returning nothing. (Verified
  on PGlite 0.5.4 / Postgres 18.3, see §8.)
- Either way the value ends up `NULL`, which compares unequal to everything, so a request that
  forgot to set it sees nothing. That is the fail-closed direction.
- The `(SELECT …)` wrapper makes Postgres evaluate it once per statement (as an init plan) rather
  than once per row.
- An array setting is set as a comma-joined string and split in SQL. `eq` against an array setting
  compiles to `= ANY(…)`.

Unsupported in a compiled policy, and a `ScopeConfigurationError` at build: operators with no SQL
form in the adapter's operator table, custom `whereOperators`, and quantifiers across adapters.

### 6.3 Generating policies from the role rules

`createRoleBasedPermissions` already compiles a role's `scope` rules into a predicate. A companion,
`compileRlsPolicies(rules, options)`, compiles the same rules into `options.rls.policies`, one policy
per (role, model, operation group):

```ts
const rules = { member: { scope: { Task: { own: "ownerId" } } }, manager: { /* … */ } };

const permission = createRoleBasedPermissions(role, rules, { principal });
const policies = compileRlsPolicies(rules, {
  dbRole: (appRole) => `app_${appRole}`,
  settings: { id: "app.user_id", tenantId: "app.tenant_id", groupIds: "app.group_ids" },
});
// policies.Task → { member_read: { for: "select", to: "app_member", using: … }, … }
```

- `dbRole` maps an app role to a database role. At runtime the adapter's `role(ctx)` must return the
  same mapping (§6.5), so the role that's active is the one the policy names.
- `settings` maps principal keys to setting names. The `$principal.id` that the app layer reads from
  the principal becomes `rls.setting("app.user_id")` in the policy. The adapter's `settings(ctx)`
  must set every one of them.
- `read` / `write` / per-operation splits map to `for: select` and `insert` / `update` / `delete`.
  `none` emits `using: true`. `"deny"` emits no policy, which in RLS is a deny.

Both outputs come from the same rules tree, so the app-level filter and the database policy say the
same thing. A test asserts it for the fixtures in §7 (`gqlize/__tests__/rls-parity.test.ts`).

*As implemented:* a `via` leaf is emitted as the same `__via` marker the engine's sugar uses and
resolved by the adapter's policy compiler, which knows each hop's association type (`is` for
belongsTo/hasOne, `some` otherwise). A policy that follows a relationship into a table with RLS of
its own runs that hop in a generated function; see §7.

### 6.4 Applying policies in `sync()`

`Ormize.sync()` calls `adapter.sync()` on every adapter (today, in parallel). An adapter that
implements the new optional `OrmAdapter.syncRowSecurity(models)` has it called right after its own
`sync()`, so its tables exist before any policy that references them. Policies can't reference
another adapter's tables (§6.2), so no cross-adapter ordering is needed.

`syncRowSecurity` runs everything in **one transaction**, in this order:

1. **Serialise.** `SELECT pg_advisory_xact_lock(<fixed gqlize key>)`, so several instances booting at
   once apply changes one at a time instead of racing on the same DDL.
2. **Roles** (only with `Ormize({ rls: { manageRoles: true } })`, off by default). Postgres has no
   `CREATE ROLE IF NOT EXISTS`, so each role named in a policy's `to` is looked up in `pg_roles` and
   created `NOLOGIN` when missing. Existing roles are never altered or dropped.
3. **Tables.** For each RLS model, read `relrowsecurity` / `relforcerowsecurity` from `pg_class` and
   run `ALTER TABLE … ENABLE` / `FORCE ROW LEVEL SECURITY` only if not already set.
4. **Policies.** For each declared policy, generate its full SQL text and a hash of that text, then
   look it up in `pg_policy` by table and name:

   | Found | Action |
   | --- | --- |
   | No | `CREATE POLICY …`, then `COMMENT ON POLICY … IS 'gqlize:managed:<hash>'`. |
   | Yes, comment hash equals the new hash | Nothing. |
   | Yes, `for` and `as` unchanged | `ALTER POLICY … TO … USING (…) WITH CHECK (…)`, then update the comment. |
   | Yes, `for` or `as` changed | `DROP POLICY` then `CREATE POLICY`, then comment. `ALTER POLICY` cannot change either, so this is the only path that drops. It is safe inside the transaction: no other session sees the table without the policy. |
   | Yes, but no `gqlize:managed` comment | `ScopeConfigurationError`: a hand-written policy has the name gqlize wants. gqlize never takes over a policy it didn't create. |

   The hash is over gqlize's own generated text, not over what Postgres stores. Postgres keeps the
   expression in a rewritten form (`pg_get_expr`), so comparing against that would report a
   difference on every run.
5. **Stale policies.** A policy on an RLS-managed table whose comment starts with `gqlize:managed:`
   but which is no longer declared is dropped. Policies without the marker (hand-written, or the
   hosting provider's) are never touched.
6. **Disabled models.** Tables gqlize enabled carry a marker policy,
   `<table>__gqlize_rls_marker`, created `AS RESTRICTIVE FOR ALL TO PUBLIC USING (TRUE)` and
   commented `gqlize:rls`. (Implemented this way rather than as a table comment, which the
   application may own. It must be restrictive: a permissive `TRUE` is ORed with the real policies
   and opens the table to every role.) If such a table's model no longer has `rls.enabled`, its managed
   policies are dropped and `NO FORCE` / `DISABLE ROW LEVEL SECURITY` run. A table without the
   marker is never disabled.

The steady state (nothing changed) takes no table locks: steps 3–6 only read catalogs. That matters
because `ALTER TABLE` and `ALTER POLICY` take `ACCESS EXCLUSIVE`, and a sync on every boot that
re-altered every policy would block traffic on every RLS table each deploy.

`reset()` drops and recreates tables, which drops their policies with them, then runs the same steps.

The same generator is exposed for deployments that run their own migrations:

```bash
gqlize rls:sql --config ./gqlize.config.ts > migrations/0042_rls.sql
```

It prints idempotent DDL without connecting: `DO` blocks that check the catalogs and choose
create, alter or drop+create, mirroring steps 2–6. It reads definitions only, so it runs in CI with
no database.

### 6.5 Running requests under RLS

Configuration on the Postgres adapter:

```ts
new SequelizeAdapter(sequelize, {
  rls: {
    settings: (ctx) => ({
      "app.user_id": ctx.user.id,
      "app.group_ids": ctx.user.groupIds,       // arrays are comma-joined
    }),
    role: (ctx) => `app_${ctx.user.role}`,
    bypassRole: "app_system",                   // optional, see below
    enforce: "database",                        // default; "both" also merges the scope (§6.6)
  },
});
```

`settings` and `role` are read from the request context, which comes from the server's own auth
(GraphQL context, nestize `req`, temporalize activity context). They must never be built from
client-supplied arguments. Drizzle's Supabase helper is safe for the same reason: it reads a
signed token, not request data.

**When a transaction opens** on this adapter (the auto-wrap around a mutation, `orm.transaction`,
or the read wrap below), the adapter runs, on that connection:

```sql
SELECT set_config('app.user_id', $1, true), set_config('app.group_ids', $2, true);
SET LOCAL ROLE "app_member";
```

and in `finally`, before the connection returns to the pool, resets both. Both are already
transaction-scoped (`true`, `LOCAL`), so the reset is defence in depth, as in Drizzle's wrapper.
Session-level `SET` is never used: on a pooled connection it would carry one request's identity into
the next.

This needs `OrmAdapter.beginTransaction(context?)`. Today it takes no arguments.

**Reads.** Reads of an RLS model are not currently in a transaction, so they would run with no
settings and see nothing. The engine wraps a read in a transaction when its root model, or any model
in its include plan, is RLS-enabled on that adapter (`resolution.ts`). Reads of non-RLS models are
unchanged.

**Nested context.** Inside one transaction the settings are fixed. A `runWithContext` that switches
to a different principal inside an open RLS transaction raises, rather than silently running the
second principal's reads under the first one's identity.

**Surfaces that hold the model directly** (class methods, instance methods, raw-SQL class methods,
`options.extend` fields) are run inside the same lazily-opened transaction `orm.transaction` uses.
Any RLS adapter they touch through the orm, or through the `transaction` handed to them on the
context, begins its transaction with the request's settings and role. A raw driver call that
ignores the handed transaction runs on a bare pooled connection with no settings, so it sees no
rows: wrong, but in the safe direction. Under database enforcement these surfaces no longer need
a `scopeAware` / `unscoped` declaration for an RLS model, and a raw statement no longer needs a
`:scope…` parameter (§6.6).

**Bypass.** Surfaces declared `unscoped` run under `bypassRole` when it is configured. That role
must own the tables or have `BYPASSRLS`. When `bypassRole` is absent they run under the request's
role and RLS applies to them, which is the safer default: forgetting to configure a bypass makes an
`unscoped` method see less, not more. Work with no request at all (a migration script, a cron job)
uses `orm.asSystem(fn)`, which runs under `bypassRole` and fails if none is configured.

**No identity.** When `role(ctx)` returns nothing (no authenticated user), the engine refuses the
query as a scope deny instead of opening a transaction under the connection's own role, which owns
the tables and would see everything. Deployments that serve anonymous reads return an explicit
`app_anonymous` role and give it the policies it should have.

**Read cache.** The read-cache key gains the resolved settings and role for reads on RLS models. An
RLS filter never appears in the adapter options, so without this the cache would serve one caller's
rows to another. The cache's current rule of bypassing reads inside a transaction is relaxed for the
engine's own read wrap (which only exists to carry settings); it still bypasses reads inside a
caller's `orm.transaction`, which may see uncommitted writes.

**Errors.** RLS outcomes map onto the scope errors that already exist:

| Postgres | Engine |
| --- | --- |
| `USING` hides the row from `UPDATE` / `DELETE` (zero rows affected) | Same as a scope miss: empty by default. Under `onScopeMiss: "throw"`, see below. |
| `WITH CHECK` violation (`42501`, "new row violates row-level security policy") | `ScopeEscapeError`. |

`onScopeMiss: "throw"` needs to tell "hidden by a policy" from "no such row", and under RLS the
database answers both with zero rows. When `bypassRole` is configured, a zero-row `update` /
`delete` on an RLS model re-runs its match under `bypassRole` (count only, nothing returned) and
throws `ScopeDeniedError` if a row exists. That is exactly the existence leak `"throw"` already
accepts. Without `bypassRole`, `"throw"` behaves as `"empty"` on RLS models, and the build warns.

### 6.6 Enforcement: the policy replaces the injected scope

On a model that is RLS-enabled on a datasource that supports RLS, the database is the only thing
that applies the self rules. The engine does not merge the scope's filter into the query, so a
read sends the client's `where` plus the global filters and nothing else, and the policy does the
rest. This avoids filtering every row twice and keeps generated SQL readable, and the policy also
covers paths the engine never sees.

The decision is made **per model**, not per datasource. A Postgres datasource with `rls` configured
can still hold models without `rls.enabled`, and those keep the engine's `scope` exactly as today.
Dropping the injected filter for a model with no policy would leave it unprotected, so that
combination is never allowed to happen silently.

What changes for an RLS model:

| Mechanism | Today | RLS model under database enforcement |
| --- | --- | --- |
| Scope `where` merged into reads, `update`, `delete`, `select` (`scope-bridge.ts`) | Applied | **Skipped.** The scope predicate isn't called for `read` or `delete`. |
| Scope `native` | Applied | Skipped. |
| Scope `false` (deny outright) | Short-circuits | Not consulted. A role with no matching policy sees no rows, which is the same outcome. |
| Scope `set` on `create` / `update` | Forced | **Still applied.** It's a value, not a filter. It makes a create land on the right owner instead of being rejected by `WITH CHECK` when the client leaves the field out. `WITH CHECK` still verifies the result. The predicate is called for `create` / `update` for this alone. |
| Sequelize scope hooks (`scope-hooks.ts`) | Re-impose the filter | Skipped for the model. |
| Post-write re-check (`ScopeEscapeError`) | Re-reads the row | Replaced by `WITH CHECK`, mapped to the same error (§6.5). |
| `scope-audit.ts` declarations (`scopeAware` / `unscoped`, raw-SQL `:scope…` parameters) | Required when a scope is configured | Not required for the model. `unscoped` still means "run under `bypassRole`". |
| Global filters (phase 2), including soft delete | Applied | **Still applied.** They are query semantics the client can see (the `deleted` argument), and soft delete can't live in a policy (§6.8). |
| Read-cache key | Fingerprints the merged filter | Fingerprints the settings and role instead (§6.5). |

`enforce` on the adapter's `rls` options picks the mode:

| `enforce` | Behaviour |
| --- | --- |
| `"database"` (default) | As in the table above. |
| `"both"` | The engine also merges the scope as today, so the rule is enforced twice. For deployments that want issue #40's layered defence back, or that are migrating and want to compare the two. |

**The trade-off.** Today's enforcement is deliberately layered (issue #40, decision 8): the engine
merge, the model hooks and the post-write re-check each catch what the others miss. Under
`"database"`, a wrong policy is a leak with nothing behind it. Two things make up for that. Policies
compiled from the same rules as the scope (§6.3) can't drift from them. And the parity tests (§8)
run the same assertions on SQLite, where the engine enforces, and on Postgres, where the policy
does, so a policy that drifts from the rule fails a test rather than shipping.

**Mixed deployments.** A relationship between an RLS model and a non-RLS model works in either
direction. In one Postgres query, RLS applies to the RLS table's rows inside the join, and the
engine's scope applies to the other. Across adapters, each side is enforced by its own mechanism.

### 6.7 Build-time checks

Raised when the schema or the orm is built, with no database connection:

- An RLS-enabled model on an adapter with no `rls.settings`: error.
- An RLS-enabled model with no policies: warning (§6.1).
- A model on an RLS datasource whose role rules give it a `scope`, but which isn't RLS-enabled:
  warning. It's still protected (the engine keeps scoping it, §6.6), but it's probably an oversight.
  A hand-written `scope` function can't be inspected this way, so this only covers the role-based
  rules.
- `onScopeMiss: "throw"` with RLS models and no `bypassRole`: warning (§6.5).
- A compiled policy using an unsupported operator, a custom `whereOperator`, or a quantifier that
  crosses adapters: `ScopeConfigurationError`.
- A `compileRlsPolicies` setting name that the adapter's `settings` never sets cannot be checked
  statically (it's a function), so `syncRowSecurity` and the first request on each role check it at
  runtime and log once.

### 6.8 Soft delete under RLS

**Rule: no policy may hide soft-deleted rows unless the engine can lift it.** Soft delete stays a
phase 2 global filter, applied by the engine on every datasource, RLS or not.

**Why.** Postgres applies `SELECT` policies to an `UPDATE` or `DELETE` that reads the table (any
`WHERE`, or `RETURNING`), and to the `UPDATE`'s **new** row as well as the old one. Every write the
Sequelize adapter issues has a `WHERE`. So once a `SELECT` policy says `"deletedAt" IS NULL`:

- the update that soft-deletes produces a row the policy hides, and is rejected;
- a soft-deleted row can't be found by the update that restores it, the delete that removes it for
  good, or a read that asks for it.

**Measured.** Every soft-delete path the adapter has, through Sequelize over pglite-socket, as a
non-superuser role with `app.user_id = 'u1'`. Seed: row 1 is u1's and live, row 2 is u1's and
soft-deleted, row 3 is u2's and live. The SQL is what Sequelize emits for a paranoid model:

| Operation (SQL) | Policies don't mention `deletedAt` | `SELECT` policy hides deleted rows |
| --- | --- | --- |
| Read, default `deleted: EXCLUDE` (`WHERE "deletedAt" IS NULL`) | [1] | [1] |
| Read, `deleted: INCLUDE` (no filter) | [1, 2] | **[1], silently** |
| Read, `deleted: ONLY` (`WHERE "deletedAt" IS NOT NULL`) | [2] | **[], silently** |
| `delete` on a paranoid model (`findAll`, then `UPDATE … SET "deletedAt" = $1 WHERE "id" = $3`) | Row 1 soft-deleted | **`42501` "new row violates row-level security policy"** |
| Bulk soft delete (`UPDATE … WHERE "deletedAt" IS NULL AND "id" = $2`) | Row 1 soft-deleted | **`42501`** |
| `restore` (`findAll` with `paranoid: false`, then `UPDATE … SET "deletedAt" = NULL`) | Row 2 restored | **0 rows, silently** |
| Bulk `Model.restore` | Row 2 restored | **Reports success, changes nothing** |
| Hard delete of a soft-deleted row (`destroy({ force: true })`) | Row 2 removed | **0 rows, silently** |
| `update` of a live row | Works | Works |

Row 3 was never visible in either column, so the owner rule held throughout.

The same failures happened with every policy shape that puts `"deletedAt" IS NULL` on the `SELECT`
path:

- a `for select` policy, with separate permissive `insert` / `update` / `delete` policies that allow
  the change;
- `deletedAt` in both `USING` and `WITH CHECK` of a `for all` policy;
- a permissive owner policy plus a **restrictive** `for select` policy on `deletedAt`.

The error names the restrictive policy, but the outcome is the same.

So the failures come in three kinds, and only one of them is loud:

1. **An error**, on every soft delete. Under the §6.5 mapping this would surface as
   `ScopeEscapeError`, which tells the caller they tried to move a row out of their scope when
   they asked for an ordinary delete.
2. **Writes that do nothing**: `restore`, bulk restore and hard delete report zero rows (or
   success) and change nothing.
3. **Reads that are wrong**: `deleted: INCLUDE` and `ONLY` quietly return the live rows or nothing.
   A caller allowed to see deleted rows by `queryDeleted` gets an empty trash and no error.

**What gqlize does about it.**

- `compileRlsPolicies` never emits `deletedAt` into a policy. Soft delete is the global filter
  `deleted` (§5.4), applied by the engine for RLS models too (§6.6).
- `syncRowSecurity` warns when a policy on a paranoid model mentions the model's `deletedAt` column,
  and names this section. It can only spot this in policies written in the filter vocabulary; a
  raw `sql` policy can't be inspected.
- A `42501` raised by a soft delete or a restore is reported as a configuration error that points
  here, not as `ScopeEscapeError`.

**If the database must hide deleted rows anyway** (raw SQL outside gqlize, other clients on the same
database), the only shape that worked in every row of the table is a flag the engine controls:

```sql
CREATE POLICY task_select ON task FOR SELECT TO app_member USING (
  owner = (SELECT nullif(current_setting('app.user_id', true), ''))
  AND ("deletedAt" IS NULL OR current_setting('app.include_deleted', true) = 'on')
);
-- insert / update / delete policies: owner only, no deletedAt
```

The engine sets `app.include_deleted = 'on'` for the transaction of every soft delete, restore and
hard delete, and for reads whose `deleted` argument is `INCLUDE` or `ONLY` (which `queryDeleted`
already gates). With the flag on, all nine rows above behave like the left-hand column. With it off,
they behave like the right-hand column. This mode is opt-in (`rls.softDeleteFlag: "app.include_deleted"`)
and comes with a cost: the flag is per transaction, so everything in a mutation that soft-deletes,
including its nested writes and any raw SQL it runs, sees deleted rows for the rest of that
transaction. The engine's global filter still hides them from everything it issues itself.

### 6.9 Operational notes

- **Two roles.** `sync()` needs a role that owns the tables (DDL requires it). The app should run
  requests as a different role. When one connection does both, `force: true` is what keeps the
  policies applying to app traffic.
- **Locks.** A sync that does change a policy takes `ACCESS EXCLUSIVE` on that table for the length
  of the transaction. Ship policy changes the way you ship any other DDL.
- **Indexes.** A policy's subqueries run per statement. Index what they filter on, for example
  `membership (user_id, role, group_id)` for §7.
- **Views.** A view reading an RLS table needs `security_invoker = true` for the caller's policies
  to apply. gqlize does not create views today, so this is advice, not behaviour.
- **TRUNCATE** and foreign-key checks (`REFERENCES`) ignore RLS, per Postgres.

---

## 7. Worked example: group managers

Requirement: a user sees and edits their own row; a group manager also sees and edits every user in
the groups they manage; only managers change memberships, and never their own.

```ts
const User       = { name: "User",       define: { id, name, email } };
const Group      = { name: "Group",      define: { id, name } };
const Membership = { name: "Membership", define: { id, userId, groupId, role } }; // role: "member" | "manager"
// User hasMany memberships; Membership belongsTo user, group; Group hasMany memberships
```

Rules, shared by the app layer and the database:

```ts
const managesUser = {
  via: "memberships.group.memberships",
  match: { userId: "$principal.id", role: "manager" },
};

const rules = {
  member: {
    scope: {
      User: { any: [{ own: "id" }, managesUser] },
      Group: { via: "memberships", match: { userId: "$principal.id" } },
      Membership: {
        read: { via: "group.memberships", match: { userId: "$principal.id" } },
        write: {
          all: [
            { via: "group.memberships", match: { userId: "$principal.id", role: "manager" } },
            { not: { own: "userId" } },                       // never your own membership
          ],
        },
      },
    },
  },
};

const permission = createRoleBasedPermissions("member", rules, { principal: (c) => c.user });
const policies   = compileRlsPolicies(rules, {
  dbRole: () => "app_member",
  settings: { id: "app.user_id" },
});
```

(`not` is the combinator proposed in §4.4; today the sugar has `any` and `all` only.)

What the engine adds to a `User` read on SQLite (or any non-RLS datasource), with `me = "u1"`:

```ts
{ or: [
  { id: { eq: "u1" } },
  { memberships: { some: { group: { is: { memberships: { some: {
      userId: { eq: "u1" }, role: { eq: "manager" } } } } } } } },
] }
```

And the policy `sync()` creates for it:

```sql
CREATE POLICY "User_member_read" ON "User" AS PERMISSIVE FOR SELECT TO "app_member"
USING (
  "User"."id" = (SELECT nullif(current_setting('app.user_id', true), '')::uuid)
  OR EXISTS (
    SELECT 1 FROM "Membership" m1
    JOIN "Group" g ON g."id" = m1."groupId"
    WHERE m1."userId" = "User"."id"
      AND EXISTS (
        SELECT 1 FROM "Membership" m2
        WHERE m2."groupId" = g."id"
          AND m2."userId" = (SELECT nullif(current_setting('app.user_id', true), '')::uuid)
          AND m2."role" = 'manager'
      )
  )
);
```

The policy on `User` reads `Membership`, which has its own RLS. Postgres applies `Membership`'s
policies inside that subquery too. *As implemented, the SQL above is not what ships, because it
cannot run:* `Membership`'s own read policy reads `Membership` (`group.memberships`), and `Group`'s
and `Membership`'s policies read each other, which Postgres refuses as infinite recursion (42P17)
on the first query. And where a chain does terminate, a dependent rule quietly returns less than
the engine's, whose quantifiers never apply the related model's scope.

So a hop that reaches a table with RLS runs in a generated function:

```sql
CREATE FUNCTION "public"."gqlize_rls_<hash>"() RETURNS SETOF INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, "public", pg_temp
AS $gqlize_rls$ SELECT "_rls0"."userId" FROM "pm_memberships" AS "_rls0" WHERE "_rls0"."userId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "pm_groups" AS "_rls1" WHERE "_rls1"."id" = "_rls0"."groupId" AND EXISTS (…)) $gqlize_rls$;

-- the policy:
USING ("pm_users"."id" = (SELECT nullif(current_setting('app.user_id', true), '')::integer)
   OR COALESCE("pm_users"."id" IN (SELECT * FROM "public"."gqlize_rls_<hash>"()), FALSE))
```

The function returns the key values the hop matches; everything caller-specific still comes from
the request's settings, which a definer function reads like the policy would. It is owned by the
adapter's `rls.bypassRole` (or the syncing role) and `sync()` refuses an owner without `BYPASSRLS`
or superuser, since under `FORCE` it would otherwise see nothing. `EXECUTE` goes only to the roles of
the policies calling it; `pg_temp` is last on its `search_path` so a caller's temporary table can't
stand in for a table it reads. It is uncorrelated, so Postgres evaluates it once per statement. Top
level columns are qualified with the table name: unqualified, `"id"` inside a subquery binds to the
nearest table with an `id`.

---

## 8. Testing

- **Phase 1.** Relationship filter compilation on the sequelize adapter, on both SQLite and
  Postgres. Belongs in both `POSTGRES_SUITES` and `ROUNDTRIP_SUITES`. Valkey and cross-adapter
  quantifiers assert `ScopeConfigurationError`. The create-with-nested-membership case asserts the
  re-check runs after nested writes.
- **Phase 2.** Global filters at every chokepoint listed in §5.2, plus `withoutFilters` and its cache
  key. The soft-delete argument on single-valued fields and `node` updates the schema golden files
  and `examples/gqlize-basic/generated/`.
- **Phase 3.** Postgres project only.
  - **PGlite runs as a superuser, and superusers bypass RLS.** The test connection is `postgres`
    with `rolsuper = true`, and it owns every table it creates, so without a role switch every RLS
    test would pass with nothing enforced. Every RLS test creates a `NOLOGIN` role, grants it table
    privileges, and runs requests under `SET LOCAL ROLE`. That is the same mechanism production uses
    (§6.5), so the tests exercise the real path rather than a test-only one. A helper in
    `packages/test-fixtures/src/dialect.ts` owns the role setup, so no test can forget it. A guard
    test asserts that an RLS read made *without* the role switch returns every row, proving the
    switch is what's being tested.
  - **What PGlite supports.** Probed on the installed versions (`@electric-sql/pglite` 0.5.4, which
    is Postgres 18.3, and `@electric-sql/pglite-socket` 0.2.7), both directly and through Sequelize
    over the socket server with `pool: { max: 1 }`, as the suites connect:

    | Feature | Result |
    | --- | --- |
    | `CREATE ROLE … NOLOGIN` / `LOGIN`, `GRANT`, `GRANT role TO current_user` | Works. |
    | `ENABLE` / `FORCE ROW LEVEL SECURITY`, `CREATE` / `ALTER` / `DROP POLICY` | Works. |
    | `ALTER POLICY … FOR …` | Syntax error, as on any Postgres. Confirms §6.4's drop+create path. |
    | `COMMENT ON POLICY`, reading it back from `pg_policy` with `obj_description` | Works. |
    | `pg_advisory_xact_lock` | Works. |
    | `set_config(…, true)` + `SET LOCAL ROLE` in a transaction | Filters as expected. Both revert at commit (`current_user` back to `postgres`). |
    | Two interleaved transactions with different principals on a pool of one | Each saw only its own rows. No leak between them. |
    | Setting unset in a later transaction | Reads `''`, not `NULL`. `''::uuid` raises. Hence `nullif` in §6.2. |
    | `WITH CHECK` violation | `42501` "new row violates row-level security policy". Maps to `ScopeEscapeError` (§6.5). |
    | `UPDATE` on a row `USING` hides | Zero rows, no error. Maps to a scope miss (§6.5). |
    | Soft delete under a `SELECT` policy that hides deleted rows | `42501`, with and without `RETURNING` (§6.8). |
    | Non-superuser table owner, RLS enabled, no `FORCE` | Owner sees every row. With `FORCE`, filtered. Confirms `force: true` as the default. |
    | `PGlite.create({ username })` | Fails unless the role already exists in the data directory. Not needed: `SET LOCAL ROLE` covers it. |

    One limitation to know: PGlite's `query()` rejects several statements in one call ("cannot insert
    multiple commands into a prepared statement"). `syncRowSecurity` sends one statement per call
    (or uses `exec` / a `DO` block) for this reason, and so does any test helper that sets up roles.
  - `syncRowSecurity`: create, no-op on unchanged hash (assert no `ALTER` issued), alter, drop+create
    on a `for` change, stale-policy removal, refusal on an unmarked name clash, and disable.
  - `rls:sql` output is snapshotted and applied to a fresh PGlite to prove it matches `sync()`.
  - **Parity**, the test that stands in for the layering `"database"` gives up (§6.6). The same
    suite of assertions, one per rule in §7 and per operation, runs on the `sqlite` project, where
    the engine enforces, and on the `postgres` project, where only the policy does. The rows must be
    identical. A guard asserts that on Postgres the generated SQL for an RLS model contains no scope
    clause, so the test can't pass because the engine quietly kept filtering.
  - `enforce: "both"` runs the same suite and must give the same rows.
  - Database enforcement drops each mechanism in the §6.6 table. One test per row asserts it, for
    example that a raw-SQL class method on an RLS model builds without a `:scope…` parameter and
    returns only the caller's rows.
  - Insert under a quantifier rule: creating a user together with their membership in one mutation
    succeeds for a manager of that group and fails for a manager of another (§4.5).
  - Settings and role don't leak across pooled connections: two interleaved requests with different
    principals on a pool of one.

## 9. Prior art: Drizzle

[Drizzle's RLS support](https://orm.drizzle.team/docs/rls) shaped phase 3:

- **Borrowed:** policies declared on the table with `as` / `for` / `to` / `using` / `withCheck`;
  roles not managed unless opted in; a CRUD shorthand (`crudPolicy`), which here is
  `compileRlsPolicies`; the request wrapper of transaction + `set_config(…, true)` + `SET LOCAL ROLE`
  with a reset in `finally`; and the rule that settings come from verified auth, not request data.
- **Different:**
  - Drizzle relies on drizzle-kit migrations. gqlize has `sync()`, so `sync()` reconciles policies
    in place (§6.4), with `rls:sql` for teams that run their own migrations.
  - Drizzle's ORM doesn't know policies exist, and its request wrapper is user code. Here the
    adapter applies it, and the engine uses its knowledge of which models have RLS: it stops
    injecting the scope for them (§6.6), wraps reads only where needed, makes the cache key depend
    on the settings, and checks configuration at build.
  - Drizzle policies are raw SQL only. Here they can also be compiled from the filter vocabulary
    the scope uses, so a rule means the same thing whether the engine or the database enforces it.
  - Drizzle exposes no `FORCE`. Here it is the default.
  - Drizzle's `withRLS` with no policies is silently deny-all. Here it is a build warning.

## 10. Open questions

1. **Relationship quantifiers in the GraphQL `where` input.** Useful, but filtering on a
   relationship tells the client whether a related row exists. Needs its own build-time permission
   key (`BUILD_TIME_PERMISSION_KEYS`) and its own phase.
2. **Client-facing bypass of global filters.** Should a filter be liftable through an argument, gated
   by a build-time key the way `deleted` is gated by `queryDeleted`? Phase 2 ships server-side
   bypass only.
3. **Policy hashing across versions.** The hash covers generated text, so a gqlize upgrade that
   changes formatting re-alters every policy once. Acceptable, or should the hash cover a normalised
   form?
4. **`set` under RLS.** The engine still forces `ownerId` on a create through the orm (§6.6); a
   policy can only reject a wrong one (`WITH CHECK`). Should `compileRlsPolicies` also emit column defaults
   (`DEFAULT current_setting('app.user_id')`) so a raw insert gets the right value? That makes
   `sync()` alter columns as well as policies.
5. **Default `enforce` mode.** This RFC defaults to `"database"`, as requested, giving up the
   layered defence of issue #40 decision 8 for RLS models. Should a deployment be required to opt
   in explicitly (no default), so the trade-off is a written decision in every config?
6. **Valkey and global filters.** Phase 2's `where` is portable, but Valkey already refuses some
   operators. Should a global filter Valkey can't express fail at build (strict) or at first query?
