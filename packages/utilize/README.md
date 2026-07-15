# @azerothian/utilize

Shared, GraphQL-free utilities used across [gqlize](../gqlize) and [ormize](../ormize):

- **`createRoleBasedPermissions(role, rules, options?)`** — build a role-scoped permission object
  (the same one gqlize and ormize-zod4 consume).
- **Permission-gating helpers** — `isModelAllowed`, `isFieldAllowed`, `isRelationshipAllowed`,
  `isMutationAllowed`, `isInputFieldAllowed`, and the `isAllowed` primitive. Each is async and treats
  an absent permission object / absent predicate as **allow**; `isFieldAllowed` always allows `id`.

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

await isFieldAllowed(permission, "User", "password"); // false
await isFieldAllowed(permission, "User", "id");        // true (id always allowed)
```

## License

MIT
