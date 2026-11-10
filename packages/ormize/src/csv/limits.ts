// Which models take CSV uploads, and under what limits: the instance-wide
// `GqlizeOptions.csv` folded with a definition's own `csv`.

import type { CsvLimits, CsvOptions, ResolvedCsvLimits } from "@azerothian/utilize/types/index";

export const DEFAULT_CSV_LIMITS: ResolvedCsvLimits = {
  maxRows: 1000,
  maxBytes: 5 * 1024 * 1024,
};

/**
 * The limits a model's uploads run under, or `undefined` when it takes none.
 *
 * Off unless the instance turns it on — a definition cannot opt itself in,
 * because the host has to be parsing multipart for the argument to mean
 * anything. A definition can only opt out (`false`) or tighten/loosen the
 * numbers.
 */
export function resolveCsvLimits(
  instance: boolean | CsvOptions | undefined,
  definition: false | CsvLimits | undefined,
): ResolvedCsvLimits | undefined {
  if (!instance || definition === false) {
    return undefined;
  }
  const base = instance === true ? {} : instance;
  return {
    maxRows: definition?.maxRows ?? base.maxRows ?? DEFAULT_CSV_LIMITS.maxRows,
    maxBytes: definition?.maxBytes ?? base.maxBytes ?? DEFAULT_CSV_LIMITS.maxBytes,
  };
}

/** Files in one multi-file import when `GqlizeOptions.csv.maxFiles` is not set. */
export const DEFAULT_CSV_MAX_FILES = 10;

/** How many files one import may carry, or `undefined` when CSV is off. */
export function resolveCsvMaxFiles(instance: boolean | CsvOptions | undefined): number | undefined {
  if (!instance) {
    return undefined;
  }
  return (instance === true ? undefined : instance.maxFiles) ?? DEFAULT_CSV_MAX_FILES;
}
