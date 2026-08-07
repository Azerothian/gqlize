import {HELP, parseCliArgs, UsageError} from "../../src/cli/args";

/**
 * `parseArgs` does the lexing; what is worth testing here is the policy layered
 * on top of it — which invocations are rejected, and how the three-state flags
 * (`--pretty` / `--no-pretty` / neither) collapse.
 */
describe("parseCliArgs", () => {
  it("treats a bare `gqlize` as a request for help", () => {
    const args = parseCliArgs([]);
    expect(args.help).toEqual(true);
    expect(args.command).toEqual("build");
  });

  it("does not show help just because the command was omitted", () => {
    // `gqlize --out x` clearly wants work done, and `build` is the default
    const args = parseCliArgs(["--out", "x.json"]);
    expect(args.help).toEqual(false);
    expect(args.command).toEqual("build");
    expect(args.out).toEqual("x.json");
  });

  it("parses each command", () => {
    expect(parseCliArgs(["build"]).command).toEqual("build");
    expect(parseCliArgs(["print"]).command).toEqual("print");
    expect(parseCliArgs(["check"]).command).toEqual("check");
    expect(parseCliArgs(["build"]).help).toEqual(false);
  });

  it("rejects an unknown command", () => {
    expect(() => parseCliArgs(["wat"])).toThrow(UsageError);
    expect(() => parseCliArgs(["wat"])).toThrow(/unknown command "wat"/);
  });

  it("rejects more than one command", () => {
    expect(() => parseCliArgs(["build", "check"])).toThrow(/expected one command, got 2/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["build", "--nope"])).toThrow(UsageError);
  });

  it("rejects --profile together with --all-profiles", () => {
    expect(() => parseCliArgs(["build", "--profile", "a", "--all-profiles"]))
      .toThrow(/mutually exclusive/);
  });

  it("reads the short flags", () => {
    const args = parseCliArgs(["build", "-c", "cfg.ts", "-o", "out.json", "-p", "admin"]);
    expect(args.config).toEqual("cfg.ts");
    expect(args.out).toEqual("out.json");
    expect(args.profile).toEqual("admin");
    expect(parseCliArgs(["-h"]).help).toEqual(true);
    expect(parseCliArgs(["-v"]).version).toEqual(true);
  });

  it("leaves `pretty` undefined so the config can decide", () => {
    expect(parseCliArgs(["build"]).pretty).toBeUndefined();
    expect(parseCliArgs(["build", "--pretty"]).pretty).toEqual(true);
    expect(parseCliArgs(["build", "--no-pretty"]).pretty).toEqual(false);
    // an explicit negation beats an explicit affirmation, whatever the order
    expect(parseCliArgs(["build", "--pretty", "--no-pretty"]).pretty).toEqual(false);
  });

  it("defaults `strict` on, because the weaker check cannot see permission drift", () => {
    expect(parseCliArgs(["check"]).strict).toEqual(true);
    expect(parseCliArgs(["check", "--no-strict"]).strict).toEqual(false);
    expect(parseCliArgs(["check", "--strict"]).strict).toEqual(true);
  });

  it("carries the remaining flags through", () => {
    const args = parseCliArgs([
      "print", "--from-artifact", "a.json", "--sorted", "--gzip",
      "--permission-profile", "anon", "--sdl", "s.graphql", "--artifact", "b.json",
      "--all-profiles",
    ]);
    expect(args.fromArtifact).toEqual("a.json");
    expect(args.sorted).toEqual(true);
    expect(args.gzip).toEqual(true);
    expect(args.permissionProfile).toEqual("anon");
    expect(args.sdl).toEqual("s.graphql");
    expect(args.artifact).toEqual("b.json");
    expect(args.allProfiles).toEqual(true);
  });

  it("documents every command and the exit codes in --help", () => {
    // the help text is the only documentation the binary carries; a command
    // added without a help entry is a command nobody finds
    for (const command of ["build", "print", "check"]) {
      expect(HELP).toContain(`gqlize ${command}`);
    }
    expect(HELP).toContain("Exit codes");
  });
});
