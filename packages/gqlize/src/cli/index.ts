#!/usr/bin/env node
import { run } from "./run";

/**
 * The `gqlize` binary.
 *
 * Deliberately thin: everything testable lives in `run.ts`, which returns an
 * exit code instead of taking one. All this file adds is the shebang, the
 * `process.exit`, and a last-resort handler so an unexpected throw still
 * produces a non-zero status instead of an unhandled rejection warning.
 */
run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
