/**
 * What does an artifact actually cost to load?
 *
 * The README makes a claim about this, and a claim about performance that
 * nobody can re-run is a claim with a shelf life. This is the thing that
 * produces the numbers in it.
 *
 * Deliberately a script and not a test: the timings are machine-specific and
 * would be a flaky assertion. The *behaviour* at scale is pinned by
 * `__tests__/snapshot/scale.test.ts`, which shares the generator with this.
 *
 *     pnpm bench:artifact -- --models 1000 --topology wide
 *     pnpm bench:artifact -- --models 1200 --topology chain
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { gzipSync } from "zlib";
import { Ormize } from "@azerothian/ormize";
// By path, for the same reason jest's `moduleNameMapper` does it: the adapter's
// published `exports` subpaths only exist after a build, and this runs from source.
import SequelizeAdapter from "../../ormize-adapter-sequelize/src/index";

import { createSchema } from "../src/index";
import { snapshotSchema } from "../src/graphql/snapshot/snapshot";
import { materializeSchema } from "../src/graphql/snapshot/materialize";
import { syntheticDefinitions, type Topology } from "./synthetic-schema";

interface Args {
  models: number;
  topology: Topology;
  fields: number;
  /**
   * Where to keep the artifact between runs.
   *
   * A live build and a materialize in the same process is not a fair race: the
   * live build runs first and warms every shared builder the materialize then
   * uses. Point both runs at the same path and the first writes the artifact
   * while reporting a cold live build, the second reads it and reports a cold
   * load — two processes, one measurement each, which is what a boot is.
   */
  artifact?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {models: 150, topology: "chain", fields: 8};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      // pnpm forwards the separator itself; ignoring it lets the documented
      // `pnpm bench:artifact -- --models N` form work verbatim
      case "--": break;
      case "--models": out.models = Number(value); i++; break;
      case "--topology": out.topology = value as Topology; i++; break;
      case "--fields": out.fields = Number(value); i++; break;
      case "--artifact": out.artifact = value; i++; break;
      case "--help":
        console.log(
          "usage: bench-artifact [--models N] [--topology chain|wide] [--fields N]\n" +
          "                      [--artifact <path>]  write it on the first run, load it cold on the next",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`bench-artifact: unknown argument "${argv[i]}"`);
    }
  }
  if (!Number.isFinite(out.models) || out.models < 1) {
    throw new Error("bench-artifact: --models must be a positive number");
  }
  if (out.topology !== "chain" && out.topology !== "wide") {
    throw new Error(`bench-artifact: unknown topology "${out.topology}"`);
  }
  return out;
}

async function time<T>(label: string, fn: () => T | Promise<T>): Promise<[T, string]> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return [result, `${label}: ${ms.toFixed(1)} ms`];
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string) => console.log(line);

  const db = new Ormize();
  db.registerAdapter(new SequelizeAdapter({}, {dialect: "sqlite", logging: false}), "sqlite");
  for (const definition of syntheticDefinitions(args)) {
    db.addDefinition(definition);
  }
  const [, initLine] = await time("initialise + sync", async() => {
    await db.initialise();
    await db.sync();
  });

  log(`models: ${args.models}  topology: ${args.topology}  fields/model: ${args.fields}`);
  log(initLine);

  // Second run against a stored artifact: the load is the first schema work
  // this process does, which is the only way to compare it to a cold live build.
  if (args.artifact && existsSync(args.artifact)) {
    log(`loading ${args.artifact} (cold — no live build in this process)`);
    const json = readFileSync(args.artifact, "utf8");
    log(`bytes: ${mb(Buffer.byteLength(json))}`);
    const [parsed, parseLine] = await time("JSON.parse", () => JSON.parse(json));
    log(parseLine);
    const [, loadLine] = await time("materializeSchema (cold, staleness checked)", () =>
      materializeSchema(parsed, db, {onMismatch: "throw"}));
    log(loadLine);
    const unchecked = JSON.parse(json);
    const [, uncheckedLine] = await time("materializeSchema (warm, checkStaleness false)", () =>
      materializeSchema(unchecked, db, {checkStaleness: false}));
    log(uncheckedLine);
    return;
  }

  const [schema, liveLine] = await time("live createSchema (cold)", () => createSchema(db));
  log(`types: ${Object.keys(schema.getTypeMap()).length}`);
  log(liveLine);

  const [snapshot, snapshotLine] = await time("snapshotSchema", () => snapshotSchema(schema));
  log(snapshotLine);

  const [compact, stringifyLine] = await time("JSON.stringify (compact)", () =>
    JSON.stringify(snapshot));
  log(stringifyLine);
  const pretty = JSON.stringify(snapshot, null, 2);
  log(`bytes: compact ${mb(Buffer.byteLength(compact))}` +
    `  pretty ${mb(Buffer.byteLength(pretty))}` +
    `  gzip ${mb(gzipSync(compact).length)}`);

  if (args.artifact) {
    writeFileSync(args.artifact, compact);
    log(`wrote ${args.artifact} — run again with the same arguments to time a cold load`);
    return;
  }

  // Everything below runs with the live build's warmth behind it, so it reads
  // faster than a real boot would. The staleness delta is the one honest
  // comparison here, because both sides of it are equally warm.
  const [parsed, parseLine] = await time("JSON.parse", () => JSON.parse(compact));
  log(parseLine);
  await materializeSchema(JSON.parse(compact), db, {checkStaleness: false});
  const [, checkedLine] = await time("materializeSchema (warm, staleness checked)", () =>
    materializeSchema(parsed, db, {onMismatch: "throw"}));
  log(checkedLine);
  const unchecked = JSON.parse(compact);
  const [, uncheckedLine] = await time("materializeSchema (warm, checkStaleness false)", () =>
    materializeSchema(unchecked, db, {checkStaleness: false}));
  log(uncheckedLine);
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
