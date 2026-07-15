# @azerothian/ormize-zod4

Generate [Zod v4](https://zod.dev) validation schemas from an
[`@azerothian/ormize`](../ormize) instance. No GraphQL dependency — a standalone,
adapter-agnostic projection of your ormize model definitions.

For each model it produces three schemas:

- **`entity`** — a full fetched row (all exposed columns, plus optional nested relations via `z.lazy`).
- **`create`** — create input (required unless the column is nullable / has a default / is auto / PK).
- **`update`** — update input (all fields optional).

It honors the **same permission rules as gqlize** (from
[`createRoleBasedPermissions`](../utilize)): a denied model/field/relationship/mutation is absent from
the generated schema.

## Install

```bash
pnpm add @azerothian/ormize-zod4 zod @azerothian/ormize
```

## Usage

```ts
import { Ormize } from "@azerothian/ormize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import { generateZodSchemas } from "@azerothian/ormize-zod4";

const orm = new Ormize()
  .registerAdapter(new SequelizeAdapter({}, { dialect: "sqlite" }))
  .define(TaskDef);

await orm.initialise();   // required — field metadata comes from the live models

const { entity, create, update } = generateZodSchemas(orm);

entity.Task.parse(row);          // validate a fetched row
create.Task.parse(newTaskInput); // validate a create payload
update.Task.parse(patch);        // validate a partial update
```

### Permissions

```ts
import { createRoleBasedPermissions } from "@azerothian/ormize";

const permission = createRoleBasedPermissions("user", {
  user: { model: "allow", field: { Task: { secret: "deny" } } },
});
const { entity } = generateZodSchemas(orm, { permission });
// entity.Task has no `secret` field
```

## Type determination

Field types are resolved through ormize's abstract `DataType` system
(`orm.mapDataType(nativeType)` → `DataType.String` / `Int` / `Enum` / …), so this package never
imports `sequelize`. Adding a new adapter that implements `mapDataType` makes it work here for free.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `permission` | — | Permission object gating models/fields/relationships/mutations. |
| `includeRelations` | `true` | Include nested relations (via `z.lazy`) in the `entity` schema. |
| `translateValidators` | `true` | Translate Sequelize `validate` rules (`len`, `isEmail`, `isAlphanumeric`, `min`/`max`, …) into Zod refinements. |

## License

MIT
