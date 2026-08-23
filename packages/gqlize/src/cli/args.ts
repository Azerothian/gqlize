import { parseArgs } from "node:util";

/**
 * Thrown for anything the user could fix by re-reading `--help`: an unknown
 * command, a bad flag, a missing value. The entry point maps it to exit code 2,
 * which is distinct from exit code 1 ("the command ran and found a problem").
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type Command = "build" | "print" | "check";

export interface ParsedArgs {
  command: Command;
  help: boolean;
  version: boolean;
  config?: string;
  out?: string;
  sdl?: string;
  profile?: string;
  allProfiles: boolean;
  permissionProfile?: string;
  pretty?: boolean;
  gzip: boolean;
  fromArtifact?: string;
  artifact?: string;
  sorted: boolean;
  strict: boolean;
}

// `node:util.parseArgs` rather than a dependency: `engines.node >= 24`, and the
// surface here is small enough that a parser library would be all cost.
const OPTIONS = {
  help: {type: "boolean", short: "h", default: false},
  version: {type: "boolean", short: "v", default: false},
  config: {type: "string", short: "c"},
  out: {type: "string", short: "o"},
  sdl: {type: "string"},
  profile: {type: "string", short: "p"},
  "all-profiles": {type: "boolean", default: false},
  "permission-profile": {type: "string"},
  pretty: {type: "boolean"},
  "no-pretty": {type: "boolean", default: false},
  gzip: {type: "boolean", default: false},
  "from-artifact": {type: "string"},
  artifact: {type: "string"},
  sorted: {type: "boolean", default: false},
  strict: {type: "boolean"},
  "no-strict": {type: "boolean", default: false},
} as const;

const COMMANDS: Command[] = ["build", "print", "check"];

export function parseCliArgs(argv: string[]): ParsedArgs {
  // npm and pnpm forward their own `--` separator into the script's argv, so
  // `pnpm schema:build -- --pretty` arrives here as `["build", "--", "--pretty"]`.
  // Node's parser treats everything past it as positional, which turns a command
  // line the user wrote correctly into "expected one command, got 2".
  const separator = argv.indexOf("--");
  const args = separator === -1
    ? argv
    : [...argv.slice(0, separator), ...argv.slice(separator + 1)];
  let parsed;
  try {
    parsed = parseArgs({args, options: OPTIONS as any, allowPositionals: true, strict: true});
  } catch (err: any) {
    throw new UsageError(err.message);
  }
  const {values, positionals} = parsed;

  if (positionals.length > 1) {
    throw new UsageError(
      `expected one command, got ${positionals.length}: ${positionals.join(", ")}`,
    );
  }
  const [name] = positionals;
  // `gqlize --help` with no command is legitimate; `gqlize wat` is not
  if (name !== undefined && !COMMANDS.includes(name as Command)) {
    throw new UsageError(`unknown command "${name}" (expected ${COMMANDS.join(", ")})`);
  }
  if (values.profile && values["all-profiles"]) {
    throw new UsageError("--profile and --all-profiles are mutually exclusive");
  }

  return {
    // `build` is the default command, so `gqlize --out x` does the obvious thing
    command: (name as Command) || "build",
    // bare `gqlize` is a request for help; `gqlize --out x` is not
    help: Boolean(values.help) || args.length === 0,
    version: Boolean(values.version),
    config: values.config as string | undefined,
    out: values.out as string | undefined,
    sdl: values.sdl as string | undefined,
    profile: values.profile as string | undefined,
    allProfiles: Boolean(values["all-profiles"]),
    permissionProfile: values["permission-profile"] as string | undefined,
    // `--no-pretty` wins over `--pretty`; `undefined` means "defer to the config"
    pretty: values["no-pretty"] ? false : (values.pretty as boolean | undefined),
    gzip: Boolean(values.gzip),
    fromArtifact: values["from-artifact"] as string | undefined,
    artifact: values.artifact as string | undefined,
    sorted: Boolean(values.sorted),
    // strict is the default for `check`: the weaker fingerprint-only comparison
    // cannot see permission drift, so opting out has to be deliberate
    strict: values["no-strict"] ? false : (values.strict as boolean | undefined) ?? true,
  };
}

export const HELP = `gqlize — pre-generate and verify GraphQL schema artifacts

Usage
  gqlize build [options]     build the schema artifact(s)
  gqlize print [options]     print the schema as SDL
  gqlize check [options]     compare an artifact against the live definitions

Common
  -c, --config <path>        config file (default: nearest gqlize.config.{ts,mts,mjs,js,cjs},
                             then package.json#gqlize)
  -p, --profile <name>       build one named profile
      --all-profiles         build every named profile
      --permission-profile <id>
                             opaque id recorded in the fingerprint; override the
                             config's value
  -h, --help                 show this help
  -v, --version              print the gqlize version

build
  -o, --out <path>           artifact path (default: ./gqlize.schema.json)
      --sdl <path>           also write an SDL sidecar
      --pretty               indent the artifact JSON (default: compact)
      --gzip                 gzip the artifact (appends .gz if absent)

print
      --from-artifact <path> print from an artifact instead of a live build
      --sorted               lexicographically sort the schema first

check
      --artifact <path>      artifact to check (default: the resolved out path)
      --no-strict            compare fingerprints only; skip the live SDL diff

Exit codes
  0  ok      1  drift or failure      2  usage error
`;
