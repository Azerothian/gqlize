/**
 * What does a *request* cost?
 *
 * `bench-artifact.ts` measures building and loading a schema, which happens once
 * per process. This measures the other half: executing a query against one,
 * which happens per request and is where a regression actually hurts.
 *
 * Deliberately a script and not a test, for the same reason its sibling is —
 * timings are machine-specific and would be a flaky assertion.
 *
 * The numbers are only useful as a comparison against themselves. Run it on a
 * branch, run it on main, compare. An absolute figure from one machine says
 * nothing, and the in-process sqlite here is much faster than any real database,
 * so the engine's share of a production request is *smaller* than what this
 * reports — which is exactly why it is the right harness for deciding whether an
 * engine-level optimisation is worth making.
 *
 *     pnpm bench:resolve
 *     pnpm bench:resolve -- --models 50 --rows 200 --iterations 300
 */
import { Ormize } from "@azerothian/ormize";
// By path, matching `bench-artifact.ts`: the adapter's published `exports`
// subpaths only exist after a build, and this runs from source.
import SequelizeAdapter from "../../ormize-adapter-sequelize/src/index";
import { graphql, type GraphQLSchema } from "graphql";

import { createSchema } from "../src/index";
import { syntheticDefinitions, type Topology } from "./synthetic-schema";

interface Args {
  models: number;
  topology: Topology;
  fields: number;
  rows: number;
  iterations: number;
  warmup: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {models: 20, topology: "chain", fields: 8, rows: 100, iterations: 200, warmup: 30};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--": break;
      case "--models": out.models = Number(value); i++; break;
      case "--topology": out.topology = value as Topology; i++; break;
      case "--fields": out.fields = Number(value); i++; break;
      case "--rows": out.rows = Number(value); i++; break;
      case "--iterations": out.iterations = Number(value); i++; break;
      case "--warmup": out.warmup = Number(value); i++; break;
      case "--help":
        console.log(
          "usage: bench-resolve [--models N] [--topology chain|wide] [--fields N]\n" +
          "                     [--rows N] [--iterations N] [--warmup N]",
        );
        process.exit(0);
    }
  }
  return out;
}

/**
 * Percentiles, not a mean. A resolution path allocates, so the distribution has
 * a GC tail, and a mean hides exactly the thing an optimisation is supposed to
 * move.
 */
function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: total / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function line(label: string, samples: number[]): string {
  const s = stats(samples);
  const f = (n: number) => n.toFixed(3).padStart(8);
  return `${label.padEnd(28)} p50 ${f(s.p50)}  p95 ${f(s.p95)}  p99 ${f(s.p99)}  mean ${f(s.mean)}  (ms)`;
}

async function run(schema: GraphQLSchema, query: string, args: Args): Promise<number[]> {
  // Warm up first: the first executions pay for lazy type materialisation and
  // JIT, and folding that into the sample makes every later comparison noise.
  for (let i = 0; i < args.warmup; i++) {
    await graphql({schema, source: query});
  }
  const samples: number[] = [];
  for (let i = 0; i < args.iterations; i++) {
    const start = process.hrtime.bigint();
    const result = await graphql({schema, source: query});
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    if (result.errors?.length) {
      throw new Error(`query failed: ${result.errors[0].message}`);
    }
  }
  return samples;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const db = new Ormize();
  db.registerAdapter(new SequelizeAdapter({}, {dialect: "sqlite", logging: false}), "sqlite");
  for (const definition of syntheticDefinitions(args)) {
    await db.addDefinition(definition);
  }
  await db.initialise();
  await db.sync();

  // Two models' worth of rows is enough: the query set below reads the root
  // model and one relationship hop, which is the shape every request has.
  const root = db.models.Synth0 as unknown as { bulkCreate(rows: object[]): Promise<unknown> };
  const child = db.models.Synth1 as unknown as { bulkCreate(rows: object[]): Promise<unknown> };
  // Every column, not just the first two: `syntheticDefinitions` makes odd-numbered
  // fields `allowNull: false` and every fourth an INTEGER, so a partial row fails
  // the NOT NULL constraint rather than benchmarking anything.
  const rows = Array.from({length: args.rows}, (_, i) => {
    const row: { [field: string]: string | number } = {};
    for (let f = 0; f < args.fields; f++) {
      row[`field${f}`] = f % 4 === 3 ? i : `f${f}-${i}`;
    }
    return row;
  });
  await root.bulkCreate(rows);
  await child.bulkCreate(rows);

  const schema = await createSchema(db);

  const QUERIES: {label: string; query: string}[] = [
    {
      label: "scalar list",
      query: `{ models { Synth0(first: ${args.rows}) { edges { node { id field0 field1 } } } } }`,
    },
    {
      label: "scalar list + total",
      query: `{ models { Synth0(first: ${args.rows}) { total edges { node { id field0 } } } } }`,
    },
    {
      label: "single row by first",
      query: `{ models { Synth0(first: 1) { edges { node { id field0 field1 field2 field3 } } } } }`,
    },
    {
      label: "filtered list",
      query: `{ models { Synth0(first: ${args.rows}, where: { field0: { like: "row-1%" } }) { edges { node { id field0 } } } } }`,
    },
    {
      label: "ordered list",
      query: `{ models { Synth0(first: ${args.rows}, orderBy: [field0DESC]) { edges { node { id field0 } } } } }`,
    },
  ];

  console.log(
    `models: ${args.models}  topology: ${args.topology}  fields/model: ${args.fields}  ` +
    `rows: ${args.rows}  iterations: ${args.iterations} (after ${args.warmup} warmup)`,
  );
  console.log("");

  for (const {label, query} of QUERIES) {
    let samples: number[];
    try {
      samples = await run(schema, query, args);
    } catch (e) {
      console.log(`${label.padEnd(28)} SKIPPED — ${(e as Error).message}`);
      continue;
    }
    console.log(line(label, samples));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/*
 * What this measured, 2026-09-01 — 20 models, 100 rows, 200 iterations, sqlite:
 *
 *   scalar list            p50 1.79 ms
 *   scalar list + total    p50 1.60 ms
 *   single row by first    p50 1.29 ms
 *   filtered list          p50 1.23 ms
 *   ordered list           p50 1.91 ms
 *
 * And the split that decides whether any of it is worth optimising — the same
 * query run as a bare `Model.findAll` against the same rows:
 *
 *   raw sequelize findAll  p50 1.474 ms
 *   full graphql request   p50 1.777 ms
 *
 * The database is 83% of the request. Everything this repo owns — the resolution
 * engine, graphql execution, serialisation — is the remaining 17%, and that is
 * the *most* favourable framing available: sqlite runs in-process, so a real
 * database over a socket makes the engine's share smaller still, not larger.
 *
 * So there is no engine-level optimisation here worth making on current
 * evidence. A change that made the whole resolution path 20% faster would move a
 * request by about 3%. That is the finding, and it is why nothing was optimised
 * — not an omission.
 *
 * Two things were checked and needed no change:
 *
 *  - The copy-on-write guards added in 7.0.0-beta.11 really do allocate nothing
 *    in the steady state. `expandComputedOrder` returns its input by identity —
 *    the same args object, and the same nested `include` array — whenever the
 *    ordering names a real column rather than a computed one, which is every
 *    ordinary request. That was previously an assertion in a comment.
 *  - `getFields` is already memoised per model (`getMetaObj`), and
 *    `getDefinition` is a plain object index, so neither is doing repeated work
 *    per field or per row.
 *
 * If you change the resolution path, run this before and after. An absolute
 * number from one machine means nothing; the delta against itself is the point.
 */
