// Reading a CSV header name as a path into the write a row makes.
//
// A plain name (`name`) is a column, as it always was. A dotted one reaches
// into a relationship or a filter, one segment per level:
//
//   owner.create.name            the created owner's `name`
//   owner.set.name               set the owner matching `name = <cell>`
//   tags.add.label[in]           add every tag whose label is in the cell's list
//   tags.update.where.label      which tags an update touches…
//   tags.update.done             …and what it writes on them
//   tags.add[1].label            a second, separate `add` entry
//   where.rank[gte]              (top level) match the rows to update or delete
//   where.or[0].name[like]       any filter shape, combinators included
//
// `?` may stand in for `.` (`owner.set.where?name`). A trailing `[op]` (or
// `[Op.op]`) names the filter operator; without one a filter field means `eq`.
// A `[n]` after a segment picks the entry of a list; without one it is the
// first, which is what makes several columns under one verb merge into the same
// entry rather than each making its own.
//
// This module only parses. Resolving a path against what a model's input
// actually has is the surface's work (gqlize walks its GraphQL input types),
// since only it knows which segment is a relationship, a verb or a field.

import { CsvUploadError } from "./errors";

/** One step of a header path: a field name, and which list entry when the field is a list. */
export type CsvPathSegment = { name: string; index?: number };

export type CsvHeaderPath = {
  segments: CsvPathSegment[];
  /** The filter operator a trailing `[op]` named, `Op.` prefix removed. */
  op?: string;
};

/**
 * The reference marker of a multi-file import. Alone, it is the column that
 * labels a file's rows; as the last segment of a path (`author.@ref`,
 * `tags.add.@ref`, `ownerId.@ref`) it names labelled rows to point at.
 */
export const CSV_REF = "@ref";

/** Whether a header points at labelled rows (`….@ref`), as opposed to being the label column itself. */
export function isCsvRefHeader(header: string): boolean {
  return header !== CSV_REF && /[.?]@ref$/.test(header);
}

/** The top-level filter prefix: `where.<field>` columns match the rows an update or delete touches. */
export const CSV_WHERE = "where";

/**
 * The filter operators whose value is a list, for a surface with no typed
 * filter to read that off (nestize). The same names as `SQL_ARRAY_VALUES` in
 * graphql-types' `operators.ts`, which gqlize reads through its input types
 * instead; add an operator there and here together.
 */
export const CSV_LIST_OPERATORS: ReadonlySet<string> = new Set([
  "in", "notIn", "contains", "contained", "between", "notBetween",
  "overlap", "adjacent", "strictLeft", "strictRight", "noExtendRight", "noExtendLeft",
]);

const SEGMENT =/^([^.?[\]]+)((?:\[[^\]]*\])*)$/;

function bad(header: string, why: string): never {
  throw new CsvUploadError("CSV_HEADER", `Header "${header}" ${why}`, { column: header });
}

/** Split on `.`/`?` outside brackets, so `[Op.in]` stays one piece. */
function splitPath(header: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of header) {
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
    } else if (depth === 0 && (ch === "." || ch === "?")) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Parse one header name. Throws `CSV_HEADER` for a name that is not a well-formed path. */
export function parseCsvHeader(header: string): CsvHeaderPath {
  const parts = splitPath(header);
  const segments: CsvPathSegment[] = [];
  let op: string | undefined;
  parts.forEach((part, i) => {
    const match = SEGMENT.exec(part);
    if (!match) {
      bad(header, part === "" ? "has an empty segment" : `has a malformed segment "${part}"`);
    }
    const segment: CsvPathSegment = { name: match[1].trim() };
    const brackets = match[2] ? match[2].slice(1, -1).split("][") : [];
    for (const inner of brackets) {
      const text = inner.trim();
      if (/^\d+$/.test(text)) {
        if (segment.index !== undefined || op !== undefined) {
          bad(header, `has more than one index on "${segment.name}"`);
        }
        segment.index = Number(text);
      } else if (/^(Op\.)?[A-Za-z_$][\w$]*$/.test(text)) {
        if (i !== parts.length - 1 || op !== undefined) {
          bad(header, `names an operator "[${text}]" anywhere but at the end`);
        }
        op = text.replace(/^Op\./, "");
      } else {
        bad(header, `has a bracket "[${text}]" that is neither an index nor an operator`);
      }
    }
    segments.push(segment);
  });
  return { segments, op };
}

/** Whether a header is a top-level `where.…` filter column rather than a column to write. */
export function isCsvWhereHeader(header: string): boolean {
  return new RegExp(`^${CSV_WHERE}[.?]`).test(header);
}
