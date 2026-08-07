import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {join} from "node:path";
import {promisify} from "node:util";

import {VERSION} from "../../src/version";

const execFileAsync = promisify(execFile);

/**
 * `src/cli/index.ts` is the shell that turns `run()`'s return value into a
 * process exit status. Everything below it is covered in-process by
 * `run.test.ts`; what only a real subprocess can prove is that the shebang is
 * there, that the entry point actually boots, and that the exit code reaches
 * the shell — which is all a CI pipeline ever looks at.
 *
 * Spawned through `tsx` (a devDependency) rather than bare `node`, because the
 * sources use extensionless relative imports that Node's ESM resolver rejects.
 * The published binary runs the compiled CJS instead, so this is about the
 * entry point's behaviour, not its module format.
 */
const ENTRY = join(__dirname, "..", "..", "src", "cli", "index.ts");
const TSX = createRequire(__filename).resolve("tsx/cli");

function gqlize(...args: string[]) {
  return execFileAsync(process.execPath, [TSX, ENTRY, ...args]);
}

describe("the gqlize binary", () => {
  it("starts with a shebang", async() => {
    const source = await readFile(ENTRY, "utf8");
    expect(source.split("\n")[0]).toEqual("#!/usr/bin/env node");
  });

  it("prints its version and exits 0", async() => {
    const {stdout} = await gqlize("--version");
    expect(stdout.trim()).toEqual(VERSION);
  }, 60000);

  it("exits 2 on a bad invocation", async() => {
    // execFile rejects on a non-zero status, carrying the code on the error
    const failure = await gqlize("--nonsense").catch((e) => e);
    expect(failure.code).toEqual(2);
    expect(failure.stderr).toContain("gqlize build");
  }, 60000);
});
