# @azerothian/utilize

Shared, GraphQL-free utilities used across [gqlize](../gqlize) and [ormize](../ormize):

- **`createRoleBasedPermissions(role, rules, options?)`** — build a role-scoped permission object
  (the same one gqlize and ormize-zod4 consume).
- **Permission-gating helpers** — `isModelAllowed`, `isFieldAllowed`, `isRelationshipAllowed`,
  `isMutationAllowed`, `isInputFieldAllowed`, and the `isAllowed` primitive. Each treats
  an absent permission object / absent predicate as **allow**; `isFieldAllowed` always allows `id`.
  They are synchronous and return a boolean — `await`ing one is a harmless no-op, which is why the
  call sites that predate the extraction still do.
- **Exposed-method declaration readers** — `whereOperatorsFor`, `computedOrderableFields`,
  `expandOrderBy`, `methodProjection`, `methodOptionHooks`, on the
  [`/exposed-methods` subpath](#exposed-methods-subpath).

These centralize the permission logic that gates which models/fields/relationships/mutations appear
in a generated schema (GraphQL in gqlize, Zod in ormize-zod4). The gating is **structural /
build-time** — predicates receive `(modelName, fieldName, options)`, never a data row.

## Install

```bash
pnpm add @azerothian/utilize
```

## Usage

```ts
import { createRoleBasedPermissions, isFieldAllowed } from "@azerothian/utilize";

const permission = createRoleBasedPermissions("user", {
  user: { model: "allow", field: { User: { password: "deny" } } },
});

isFieldAllowed(permission, "User", "password"); // false
isFieldAllowed(permission, "User", "id");       // true (id always allowed)
```

## Exposed-methods subpath

The readers behind an `ExposedMethod`'s declarative keys (`fields`, `include`, `input`, `output`,
`orderBy`, `where`) live on their own published subpath and are **not** on the barrel:

```ts
import {
  whereOperatorsFor,        // definition's own whereOperators + the ones `where` declarations imply
  computedOrderableFields,  // the method names contributing orderBy enum members, permission-filtered
  expandOrderBy,            // turn a computed enum value back into real column ordering
  methodProjection,         // the columns/includes the selected methods need loaded
  methodOptionHooks,        // the `input` hooks to run against the built query options
} from "@azerothian/utilize/exposed-methods";
```

`import { … } from "@azerothian/utilize"` will not find them — the package publishes one export
entry per source file, and the barrel deliberately re-exports only the permission surface. An
adapter implementing the optional `computedOrderableFields` member of the adapter contract needs
this subpath.

See [Exposed methods](../../docs/specifications.md#exposed-methods) for what each key means and
which reader consumes it.

## License

MIT
