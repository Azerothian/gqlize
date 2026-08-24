/**
 * The pagination backstop, shared by every list path.
 *
 * Without it an absent `first`/`last` produces an unbounded `findAll` — a
 * full-table dump — and an over-large value is passed straight through. Both
 * are trivial DoS / data-exfiltration vectors, which is why this lives in one
 * place: three copies that can drift is a worse problem than twelve duplicated
 * lines.
 */
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;

/**
 * Coerce a client-supplied page size to a safe, bounded integer: falls back to
 * {@link DEFAULT_PAGE_SIZE} when absent, NaN or non-positive, and caps at
 * {@link MAX_PAGE_SIZE}.
 */
export function clampPageSize(value: unknown): number {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(n, MAX_PAGE_SIZE);
}
