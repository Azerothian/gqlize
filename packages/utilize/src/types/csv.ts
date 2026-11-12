/**
 * CSV mutation uploads — the limits a deployment sets on them. The parser and
 * the engine that apply them live in ormize (`src/csv/`); this file only names
 * what `GqlizeOptions.csv` and `Definition.csv` accept.
 */

/**
 * Limits on a CSV mutation upload (`GqlizeOptions.csv`). Both are checked
 * while the file is still streaming in, so an oversized upload is refused
 * before it is buffered, let alone written.
 */
export type CsvLimits = {
  /** Data rows (the header line not counted). Default `1000`. */
  maxRows?: number;
  /** Bytes read from the upload. Default `5 * 1024 * 1024`. */
  maxBytes?: number;
};

/**
 * What `GqlizeOptions.csv` takes: the per-file {@link CsvLimits}, plus the
 * limits only an instance can set because they span several models.
 */
export type CsvOptions = CsvLimits & {
  /** Files in one multi-file import (`csvImport`, `POST /_csv`). Default `10`. */
  maxFiles?: number;
};

/** {@link CsvLimits} with every default applied — what the engine enforces. */
export type ResolvedCsvLimits = Required<CsvLimits>;
