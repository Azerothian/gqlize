import { HELP, parseCliArgs, UsageError } from "./args";
import { loadConfig } from "./config";
import { VERSION } from "../version";

export interface RunIO {
  out?: (line: string) => void;
  err?: (line: string) => void;
  cwd?: string;
}

/**
 * The CLI, as a function returning an exit code rather than calling
 * `process.exit`. `index.ts` is the thin shell that turns the code into an exit
 * — which is what makes the whole surface testable in-process.
 *
 * Exit codes: `0` ok, `1` the command ran and found a problem (drift, a missing
 * artifact), `2` the invocation itself was wrong.
 */
export async function run(argv: string[], io: RunIO = {}): Promise<number> {
  /* eslint-disable no-console */
  const out = io.out || ((line: string) => console.log(line));
  const err = io.err || ((line: string) => console.error(line));
  /* eslint-enable no-console */

  let args;
  try {
    args = parseCliArgs(argv);
  } catch (e: any) {
    err(e.message);
    err("");
    err(HELP);
    return 2;
  }

  if (args.version) {
    out(VERSION);
    return 0;
  }
  if (args.help) {
    out(HELP);
    return 0;
  }

  try {
    const resolved = await loadConfig(args.config, io.cwd);
    // Imported here rather than at module scope: every command pulls in the whole
    // schema builder, and `--help`, `--version` and a mistyped flag should not.
    switch (args.command) {
      case "build":
        return await (await import("./commands/build")).default(resolved, args, out);
      case "print":
        return await (await import("./commands/print")).default(resolved, args, out);
      case "check":
        return await (await import("./commands/check")).default(resolved, args, out, err);
    }
  } catch (e: any) {
    err(e instanceof UsageError ? `gqlize: ${e.message}` : (e?.stack || String(e)));
    return e instanceof UsageError ? 2 : 1;
  }
}

export default run;
