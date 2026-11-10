# CSV API reference

Every option, schema type, route, header rule, conversion and error of CSV uploads. For a walkthrough,
start with [CSV uploads](csv.md); for how the engine is built, see
[specifications: CSV uploads](specifications.md#csv-uploads).

- [Configuration](#configuration)
- [GraphQL schema](#graphql-schema)
- [REST routes](#rest-routes)
- [File format](#file-format)
- [Header paths](#header-paths)
- [Cell conversion](#cell-conversion)
- [Errors](#errors)
- [ormize API](#ormize-api)

## Configuration

### `GqlizeOptions.csv`

Read by the `Ormize` constructor (`new Ormize({ csv })`), so every surface agrees on which models
take CSV.

```ts
csv?: boolean | CsvOptions;

type CsvOptions = {
  maxRows?: number;   // data rows per file, header not counted. Default 1000
  maxBytes?: number;  // bytes per file. Default 5 * 1024 * 1024
  maxFiles?: number;  // files per multi-file import. Default 10
};
```

| Value | Effect |
| --- | --- |
| absent / `false` | CSV off everywhere. No CSV arguments, no `csvImport`, no `_csv` routes. |
| `true` | On for every model, default limits. |
| `{ … }` | On for every model, with these limits. |

`maxRows` and `maxBytes` are counted while the file streams in. `maxBytes` counts the raw bytes
received, header included.

### `Definition.csv`

```ts
csv?: false | CsvLimits;   // CsvLimits = { maxRows?: number; maxBytes?: number }
```

| Value | Effect |
| --- | --- |
| absent | The instance's setting. |
| `false` | This model never takes CSV, whatever the instance says. |
| `{ maxRows?, maxBytes? }` | This model's per-file limits, overriding the instance's. It cannot turn CSV on when the instance has it off. |

### `Permission.mutationCsv`

```ts
mutationCsv?: (defName: string, options?: PermissionContext) => boolean;
```

A build-time gate (`BUILD_TIME_PERMISSION_KEYS`). It is applied *in addition to* the operation's own
gate (`mutationCreate` / `mutationUpdate` / `mutationDelete`). When it returns `false`:

- the model's field gets no CSV arguments;
- the model is left out of `CsvImportModel`;
- nestize answers `403` for its `_csv` routes and its import parts.

Absent means allowed.

## GraphQL schema

### Model mutation field arguments

Added to `Mutation.models.<Model>` when CSV is on for the model and `mutationCsv` allows it. Each
argument appears only where its JSON twin (`create`, `update`, `delete`) does.

```graphql
type MutationModels {
  Post(
    create: [PostRequiredInput]
    update: [PostUpdateInput]
    delete: [GQLTQueryPostWhere]
    # …
    createCsv: GQLTUpload   # one create per data row
    updateCsv: GQLTUpload   # one update per data row, matched on its key columns
    deleteCsv: GQLTUpload   # one delete per data row, key columns only
    csv: GQLTCsvOptions     # present when any of the three is
  ): [Post]
}

input GQLTCsvOptions {
  "The columns an updateCsv or deleteCsv row is matched on. Default: the primary key"
  keys: [String!]
  "The field separator. Default: a comma"
  delimiter: String
}
```

The JSON operations run first. CSV uploads then run in the order `createCsv`, `updateCsv`,
`deleteCsv`. Each upload is its own all-or-nothing unit. The field returns every row written, each
having been through the model's `after` hook with the matching event (`MUTATION_CREATE` /
`MUTATION_UPDATE` / `MUTATION_DELETE`).

The model field's `apply` argument (instance-method transforms) applies to CSV rows as it does to
JSON ones.

### `csvImport`

Added to `Mutation` when at least one model's field takes `createCsv` or `updateCsv`.

```graphql
type Mutation {
  "Create or update rows of several models from CSV files in one all-or-nothing unit."
  csvImport(files: [CsvImportFile!]!): GQLTCsvImportResult!
}

input CsvImportFile {
  model: CsvImportModel!
  operation: GQLTCsvImportOperation!
  file: GQLTUpload!
  "How errors and results name this file. Default: <model>.<operation>, numbered if repeated"
  name: String
  "The columns an update row is matched on, beside any where.… columns. Default: the primary key"
  keys: [String!]
  "The field separator. Default: a comma"
  delimiter: String
}

"Every model whose Mutation.models field takes createCsv or updateCsv"
enum CsvImportModel { Author Post Tag }   # per schema

enum GQLTCsvImportOperation { create update }

type GQLTCsvImportResult {
  "One entry per file, in the order given"
  files: [GQLTCsvImportFileResult!]!
  "Each @ref label and the id of the row it labelled"
  refs: GQLTJson!
}

type GQLTCsvImportFileResult {
  "The file's name, as given or defaulted"
  name: String!
  model: String!
  operation: GQLTCsvImportOperation!
  "Rows written"
  count: Int!
  "The written rows' ids, in file order"
  ids: [ID!]!
}
```

| Rule | |
| --- | --- |
| Which files are accepted | A file is accepted only if `Mutation.models.<model>` has the `<operation>Csv` argument. Otherwise it is `CSV_UNSUPPORTED`. Every gate on that argument therefore holds, on live schemas and materialized artifacts alike. |
| Default names | `<model>.<operation>`, then `<model>.<operation>#2`, `#3` for repeats. Explicit names must be unique. |
| Ids | `ids` and `refs` use the schema's id codec (`GqlizeOptions.id`), like every other id. |
| Hooks | Each row goes through its model's `after` hook with the event for its file's operation. |
| Artifacts | The resolver is the `csvImport` binding kind, so a schema built to a JSON artifact and materialized keeps it. |

### Error extensions

A refused upload is one `GraphQLError`:

```json
{
  "message": "Post.create: Row 2: \"rank\": \"one\" is not an integer",
  "path": ["models", "Post"],
  "extensions": { "code": "CSV_ROW_INVALID", "file": "Post.create", "row": 2, "column": "rank", "causeCode": "…" }
}
```

| Extension | Present when |
| --- | --- |
| `code` | Always: one of the [error codes](#error-codes). |
| `row` | The error is about one data row (1-based, header not counted). |
| `column` | The error is about one column; its header name as written. |
| `file` | In a `csvImport`: the file's `name`. |
| `causeCode` | `CSV_ROW_FAILED` whose underlying error had a code, e.g. `GLOBAL_ID_TYPE_MISMATCH`. |

The error carries no `originalError`. That is deliberate: hosts that mask unexpected errors
(graphql-yoga by default) would otherwise replace it with "Unexpected error.".

## REST routes

Registered by nestize. Both are absent (`404`) when the instance has CSV off. Both are `405` in
read-only mode, like every write route. Both are in the OpenAPI document when they would accept
something.

### `POST /:resource/_csv/:operation`

| | |
| --- | --- |
| `:resource` | The resource path segment (model name, lower-cased). |
| `:operation` | `create`, `update` or `delete`. Anything else is `404`. |
| Query `keys` | Comma-separated match columns, e.g. `?keys=slug,locale`. Default: the primary key. |
| Query `delimiter` | One character, e.g. `?delimiter=;` or `?delimiter=%09`. |
| Body | The CSV. Taken from, in order: a multer `req.file` (`buffer` or `stream`); a body a parser already read as text or bytes; the request stream (`text/csv` is left unread by Nest's default parsers). |
| `200` | `{ rows: Model[] }`: every row written, in file order. |
| `400` | `{ statusCode, code, message, row?, column? }`: the file, a row or a column was refused. Nothing was written. |
| `403` | The operation (`mutationCreate` …) or `mutationCsv` is denied for the model. |
| `404` | CSV off for the model, or an unknown operation. |
| `413` | `CSV_TOO_LARGE` or `CSV_TOO_MANY_ROWS`. |

Conversion uses column types and the zod schema of `POST /:resource` (create) or `PATCH /:resource`
(update). Key columns are checked against the same filter permission as `?filter=`.

### `POST /_csv`

A `multipart/form-data` body of several CSV files, applied as one unit.

| Part | |
| --- | --- |
| File part `<resource>.create`, `<resource>.update`, or `<resource>` (= create) | One CSV file. The part name is the file's `name` in errors and results. |
| Text part `<part>.keys` | Match columns for that file, comma-separated. |
| Text part `<part>.delimiter` | Delimiter for that file. |

| Status | Body |
| --- | --- |
| `200` | `{ files: [{ name, resource, operation, rows }], refs: { [label]: key } }`. `files` is in the order the parts arrived; `refs` holds raw primary-key values. |
| `400` | `{ statusCode, code, message, file?, row?, column? }`. A file, row or reference was refused, or the body is not multipart (`CSV_UNSUPPORTED`). |
| `403` | A part's operation or `mutationCsv` is denied. It is checked as the part arrives, before its bytes are buffered. |
| `404` | CSV is off on the instance. |
| `413` | `CSV_TOO_MANY_FILES`, `CSV_TOO_LARGE` or `CSV_TOO_MANY_ROWS`. |

The body is read with busboy, unless `req.files` already holds memory-storage multer files
(`AnyFilesInterceptor`, `FilesInterceptor`, `FileFieldsInterceptor`), whose text fields are then
taken from `req.body`. Under Fastify, register pass-through content-type parsers for `text/csv` and
`multipart/form-data` (see [Server setup](csv.md#server-setup)).

REST references fill writable foreign-key columns only (`<field>.@ref`). Relationship headers are
refused with `CSV_HEADER`.

## File format

| Aspect | Rule |
| --- | --- |
| Encoding | UTF-8. A leading byte-order mark is stripped. |
| Records | RFC 4180: `"…"` quotes a cell holding the delimiter, a quote or a line break; `""` is a quote. LF and CRLF line ends. |
| Blank lines | Skipped. |
| Cell count | Every row has as many cells as the header; otherwise `CSV_PARSE`. |
| Header | The first record. Names are trimmed. A blank or repeated name is `CSV_HEADER`. A file with no header is `CSV_HEADER`. |
| Delimiter | Default `,`. Exactly one character, other than `"`, CR or LF; otherwise `CSV_PARSE`. |
| Empty cell | Left out of the row entirely. On an update, the column is untouched. On a key column, refused. |
| `\N` | `null`. The constant is `CSV_NULL`. |
| Rows | Numbered from 1 after the header; that number is `row` in errors. |

### Column roles

| Header | Role |
| --- | --- |
| `@ref` | Import only. This row's label. Not written. |
| `where.<path>`, `where?<path>` | Update and delete only. A match column; its presence replaces the primary-key default. Refused on a create. |
| A column named in `keys` | Update and delete only. A match column, equality. |
| `….@ref` (header ending in `.@ref` or `?@ref`) | Import only. Points at labelled rows. Cannot be a match column. |
| Anything else | Create and update: a value (path) to write. Refused on a delete. |

An update needs at least one value column. A delete takes match columns only.

## Header paths

### Grammar

```ebnf
header    = segment , { separator , segment } ;
separator = "." | "?" ;
segment   = name , [ "[" , index , "]" ] , [ "[" , operator , "]" ] ;   (* operator: last segment only *)
name      = { any character except "." "?" "[" "]" }- ;                  (* trimmed *)
index     = digit , { digit } ;
operator  = [ "Op." ] , letter-or-_-or-$ , { letter | digit | "_" | "$" } ;
```

Separators inside brackets don't split, so `[Op.in]` is one operator. `parseCsvHeader` refuses an
empty segment (`a..b`, `a.`), an operator anywhere but at the end, two indexes on one segment, and
any other bracket content. The error is `CSV_HEADER`.

Examples: `title`, `author.set.name`, `tags.add[1].name[Op.in]`, `where.or[0].title[like]`,
`author.set.where?name`, `tags.@ref`.

### Resolution (gqlize)

A header is resolved by walking the field's own GraphQL input types. A header can therefore name
exactly what a JSON argument can, after every permission has shaped those types. Walking from the
argument's input type (`<Model>RequiredInput` for create; the update entry's `input` for update;
the where type for match columns, with the leading `where.` removed):

1. **A field of the current type** is entered. If it is a list of input objects, the segment's
   `[n]` picks the entry (default `0`).
2. **An implicit level** is entered when the segment is not a field of the current type:
   - the entry's `input` (on `update` / `select` entries), when that type has the field;
   - otherwise the entry's `where` (on belongsToMany `add` / `set` entries), when that type has it.
3. **`where` on a filter.** A `where` segment on a type that is already a filter is skipped, so
   `author.set.where.name` ≡ `author.set.name`.
4. **The last segment**:
   - with `[op]`, it must be a per-field operator object that offers `op`;
   - without one, an operator object means `eq`;
   - anything else is the value itself (a scalar, an enum, or an object or list given as JSON).
5. **Errors.** An unknown segment, an index on something that is not a list, going past a value, an
   operator the field lacks, or an operator on something that is not a filter field: `CSV_HEADER`.

**Merging.** A row's value is built by placing each cell at its path. Paths sharing a prefix share
the object, so columns under one verb and entry make one entry, and several operators on one field
make one operator object. Two headers resolving to the same place, or one inside the other, are
`CSV_HEADER`. An entry whose cells are all empty on a row is dropped, and the list is compacted. The
whole value is then validated and coerced by graphql (`validateInputValue` / `coerceInputValue`), as
a variable would be.

### References (`….@ref`, gqlize)

Only in a `csvImport`. The path before `@ref` is walked as above, tracking which model it is in
(a relationship field leads to its target). Then it resolves by what it lands on:

| Lands on | Resolves to | Cell |
| --- | --- | --- |
| An `ID` field (a writable foreign key) | That field | One label |
| A relationship input (`author`, `tags`) | Its `add` when it has one (to-many), else its `set`, then as below | One or more |
| A verb or entry (`tags.set`, `tags.add[1]`, `comments.update`) | That entry's filter (through its `where` when it has one), as `<primary key>: { in: [...] }` | One or more |

The target model must have a single primary key. A reference in a single-file upload is
`CSV_HEADER`.

### Resolution (nestize)

| Header | Accepted |
| --- | --- |
| `<field>` | When it is an own key of the operation's zod input schema (so `constructor`, `toString` and the like are refused). |
| `where.<field>[op]` | One field, and an operator from the allow-list `CSV_VALUE_OPERATORS` ∪ `CSV_LIST_OPERATORS`. Anything else is `CSV_HEADER`, because the adapter would turn any `Op` name, `col` included, into that operator. The value is converted by the field's column type; list operators take a list. |
| `<field>.@ref` | Import only; `<field>` must be in the input schema (a writable foreign key), and every label in it must name a row of the key's target model. |
| Anything else with `.`, `?` or `[` | `CSV_HEADER`: relationship headers are GraphQL-only. |

## Cell conversion

### gqlize, by GraphQL input type

| Type | Conversion |
| --- | --- |
| `Int` | Trimmed, must be a whole number (`csvNumber(raw, true)`). |
| `Float` | Trimmed, must be a finite number. Empty is refused, not zero. |
| `Boolean` | Trimmed, case-insensitive: `true`, `1`, `yes` / `false`, `0`, `no`. |
| `GQLTJson` | JSON. |
| An input object | JSON. |
| A list of input objects | JSON. |
| A list of anything else | A JSON array when the cell starts with `[`, else split on `\|`. Each item is converted by the item type. |
| Everything else (`ID`, `String`, enums, `GQLTDate`, `GQLTBigInt`, …) | The text, handed to the scalar's own parser. |

### nestize, by column type (`csvCellValue`)

| Abstract type | Conversion |
| --- | --- |
| `Int` | As above. |
| `Float` | As above. |
| `Boolean` | As above. |
| `Date`, `DateOnly` | `new Date(text)`; an invalid date is refused. |
| `JSON`, `Array` | JSON. |
| `BigInt`, `Decimal` | Kept as text, so no precision is lost. |
| Everything else | Kept as text. |

The row is then validated with the operation's zod schema.

## Errors

### `CsvUploadError`

```ts
class CsvUploadError extends Error {
  readonly code: CsvUploadErrorCode;
  readonly row?: number;      // 1-based data row
  readonly column?: string;   // header name as written
  readonly file?: string;     // import file name
  // `cause` (standard Error option): the engine error behind a CSV_ROW_FAILED
}
```

### Error codes

| Code | Raised when | REST |
| --- | --- | --- |
| `CSV_UNSUPPORTED` | The upload is not a readable file. CSV is off for the model. An import has no files, or a file's model doesn't take that operation. A REST import body is not multipart. | 400 |
| `CSV_TOO_LARGE` | More than `maxBytes` bytes. | 413 |
| `CSV_TOO_MANY_ROWS` | More than `maxRows` data rows. | 413 |
| `CSV_TOO_MANY_FILES` | More than `maxFiles` files in an import. | 413 |
| `CSV_PARSE` | Malformed CSV, or an unusable delimiter. | 400 |
| `CSV_HEADER` | Any of: <ul><li>a missing, blank or repeated header;</li><li>a missing key column, or a model with no primary key and no keys given;</li><li>a column the operation can't take;</li><li>a header that doesn't resolve;</li><li>two headers writing one place;</li><li>a `where.` column on a create, or a non-key column on a delete;</li><li>a reference outside an import, or as a key;</li><li>two import files with one name, or files that refer to each other in a cycle.</li></ul> | 400 |
| `CSV_ROW_INVALID` | Any of: <ul><li>a cell that doesn't convert;</li><li>a row the input type or zod schema rejects;</li><li>a blank key cell, or keys that make no filter;</li><li>an unknown, repeated or later-row label, or a label of the wrong model;</li><li>several labels in a single-id field;</li><li>a labelled update row matching other than one row.</li></ul> | 400 |
| `CSV_ROW_NO_MATCH` | An update or delete row whose keys matched no row it may touch. | 400 |
| `CSV_ROW_FAILED` | The write itself failed. `cause` is the engine's error. | 400 |

Checks run in this order, and stop at the first failure: limits and parsing, then the header, then
every row's conversion (every file, in an import), then the writes. Nothing is written unless every
check passes and every write succeeds.

## ormize API

Exported from `@azerothian/ormize`. The engine transports rows. It doesn't check operation
permissions: as with `processCreate`, that is the caller's job.

### `Ormize` methods

```ts
csvLimits(defName: string): ResolvedCsvLimits | undefined;  // { maxRows, maxBytes }, or undefined if CSV is off for it
csvMaxFiles(): number | undefined;                         // files per import, or undefined if CSV is off

processCsv(
  defName: string,
  operation: CsvOperation,                 // "create" | "update" | "delete"
  request: CsvRequest,
  context: RequestContext,
  selection?: Selection,
): Promise<AdapterRow[]>;                   // every row written, in file order

processCsvImport(request: CsvImportRequest, context: RequestContext): Promise<CsvImportResult>;
```

### `CsvRequest`

What a surface hands `processCsv`, and each file of an import.

```ts
type CsvRequest = {
  upload: CsvUpload;
  keys?: string[];          // match columns, besides where.… columns. Default: the primary key
  delimiter?: string;       // default ","
  apply?: MutationApply;    // instance-method transforms for each created/updated row
  /** Refuse a column before any row is converted. Throw a CSV_HEADER CsvUploadError. */
  checkColumns?: (columns: { input: string[]; keys: string[] }) => void;
  /** Convert one row's string cells into the arguments of its write. */
  toArgs: (cells: CsvRowCells, row: number) => CsvRowArgs | Promise<CsvRowArgs>;
  /** Import only: the model a ….@ref column's labels must name. Others are refused before any write. */
  refTarget?: (column: string) => string | undefined;
};

type CsvRowCells = { input: CsvCells; keys: CsvCells };          // cells split by role
type CsvCells = { [column: string]: string | null };            // empty cells absent; \N is null
type CsvRowArgs = { input?: MutationInputTree; where?: MutationFilter };
```

`toArgs` errors:

- a `CsvUploadError` without a `row` is given this row's;
- any other error becomes `CSV_ROW_INVALID`.

An update or delete whose `toArgs` returns an empty `where` is refused, so a surface bug can't
widen a write to the whole table.

`CsvUpload` is any of:

- a string or `Uint8Array`;
- a sync or async iterable of those (a Node `Readable`, a web `ReadableStream`);
- an object with `createReadStream()` (graphql-upload's `FileUpload`);
- an object with `stream` (a web `File` or `Blob`);
- an object with `promise` (graphql-upload's `Upload`);
- a promise of any of these.

Wrappers are unwrapped up to four levels deep. Anything else is `CSV_UNSUPPORTED`.

### `CsvImportRequest` / `CsvImportResult`

```ts
type CsvImportRequest = {
  files: CsvImportFile[];
  /** A written row's id, as the files' inputs and filters take it (gqlize: a global id; nestize: the raw key). */
  refValue: (defName: string, row: AdapterRow) => unknown;
  /** The selection each model's writes run with (gqlize: the one that decodes global ids). */
  selection?: (defName: string) => Selection | undefined;
};

type CsvImportFile = {
  name: string;                              // unique within the import
  defName: string;
  operation: CsvImportOperation;             // "create" | "update"
  request: CsvRequest;
};

type CsvImportResult = {
  files: { name: string; defName: string; operation: CsvImportOperation; rows: AdapterRow[] }[];  // given order
  refs: { [label: string]: { defName: string; row: AdapterRow } };
};
```

A reference cell reaches `toArgs` with each label replaced by a placeholder token, `|`-joined for
several. The token is a string, so it passes conversion and validation as an id would. It is
swapped for `refValue(…)` of the labelled row just before the referencing row is written, so
`toArgs` must carry a reference cell's value through unchanged, at the place the header names.

The token's prefix carries a random nonce chosen per import, so a cell that spells out a token is
text, never a reference. A surface that knows which model a reference column points at should
supply `refTarget`. gqlize and nestize both do, so a label of the wrong model is a `CSV_ROW_INVALID`
naming the column, rather than a write of another model's key.

### Helpers

| Export | Signature | Does |
| --- | --- | --- |
| `csvCellValue` | `(raw: string \| null, descriptor: DataTypeDescriptor \| undefined) => unknown` | Converts a cell by abstract column type ([table](#nestize-by-column-type-csvcellvalue)). Throws `CSV_ROW_INVALID`, without row or column. |
| `csvNumber` | `(raw: string, integer: boolean) => number` | A trimmed number; refuses empty, non-finite and, if `integer`, fractional values. |
| `csvBoolean` | `(raw: string) => boolean` | `true`/`1`/`yes`, `false`/`0`/`no`, any case. |
| `csvJson` | `(raw: string) => unknown` | `JSON.parse`, refusing invalid JSON. |
| `csvList` | `(raw: string) => unknown[]` | A JSON array if the cell starts with `[`, else the `\|`-separated items. |
| `parseCsvHeader` | `(header: string) => CsvHeaderPath` | Parses a [header path](#grammar): `{ segments: { name, index? }[], op? }`. |
| `isCsvWhereHeader` | `(header: string) => boolean` | Starts with `where.` or `where?`. |
| `isCsvRefHeader` | `(header: string) => boolean` | Ends in `.@ref` / `?@ref` (not the bare `@ref` label column). |
| `CSV_NULL` | `"\\N"` | The null cell. |
| `CSV_REF` | `"@ref"` | The label column, and the reference marker. |
| `CSV_WHERE` | `"where"` | The match-column prefix. |
| `CSV_VALUE_OPERATORS` | `ReadonlySet<string>` | The single-value filter operators a surface with no typed filter may pass on (`eq`, `ne`, `like`, …; not the regex ones). With `CSV_LIST_OPERATORS`, an allow-list. Kept in step with graphql-types' `CORE_VALUE_FUNCS`. |
| `CSV_LIST_OPERATORS` | `ReadonlySet<string>` | Operator names whose value is a list (`in`, `notIn`, `between`, …). Kept in step with graphql-types' `SQL_ARRAY_VALUES`. |
| `DEFAULT_CSV_LIMITS` | `{ maxRows: 1000, maxBytes: 5242880 }` | |
| `DEFAULT_CSV_MAX_FILES` | `10` | |
