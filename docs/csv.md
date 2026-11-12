# CSV uploads

How to create, update and delete rows from CSV files, over GraphQL (gqlize) or REST (nestize). This
page is task-oriented: it walks from turning the feature on to importing several linked files. For
every argument, type, header rule and error code in one place, see the
[CSV API reference](csv-api.md).

- [What it does](#what-it-does)
- [Turning it on](#turning-it-on)
- [Your first upload](#your-first-upload)
- [Writing the file](#writing-the-file)
- [Creating rows](#creating-rows)
- [Updating rows](#updating-rows)
- [Deleting rows](#deleting-rows)
- [Foreign keys and relationships](#foreign-keys-and-relationships)
- [Filtering with operators](#filtering-with-operators)
- [Importing several files at once](#importing-several-files-at-once)
- [When something is wrong](#when-something-is-wrong)
- [Permissions and safety](#permissions-and-safety)
- [Server setup](#server-setup)
- [Using it from code](#using-it-from-code)
- [Limits and things it does not do](#limits-and-things-it-does-not-do)

## What it does

A CSV upload is a list of writes in a file: one data row is one `create`, `update` or `delete`.
It is a transport, not a separate write path. Every row goes through the same
`processCreate` / `processUpdate` / `processDelete` a JSON mutation does, so validation,
permissions, row scope, hooks, `apply` transforms and read-cache invalidation all apply unchanged.

Every upload is **all or nothing**. The file is read and every row is converted and checked before
anything is written. The writes then run in a single transaction. If row 412 of 500 is bad, nothing
from rows 1–411 is left behind, and the error tells you the row and the column.

There are two shapes:

| | One file | Several linked files |
| --- | --- | --- |
| GraphQL | `models { Post(createCsv: $file) { … } }` | `csvImport(files: [...])` |
| REST | `POST /post/_csv/create` (body: `text/csv`) | `POST /_csv` (body: `multipart/form-data`) |
| Operations | create, update, delete | create, update |

## Turning it on

CSV is off until the `Ormize` instance turns it on. A model can't opt itself in, because the host
has to be accepting uploads for the arguments to mean anything.

```ts
import { Ormize } from "@azerothian/ormize";

// Every model, with the default limits: 1000 rows and 5 MB per file, 10 files per import.
const orm = new Ormize({ csv: true });

// Or with your own limits.
const orm = new Ormize({ csv: { maxRows: 10_000, maxBytes: 50 * 1024 * 1024, maxFiles: 5 } });
```

A definition can then opt out, or change the per-file limits for its own model:

```ts
const Audit = { name: "Audit", csv: false, define: { /* … */ } };            // never takes CSV
const Bulk  = { name: "Bulk",  csv: { maxRows: 50_000 }, define: { /* … */ } }; // a bigger limit
```

Once it is on, the GraphQL schema grows the CSV arguments and `csvImport`, and nestize adds the
`_csv` routes. A schema whose shape matters to you, such as a committed artifact or a golden file,
changes with it, so regenerate it.

To keep CSV away from some callers while they keep the JSON mutations, use the `mutationCsv`
permission. It is checked when the schema is built, like `mutationCreate`:

```ts
createSchema(orm, {
  permission: {
    mutationCsv: (defName) => defName !== "Invoice",
  },
});
```

## Your first upload

Take a `Post` model with `title` (required), `rank` (integer) and `published` (boolean):

```csv
title,rank,published
Hello world,1,true
"Second, with a comma",2,false
Third,,no
```

### Over GraphQL

The upload is sent as a [GraphQL multipart request](https://github.com/jaydenseric/graphql-multipart-request-spec),
the format every upload-capable GraphQL client already speaks:

```sh
curl http://localhost:4000/graphql \
  -H 'graphql-require-preflight: 1' \
  -F operations='{"query":"mutation($f: GQLTUpload!){ models { Post(createCsv: $f) { id title } } }","variables":{"f":null}}' \
  -F map='{"0":["variables.f"]}' \
  -F 0=@posts.csv
```

From a browser or Node 18+, with no client library:

```ts
const body = new FormData();
body.append("operations", JSON.stringify({
  query: "mutation($f: GQLTUpload!) { models { Post(createCsv: $f) { id title } } }",
  variables: { f: null },
}));
body.append("map", JSON.stringify({ 0: ["variables.f"] }));
body.append("0", new File([csvText], "posts.csv", { type: "text/csv" }));

const res = await fetch("/graphql", { method: "POST", body, headers: { "graphql-require-preflight": "1" } });
```

The mutation returns the rows it wrote, selected like any other mutation result.

The CSV text can also go straight in as the variable, with no multipart at all, because the upload
argument accepts plain text as well as a file:

```ts
await graphql({
  schema,
  source: "mutation($f: GQLTUpload!) { models { Post(createCsv: $f) { id } } }",
  variableValues: { f: csvText },
});
```

That is handy in tests, scripts and server-to-server calls. Keep the byte limit in mind, because
the text arrives in the request body.

### Over REST

```sh
curl -X POST http://localhost:3000/post/_csv/create \
  -H 'content-type: text/csv' --data-binary @posts.csv
```

The answer is `200 { "rows": [ … ] }` with the written rows, in file order.

## Writing the file

**Header.** The first row names the columns. Names are the field names the JSON input uses, and
surrounding spaces are trimmed. A blank or repeated header name is refused.

**Quoting.** Standard RFC 4180. A cell holding a comma, a quote or a line break goes in double
quotes, and a quote inside is doubled: `"She said ""hi"", then left"`. A leading byte-order mark
and Windows (CRLF) line ends are fine. Blank lines are skipped. A row with more or fewer cells than
the header is a parse error.

**Delimiter.** Comma by default. For semicolon- or tab-separated files, pass `csv: { delimiter: ";" }`
in GraphQL, or `?delimiter=;` over REST (URL-encode a tab as `%09`). It must be a single character,
and not a quote or a line break.

**Empty cells and nulls.** These are different things:

| Cell | Means |
| --- | --- |
| empty | The column is left out of this row. On an update, the column is left as it is. |
| `\N` | Write `null`. (`\N` is what `COPY` and `mysqldump` already write.) |

Leaving empty cells out is what makes sparse files safe. An update sheet that only fills in a few
cells changes only those cells, and doesn't null out every column it leaves blank.

**Cell values.** A cell is converted by the type of the field it fills:

| Field type | Write it as |
| --- | --- |
| Integer, float | `42`, `-1.5` (surrounding spaces are fine; empty is not zero) |
| Boolean | `true`/`false`, `1`/`0`, `yes`/`no`, in any case |
| ID, string, enum, date, big integer, decimal | the text as is (`2024-01-02T03:04:05Z` for a date) |
| JSON, an array column, or a whole nested input | JSON: `"{""a"":1}"` (quoted, inner quotes doubled) |
| A list of values (an `in` filter, say) | `a\|b\|c`, or a JSON array `["a","b\|c"]` when an item contains `\|` |

A value that doesn't convert, such as `one` in an integer column, fails the upload with the row and
the column.

## Creating rows

Every column fills the field it names. A required field must be present (as a column, with a cell
on every row), as it would in a JSON `create`:

```csv
title,rank
First,1
Second,2
```

**Primary keys and foreign keys.** These are not writable by default, for the same mass-assignment
reasons as in JSON. An `id` column on a create is refused (`CSV_HEADER`) rather than silently
dropped. See [Foreign keys and relationships](#foreign-keys-and-relationships) for linking rows.

## Updating rows

Each row finds the record it updates through its **key columns**; every other column is a value to
write.

By default the key is the primary key:

```csv
id,published
UG9zdDox,true
UG9zdDoy,false
```

(Over GraphQL, ids are the same global ids the API returns. Over REST, they are the raw keys.)

To match on other columns, name them:

```graphql
mutation ($f: GQLTUpload!) { models { Post(updateCsv: $f, csv: { keys: ["slug"] }) { id } } }
```

```sh
curl -X POST 'http://localhost:3000/post/_csv/update?keys=slug' -H 'content-type: text/csv' --data-binary @posts.csv
```

```csv
slug,published
hello-world,true
```

To match with an operator rather than equality, prefix the key column with `where.`. A `where.`
column is a key column wherever it sits, and its presence replaces the primary-key default:

```csv
where.title[startsWith],published
Draft: ,false
```

Rules worth knowing:

- Every key cell must be filled. A blank key would match nothing, or, dropped, everything, so it is
  refused.
- A row whose keys match nothing fails the upload (`CSV_ROW_NO_MATCH`). A row outside your row scope
  is reported the same way, so the error doesn't reveal whether the row exists.
- A key that matches several rows updates all of them, as a JSON `update` would.
- An update needs at least one column besides its keys, unless it runs an `apply` transform (see
  below). Then the key columns alone pick the rows the transform runs on.

### Transforms (`apply`)

A model's [instance-method transforms](guide.md#instance-method-transforms-apply) run on every row
of a create or update upload, as they do on a JSON write:

- **GraphQL.** The field's own `apply` argument: `Post(updateCsv: $f, csv: { keys: ["slug"] }, apply: { markChecked: true })`.
  In a `csvImport`, each file takes an `apply` of its own, checked against that model field's
  `apply` argument.
- **REST.** `?apply=` on `POST /:resource/_csv/:operation`, or a `<part>.apply` text part on
  `POST /_csv`. Either holds a JSON object: `{"appendSuffix": {"suffix": "!"}, "markChecked": true}`.

Only the transforms `permission.mutationInstanceMethods` leaves in can run. Over REST, naming one it
denies is a `403`, and naming anything that isn't an exposed transform, or giving one params its
declared `args` don't take, is a `400`.

## Deleting rows

A delete takes **only** key columns; any other column is refused, so a file meant for an update
can't be sent to delete by mistake and quietly ignore its data.

```csv
id
UG9zdDox
UG9zdDoy
```

`csv.keys`, `?keys=` and `where.` columns work as they do for updates.

## Foreign keys and relationships

There are three ways to connect a row to other rows.

### 1. A foreign-key column

If a foreign key is writable (`writable: true` on the field, or `new Ormize({ writableForeignKeys: true })`
for all of them), it is a plain column:

```csv
title,authorId
Hello,QXV0aG9yOjE=
```

Over GraphQL the value is the related row's global id, and an id of the wrong type is refused. Over
REST it is the raw key.

### 2. Relationship verbs in the header

Every [nested relationship write](guide.md#nested-relationship-writes) a JSON mutation can make,
a header can make too. The header is a dotted path into the same input:

```csv
title,author.set.name,tags.add.name[in],comments.create.body
Hello,Ann,red|blue,First!
```

That row creates a post, links it to the author named Ann, adds the tags `red` and `blue`, and
creates a comment on it. It is the same as this JSON:

```graphql
Post(create: [{
  title: "Hello",
  author:   { set: { name: { eq: "Ann" } } },
  tags:     { add: [{ name: { in: ["red", "blue"] } }] },
  comments: { create: [{ body: "First!" }] },
}])
```

The path is `<relationship>.<verb>.<field>`. The verbs are those of the relationship input:

| Verb | to-one (`belongsTo`, `hasOne`) | to-many (`hasMany`, `belongsToMany`) | In the header |
| --- | --- | --- | --- |
| `create` | ✓ | ✓ | `author.create.name`: fields of the new row |
| `set` | ✓ | ✓ (replaces the whole set) | `author.set.name`: filter for the row(s) to link |
| `add` | | ✓ | `tags.add.name`: filter for the rows to link |
| `remove` | ✓ (`true`) | ✓ (filter) | `author.remove` = `true`, or `tags.remove.name` |
| `update` | ✓ | ✓ | `comments.update.where.body` picks rows; `comments.update.body` writes |
| `delete` | ✓ | ✓ | `comments.delete.body`: filter for the rows to delete |
| `restore` | ✓ | ✓ | `comments.restore.body`: filter for soft-deleted rows |
| `select` | ✓ | ✓ | `comments.select.where.body` picks; nested verbs run on them |

Some things that make headers easier to write:

- **Filters default to `eq`.** `author.set.name` means `name: { eq: … }`. Add an operator in
  brackets for anything else: `tags.add.name[startsWith]`.
- **`where` is optional where it carries no choice.** `author.set.where.name` and `author.set.name`
  are the same header. On an `update` or `select`, `where.` picks the rows and a bare field is a
  value to write, so you never spell out `input`. On a many-to-many `add`/`set` entry, a bare field
  is its filter. When the relationship is in through mode (its join model is a registered
  definition the permissions let the caller see), `tags.add.through.<column>` writes a join-row
  column, one cell per column, taking only the columns the `<Model><Rel>ThroughInput` type offers
  (never the join keys). A plain many-to-many has no `through`, so such a header is a
  `CSV_HEADER` error.
- **Columns under one verb build one entry.** `tags.add.name[startsWith]` and `tags.add.name[ne]`
  together make one filter, `{ name: { startsWith, ne } }`, not two adds.
- **`[n]` starts another entry.** `comments.create.body` and `comments.create[1].body` create two
  comments. An entry whose cells are all empty on a row is left out of that row, so files can be
  sparse.
- **`?` may stand in for `.`**, so `author.set.where?name` is the same header too.
- **A whole relationship can be one JSON cell.** A column named just `author` takes the JSON value
  of the whole input, which is handy for something irregular:
  `"{""create"":{""name"":""New""}}"`.

Relationship headers are a GraphQL feature. REST bodies are validated by zod schemas that hold
columns only, so nestize refuses them with `CSV_HEADER`. Over REST, link rows through
[foreign-key columns](#1-a-foreign-key-column), or [labels in an import](#importing-several-files-at-once).

### 3. Labels across files

When the rows you want to link are being created by the same import, they have no id yet and
possibly no unique field to filter by. Labels solve that; see the next sections.

## Filtering with operators

Wherever a header lands on a filter, through `where.` on updates and deletes or through a
relationship verb, any operator the field's filter type offers can follow in brackets. `[in]` and
`[Op.in]` are the same.

```csv
where.rank[gte],where.title[notLike],published
10,%draft%,true
```

| Operator kind | Examples | Cell |
| --- | --- | --- |
| One value | `eq` (default), `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `iLike`, `startsWith`, `endsWith`, `substring`, `not`, `is` | one value |
| A list | `in`, `notIn`, `between`, `notBetween` (and Postgres' `contains`, `overlap`, …) | `a\|b` or a JSON array |
| Combinators | `or`, `and` | index each branch: `where.or[0].title`, `where.or[1].title[like]` |

Which operators exist depends on the adapter and the field, exactly as for a JSON filter. Pattern
operators (`regexp` and friends) are only there if your adapter enables them. An operator the field
doesn't offer is refused with `CSV_HEADER`.

Over REST, a `where.` column takes one field and an operator from a fixed allow-list: the
single-value ones above (no regex), and the list ones. ORM internals such as `col` are refused, so
a filter can't compare against another column.

## Importing several files at once

When the data spans several models, such as authors, their posts, and tags on the posts, send it as
one import. All the files are applied as one unit, and rows in one file can point at rows another
file writes.

### Labels and references

Give a file an `@ref` column to label its rows. Point at them from any file with a column whose
header ends in `.@ref`:

```csv
authors.csv
@ref,name
ann,Ann
bob,Bob
```

```csv
tags.csv
@ref,name
red,red
blue,blue
```

```csv
posts.csv
@ref,title,author.@ref,tags.@ref
hello,Hello,ann,red|blue
bye,Bye,bob,
```

```csv
comments.csv
body,post.@ref
First!,hello
```

What a reference does depends on where it points:

| Header | Does |
| --- | --- |
| `author.@ref` | Links one row on a to-one relationship (its `set`) |
| `tags.@ref` | Adds rows on a to-many relationship (its `add`). It never unlinks existing ones |
| `tags.set.@ref` | Replaces the to-many set with exactly these rows |
| `tags.add[1].@ref`, `comments.update.@ref` | That verb or entry, picking rows by primary key |
| `authorId.@ref` | Writes the row's id into a writable foreign-key column |

A reference cell holds one label, or several as `a|b` (or a JSON array). A field that takes a single
id, such as a foreign key, refuses several.

Labels are unique across the whole import, so a reference never needs to say which file it means.
They don't have to look like anything in particular. Row numbers, natural keys and UUIDs all work.

### Sending an import

GraphQL:

```graphql
mutation ($files: [CsvImportFile!]!) {
  csvImport(files: $files) {
    files { name model operation count ids }
    refs
  }
}
```

```json
{ "files": [
  { "model": "Post",    "operation": "create", "file": null },
  { "model": "Author",  "operation": "create", "file": null },
  { "model": "Tag",     "operation": "create", "file": null },
  { "model": "Comment", "operation": "create", "file": null, "name": "comments" }
] }
```

with the multipart `map` pointing `variables.files.0.file`, `variables.files.1.file` and so on at the
file parts.

```sh
curl http://localhost:4000/graphql -H 'graphql-require-preflight: 1' \
  -F operations='{"query":"mutation($files:[CsvImportFile!]!){ csvImport(files:$files){ files { name count } refs } }","variables":{"files":[{"model":"Author","operation":"create","file":null},{"model":"Post","operation":"create","file":null}]}}' \
  -F map='{"0":["variables.files.0.file"],"1":["variables.files.1.file"]}' \
  -F 0=@authors.csv -F 1=@posts.csv
```

The answer lists each file, in the order you sent them, with the ids it wrote in file order.
`refs` maps every label to the id of its row:

```json
{ "csvImport": {
  "files": [
    { "name": "Author.create", "model": "Author", "operation": "create", "count": 2, "ids": ["QXV0aG9yOjE=", "QXV0aG9yOjI="] },
    { "name": "Post.create",   "model": "Post",   "operation": "create", "count": 2, "ids": ["UG9zdDox", "UG9zdDoy"] }
  ],
  "refs": { "ann": "QXV0aG9yOjE=", "bob": "QXV0aG9yOjI=", "hello": "UG9zdDox", "bye": "UG9zdDoy" }
} }
```

REST, as one `multipart/form-data` body with one file part per CSV. A part's name says what it is:
`<resource>.create` or `<resource>.update`. A bare `<resource>` means create.

```sh
curl -X POST http://localhost:3000/_csv \
  -F item.create=@items.csv \
  -F task.create=@tasks.csv
```

```csv
items.csv           tasks.csv
@ref,label          name,itemId.@ref
box,Box             pack,box
```

Over REST, references fill writable foreign-key columns (`itemId.@ref`) and the answer's `refs`
holds raw keys: `200 { files: [{ name, resource, operation, rows }], refs: { box: 7 } }`.

### Order

You don't have to list the files in any particular order. The import writes each file after the
files it references. Where references leave the order free, files run in the order given. Two files
that refer to each other in a loop, like authors pointing at posts while posts point at authors,
can't be ordered and are refused; break the loop by setting one side of the relationship only.

Within a file, rows are written top to bottom. A row may point at an earlier row of the same file,
which is how a tree goes in a single file:

```csv
categories.csv
@ref,name,parent.@ref
root,All,
books,Books,root
sf,Science fiction,books
```

A reference to a later row of the same file is refused.

### Updates in an import

A file can be an update. Its rows can carry labels too, naming the row each one matched, so later
files can point at existing records you located by a natural key:

```csv
existing-authors.csv (operation: update, keys: ["email"])
@ref,email,name
ann,ann@example.com,Ann Smith
```

A labelled update row must match exactly one row, because a label names one row.

Per-file options:

| | GraphQL (`CsvImportFile`) | REST (text parts) |
| --- | --- | --- |
| Match columns | `keys: ["email"]` | `author.update.keys=email` |
| Delimiter | `delimiter: ";"` | `author.update.delimiter=;` |
| Name in errors and results | `name: "authors"` (default `Author.create`, then `Author.create#2`) | the part name |

## When something is wrong

Nothing is written unless everything is. The error names what to fix:

```json
{
  "message": "Post.create: Row 2: \"rank\": \"one\" is not an integer",
  "extensions": { "code": "CSV_ROW_INVALID", "file": "Post.create", "row": 2, "column": "rank" }
}
```

Over REST the same fields come back as the JSON body:
`400 { "statusCode": 400, "code": "CSV_ROW_INVALID", "message": "…", "row": 2, "column": "rank" }`.

`row` counts data rows from 1, not counting the header, so it is the spreadsheet row number minus
one. `file` is only present in an import.

The common ones, and what usually causes them:

| Code | Typical cause | Fix |
| --- | --- | --- |
| `CSV_HEADER` | A misspelled column; a primary key on a create; a column you may not write; an unknown verb or operator; two headers writing the same place | Check the column against the JSON input type, which is exactly what a header may name |
| `CSV_ROW_INVALID` | `one` in an integer column; a required field missing; a blank key cell; an unknown label | Fix the cell on that row |
| `CSV_ROW_NO_MATCH` | An update or delete key that matches nothing (or nothing you can see) | Check the key, or your scope |
| `CSV_ROW_FAILED` | The database refused the write: a unique constraint, a foreign key. `causeCode` holds the inner code when there is one | Fix the data; the message carries the database's reason |
| `CSV_PARSE` | An unclosed quote; a row with the wrong number of cells; a bad delimiter | Re-export the file, or check the delimiter |
| `CSV_TOO_LARGE`, `CSV_TOO_MANY_ROWS`, `CSV_TOO_MANY_FILES` | Over a limit (REST: `413`) | Split the upload, or raise the limit |
| `CSV_UNSUPPORTED` | Not a file; CSV off for that model; an import file whose model doesn't take that operation | Check the model and the operation |

Everything is checked in this order, and the first problem stops the upload:

1. the file (size, parsing, header);
2. the columns;
3. every row's conversion;
4. the writes.

That means a header mistake is reported before a cell mistake, and no cell mistake can leave a
partial write.

## Permissions and safety

CSV adds no way in that JSON doesn't already have:

- **The same gates.** `createCsv` exists only where `create` does, and likewise update and delete.
  A model's `mutationCsv` permission can take CSV away on top. An import file is accepted only
  where the model's own field offers that CSV operation. Over REST, each file part is checked as it
  arrives and refused before it is buffered.
- **The same input types.** A header can only name what the JSON input offers. Fields hidden by
  `mutationCreateInput` / `mutationUpdateInput`, primary keys, non-writable foreign keys and
  relationships you may not write are not there to name. They fail the upload with `CSV_HEADER`
  rather than being ignored, so you find out.
- **The same related-model gates.** A nested `delete` or `restore` is only offered when the related
  model's own `mutationDelete` / `mutationRestore` allows it. `add` / `set` / `remove` on a
  `hasMany` / `hasOne` rewrite the related row's foreign key, so they need its `mutationUpdate`.
  Nested `create` / `update` need the related model's create / update input.
- **The same filters.** Matching on a field is reading it. A field hidden from filtering can't be a
  key column or appear in a relationship filter.
- **The same row scope.** Every row, and every related row a verb reaches, is held to
  `permission.scope`. A related row outside your scope is never linked, updated or deleted, and an
  update key outside it is reported as no match.

## Server setup

### GraphQL

The CSV arguments are `GQLTUpload` scalars. Whatever your server's multipart layer puts in the
variable is accepted: a web `File`/`Blob`, graphql-upload's `Upload` / `FileUpload`, a Node stream,
any (async) iterable of strings or bytes, or plain text.

- **graphql-yoga** parses multipart requests itself, so there is nothing to configure. Keep
  `graphql-require-preflight` (or yoga's CSRF prevention) in mind for browser clients.
- **Servers without built-in uploads** (Express with `graphql-http`, Apollo Server and others):
  put an upload middleware such as [graphql-upload](https://github.com/jaydenseric/graphql-upload)'s
  `graphqlUploadExpress()` in front of the GraphQL handler.

### NestJS (nestize)

- **`POST /:resource/_csv/:operation`** takes a `text/csv` body. Nest's default JSON and urlencoded
  parsers leave that type unread, so the route reads the request stream itself; nothing to configure
  on Express. A body another parser already read (`express.text({ type: "text/csv" })`) or a multer
  `FileInterceptor` file also works.
- **`POST /_csv`** takes `multipart/form-data`. nestize reads it with busboy, or uses the files
  a multer interceptor (`AnyFilesInterceptor`, memory storage) already put on `req.files`.
- **Fastify** rejects a content type it has no parser for, so add pass-through parsers that leave
  the stream unread for the route:

  ```ts
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addContentTypeParser("text/csv", (_req, _payload, done) => done(null));
  fastify.addContentTypeParser("multipart/form-data", (_req, _payload, done) => done(null));
  ```

Both routes are listed in the generated OpenAPI document when CSV is on.

## Using it from code

Outside a request (a seed script, a queue worker) the simplest route is the GraphQL schema itself,
with the CSV text as the variable. That way every gate and conversion is exactly the one clients
get:

```ts
const result = await graphql({
  schema,
  source: "mutation($f: GQLTUpload!) { models { Post(createCsv: $f) { id } } }",
  variableValues: { f: await fs.readFile("posts.csv", "utf8") },
  contextValue: { /* whatever your permissions read */ },
});
```

To skip GraphQL entirely, ormize exposes the engine as `orm.processCsv` and `orm.processCsvImport`.
You supply the conversion (`toArgs`) that a surface normally provides; see the
[API reference](csv-api.md#ormize-api) for the full contract:

```ts
import { csvCellValue } from "@azerothian/ormize";

const rows = await orm.processCsv("Post", "create", {
  upload: fs.createReadStream("posts.csv"),
  toArgs: ({ input }) => ({
    input: Object.fromEntries(Object.entries(input).map(([column, raw]) => [
      column,
      csvCellValue(raw, orm.mapDataType(orm.getFields("Post")[column].type, orm.defsAdapters.Post)),
    ])),
  }),
}, { /* request context */ });
```

The engine transports rows. It doesn't check operation permissions, which is the caller's job, as
it is for `orm.processCreate`.

## Limits and things it does not do

- **Memory.** A file is held in memory while it is converted, which is what lets every row be
  checked before the first write. `maxBytes` and `maxRows` bound it, and they are enforced while
  the file streams in, so an oversized upload is refused before it is buffered.
- **One transaction.** A very large upload is one long transaction. If your database dislikes that,
  keep `maxRows` modest and split big files.
- **Not in CSV:** `restore` and `select` as top-level operations (they stay JSON-only), and deletes
  in a multi-file import (send a separate `deleteCsv`).
- **References** need the referenced model to have a single-column primary key. REST references
  fill foreign-key columns only.
- **No upsert.** A row is a create or an update according to the operation you chose. To load data
  that may or may not exist, update by a natural key and create the misses separately.
