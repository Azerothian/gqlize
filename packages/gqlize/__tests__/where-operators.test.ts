import {graphql, GraphQLSchema, GraphQLInputObjectType, GraphQLBoolean} from "graphql";
import Sequelize, {Op} from "sequelize";
import {describe, it, expect} from "@jest/globals";

import {createInstance, resultData, validateResult} from "./helper";
import {currentDialect} from "./helper/dialect";
import {createSchema} from "../src";
import type {Definition} from "../src/types";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

type Edge<T> = {node: T};
type Connection<T> = {edges: Edge<T>[]; total?: number};
type ProbeNamesResult = {models: {Probe: Connection<{label: string}>}};
type ProbeIdsResult = {models: {Probe: Connection<{id: string; label: string}>}};

// ---------------------------------------------------------------------------
// Extra definition: Probe model — purpose-built for testing where operators
// ---------------------------------------------------------------------------

/**
 * Columns: string (label), int (value), float (amount), boolean (flag),
 * nullable string (note), JSONB (meta), and — on Postgres only — ARRAY(INTEGER)
 * (tags).
 *
 * The Postgres-only column is guarded by `currentDialect()` because
 * ARRAY(INTEGER) is a Postgres extension; SQLite has no native array type.
 */
function probeDefinition(): Definition {
  const define: Record<string, unknown> = {
    label: {type: Sequelize.STRING, allowNull: false},
    value: {type: Sequelize.INTEGER, allowNull: false},
    amount: {type: Sequelize.FLOAT, allowNull: false},
    flag: {type: Sequelize.BOOLEAN, allowNull: true},
    note: {type: Sequelize.STRING, allowNull: true},
    meta: {type: Sequelize.JSONB, allowNull: true},
  };
  if (currentDialect() === "postgres") {
    define.tags = {type: Sequelize.ARRAY(Sequelize.INTEGER), allowNull: true};
  }
  return {
    name: "Probe",
    define,
    options: {tableName: "probes"},
  } as Definition;
}

// ---------------------------------------------------------------------------
// Seed data (deterministic, mixed case, nulls, ties)
// ---------------------------------------------------------------------------

interface SeedRow {
  label: string;
  value: number;
  amount: number;
  flag: boolean | null;
  note: string | null;
  meta: object | null;
  tags?: number[];
}

const SEED: SeedRow[] = [
  {label: "Alpha",   value: 10, amount: 1.5,  flag: true,  note: "first",  meta: {k: "a"}},
  {label: "bravo",   value: 20, amount: 2.5,  flag: false, note: "second", meta: {k: "b"}},
  {label: "Charlie", value: 20, amount: 3.0,  flag: true,  note: null,     meta: null},
  {label: "delta",   value: 30, amount: 0.5,  flag: null,  note: "FIRST",  meta: {k: "a"}},
  {label: "Echo",    value: 40, amount: 4.5,  flag: false, note: "third",  meta: {k: "c"}},
];

const PG_TAGS: (number[] | null)[] = [
  [1, 2, 3],
  [2, 3],
  [3, 4, 5],
  null,
  [1, 5],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Instance = Awaited<ReturnType<typeof createInstance>>;

async function buildProbeInstance(): Promise<{instance: Instance; schema: GraphQLSchema}> {
  const instance = await createInstance([probeDefinition()]);
  const {Probe} = instance.models;
  const isPg = currentDialect() === "postgres";
  for (let i = 0; i < SEED.length; i++) {
    const row: Record<string, unknown> = {...SEED[i]};
    if (isPg) {
      row.tags = PG_TAGS[i];
    }
    await Probe.create(row);
  }
  const schema = await createSchema(instance);
  return {instance, schema};
}

function labels(result: unknown): string[] {
  return (result as ProbeNamesResult).models.Probe.edges.map((e) => e.node.label);
}

// ---------------------------------------------------------------------------
// eq / ne / gt / gte / lt / lte
// ---------------------------------------------------------------------------

describe("scalar comparison operators", () => {
  it("eq filters to exact match", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {label: {eq: "Alpha"}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha"]);
  });

  it("ne excludes exact match", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {label: {ne: "Alpha"}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["bravo", "Charlie", "delta", "Echo"]);
  });

  it("gt on integer", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {value: {gt: 20}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["delta", "Echo"]);
  });

  it("gte on integer", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {value: {gte: 20}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["bravo", "Charlie", "delta", "Echo"]);
  });

  it("lt on integer", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {value: {lt: 20}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha"]);
  });

  it("lte on integer", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {value: {lte: 20}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha", "bravo", "Charlie"]);
  });

  it("gt on float", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {amount: {gt: 3.0}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Echo"]);
  });
});

// ---------------------------------------------------------------------------
// not / is with null and booleans
// ---------------------------------------------------------------------------

describe("not / is operators", () => {
  it("is null", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {note: {is: null}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Charlie"]);
  });

  it("not null", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {note: {not: null}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha", "bravo", "delta", "Echo"]);
  });

  it("eq true (boolean)", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {flag: {eq: true}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha", "Charlie"]);
  });

  it("flag is null", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {flag: {is: null}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["delta"]);
  });
});

// ---------------------------------------------------------------------------
// like / notLike / iLike / notILike / startsWith / endsWith / substring
// ---------------------------------------------------------------------------

describe("pattern-matching operators", () => {
  it("like matches pattern", async () => {
    const {schema} = await buildProbeInstance();
    // SQLite LIKE is case-insensitive for ASCII; Postgres LIKE is case-sensitive.
    // "A%" matches "Alpha" on both dialects (starts with uppercase A).
    const result = await graphql({schema, source: `{
      models { Probe(where: {label: {like: "A%"}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha"]);
  });

  it("notLike excludes matching pattern (case-sensitivity varies by dialect)", async () => {
    const {schema} = await buildProbeInstance();
    // Use "%lph%" which only matches "Alpha" regardless of case sensitivity:
    // both dialects find lowercase "lph" in "Alpha" → notLike excludes it.
    const result = await graphql({schema, source: `{
      models { Probe(where: {label: {notLike: "%lph%"}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["bravo", "Charlie", "delta", "Echo"]);
  });

  it("like case-sensitivity: Postgres LIKE is case-sensitive, SQLite is not", async () => {
    const {schema} = await buildProbeInstance();
    // "%E%" matches only uppercase E. On Postgres (case-sensitive LIKE), this
    // matches "Echo" only. On SQLite (case-insensitive), it matches anything
    // containing "e" in any case: "Charlie" (e), "delta" (e), "Echo" (E).
    const result = await graphql({schema, source: `{
      models { Probe(where: {label: {like: "%E%"}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    const expected = currentDialect() === "postgres"
      ? ["Echo"]
      : ["Charlie", "delta", "Echo"];
    expect(labels(resultData(result))).toEqual(expected);
  });

  it("iLike performs case-insensitive match", async () => {
    const {schema} = await buildProbeInstance();
    // On Postgres, iLike is native ILIKE. On SQLite, it is translated to LIKE
    // (which is already case-insensitive for ASCII).
    const result = await graphql({schema, source: `{
      models { Probe(where: {label: {iLike: "a%"}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha"]);
  });

  it("notILike excludes case-insensitive match", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {label: {notILike: "%a%"}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    // Both dialects should return only "Echo" (no "a" in any case)
    expect(labels(resultData(result))).toEqual(["Echo"]);
  });

  it("startsWith", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {label: {startsWith: "Ch"}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Charlie"]);
  });

  it("endsWith", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {label: {endsWith: "ho"}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Echo"]);
  });

  it("substring", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {label: {substring: "rav"}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["bravo"]);
  });
});

// ---------------------------------------------------------------------------
// in / notIn (including edge cases)
// ---------------------------------------------------------------------------

describe("in / notIn operators", () => {
  it("in matches listed values", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {value: {in: [10, 30]}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha", "delta"]);
  });

  it("in: [] matches nothing", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {value: {in: []}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual([]);
  });

  it("notIn excludes listed values", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {value: {notIn: [10, 20]}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["delta", "Echo"]);
  });

  it("notIn: [] matches everything", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {value: {notIn: []}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha", "bravo", "Charlie", "delta", "Echo"]);
  });
});

// ---------------------------------------------------------------------------
// between / notBetween
// ---------------------------------------------------------------------------

describe("between / notBetween operators", () => {
  it("between inclusive range", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {value: {between: [15, 35]}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["bravo", "Charlie", "delta"]);
  });

  it("notBetween excludes the range", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {value: {notBetween: [15, 35]}}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha", "Echo"]);
  });
});

// ---------------------------------------------------------------------------
// and / or nested (2-3 levels)
// ---------------------------------------------------------------------------

describe("and / or nested combinators", () => {
  it("and combines conditions", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {and: [{value: {gte: 20}}, {flag: {eq: true}}]}, orderBy: idASC) {
        edges { node { label } }
      } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Charlie"]);
  });

  it("or combines alternatives", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {or: [{value: {eq: 10}}, {value: {eq: 40}}]}, orderBy: idASC) {
        edges { node { label } }
      } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha", "Echo"]);
  });

  it("3-level nested: or inside and", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {
        and: [
          {or: [{label: {eq: "Alpha"}}, {label: {eq: "bravo"}}]},
          {value: {gte: 20}}
        ]
      }, orderBy: idASC) {
        edges { node { label } }
      } }
    }`});
    validateResult(result);
    // Alpha has value 10 (fails gte: 20), bravo has value 20 (passes)
    expect(labels(resultData(result))).toEqual(["bravo"]);
  });

  it("deeply nested: and inside or inside and", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({schema, source: `{
      models { Probe(where: {
        and: [
          {or: [
            {and: [{label: {eq: "Alpha"}}, {value: {eq: 10}}]},
            {and: [{label: {eq: "Echo"}}, {value: {eq: 40}}]}
          ]}
        ]
      }, orderBy: idASC) {
        edges { node { label } }
      } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha", "Echo"]);
  });
});

// ---------------------------------------------------------------------------
// custom whereOperators (+ whereOperatorTypes)
// ---------------------------------------------------------------------------

describe("custom whereOperators", () => {
  it("custom boolean operator filters rows", async () => {
    const customDef: Definition = {
      ...probeDefinition(),
      name: "Widget",
      options: {tableName: "widgets"},
      whereOperators: {
        highValue(_where, _opts, _val) {
          return {value: {[Op.gte]: 30}};
        },
      },
      whereOperatorTypes: {highValue: GraphQLBoolean},
    };
    const instance = await createInstance([customDef]);
    const {Widget} = instance.models;
    await Widget.create({label: "w1", value: 10, amount: 1.0, flag: true, note: null, meta: null});
    await Widget.create({label: "w2", value: 30, amount: 2.0, flag: false, note: null, meta: null});
    await Widget.create({label: "w3", value: 50, amount: 3.0, flag: true, note: null, meta: null});
    const schema = await createSchema(instance);
    const result = await graphql({schema, source: `{
      models { Widget(where: {highValue: true}, orderBy: idASC) { edges { node { label } } } }
    }`});
    validateResult(result);
    const data = resultData<{models: {Widget: Connection<{label: string}>}}>(result);
    expect(data.models.Widget.edges.map((e) => e.node.label)).toEqual(["w2", "w3"]);
  });
});

// ---------------------------------------------------------------------------
// global IDs in where (PK)
// ---------------------------------------------------------------------------

describe("global IDs in where", () => {
  it("filters by global ID (primary key)", async () => {
    const {schema} = await buildProbeInstance();
    // Get the first Probe's global ID
    const allResult = await graphql({schema, source: `{
      models { Probe(where: {label: {eq: "Alpha"}}) { edges { node { id label } } } }
    }`});
    validateResult(allResult);
    const alphaId = resultData<ProbeIdsResult>(allResult).models.Probe.edges[0].node.id;

    const result = await graphql({schema, source: `{
      models { Probe(where: {id: {eq: "${alphaId}"}}) { edges { node { label } } } }
    }`});
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha"]);
  });
});

// ---------------------------------------------------------------------------
// $variables in where
// ---------------------------------------------------------------------------

describe("$variables in where", () => {
  it("string variable in where", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({
      schema,
      source: `query ($v: String) {
        models { Probe(where: {label: {eq: $v}}, orderBy: idASC) { edges { node { label } } } }
      }`,
      variableValues: {v: "bravo"},
    });
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["bravo"]);
  });

  it("int variable in where", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({
      schema,
      source: `query ($v: Int) {
        models { Probe(where: {value: {gt: $v}}, orderBy: idASC) { edges { node { label } } } }
      }`,
      variableValues: {v: 30},
    });
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Echo"]);
  });

  it("whole where object as variable", async () => {
    const {schema} = await buildProbeInstance();
    const result = await graphql({
      schema,
      source: `query ($w: GQLTQueryProbeWhere) {
        models { Probe(where: $w, orderBy: idASC) { edges { node { label } } } }
      }`,
      variableValues: {w: {value: {lte: 10}}},
    });
    validateResult(result);
    expect(labels(resultData(result))).toEqual(["Alpha"]);
  });
});

// ---------------------------------------------------------------------------
// Postgres-only: regexp family (with enableRegexpOperators)
// ---------------------------------------------------------------------------

if (currentDialect() === "postgres") {
  describe("regexp operators (postgres only, enableRegexpOperators)", () => {
    async function buildRegexpInstance(): Promise<{instance: Instance; schema: GraphQLSchema}> {
      const instance = await createInstance([probeDefinition()]);
      // Enable regexp operators on the adapter
      const adapter = instance.getModelAdapter("Probe") as unknown as {options: {enableRegexpOperators: boolean}};
      adapter.options.enableRegexpOperators = true;
      const {Probe} = instance.models;
      for (let i = 0; i < SEED.length; i++) {
        const row: Record<string, unknown> = {...SEED[i]};
        row.tags = PG_TAGS[i];
        await Probe.create(row);
      }
      const schema = await createSchema(instance);
      return {instance, schema};
    }

    it("regexp matches a pattern", async () => {
      const {schema} = await buildRegexpInstance();
      const result = await graphql({schema, source: `{
        models { Probe(where: {label: {regexp: "^[A-Z]"}}, orderBy: idASC) { edges { node { label } } } }
      }`});
      validateResult(result);
      expect(labels(resultData(result))).toEqual(["Alpha", "Charlie", "Echo"]);
    });

    it("notRegexp excludes matches", async () => {
      const {schema} = await buildRegexpInstance();
      const result = await graphql({schema, source: `{
        models { Probe(where: {label: {notRegexp: "^[A-Z]"}}, orderBy: idASC) { edges { node { label } } } }
      }`});
      validateResult(result);
      expect(labels(resultData(result))).toEqual(["bravo", "delta"]);
    });

    it("iRegexp matches case-insensitively", async () => {
      const {schema} = await buildRegexpInstance();
      const result = await graphql({schema, source: `{
        models { Probe(where: {label: {iRegexp: "^a"}}, orderBy: idASC) { edges { node { label } } } }
      }`});
      validateResult(result);
      expect(labels(resultData(result))).toEqual(["Alpha"]);
    });

    it("notIRegexp excludes case-insensitive match", async () => {
      const {schema} = await buildRegexpInstance();
      const result = await graphql({schema, source: `{
        models { Probe(where: {label: {notIRegexp: "^a"}}, orderBy: idASC) { edges { node { label } } } }
      }`});
      validateResult(result);
      expect(labels(resultData(result))).toEqual(["bravo", "Charlie", "delta", "Echo"]);
    });
  });

  // -------------------------------------------------------------------------
  // Postgres-only: array operators (contains, contained, overlap)
  // -------------------------------------------------------------------------

  describe("array operators (postgres only)", () => {
    it("contains matches arrays that include all target values", async () => {
      const {schema} = await buildProbeInstance();
      // tags: [1,2,3], [2,3], [3,4,5], null, [1,5]
      const result = await graphql({schema, source: `{
        models { Probe(where: {tags: {contains: [1, 2]}}, orderBy: idASC) { edges { node { label } } } }
      }`});
      validateResult(result);
      expect(labels(resultData(result))).toEqual(["Alpha"]);
    });

    it("contained matches arrays that are subsets of the target", async () => {
      const {schema} = await buildProbeInstance();
      const result = await graphql({schema, source: `{
        models { Probe(where: {tags: {contained: [1, 2, 3, 4, 5]}}, orderBy: idASC) { edges { node { label } } } }
      }`});
      validateResult(result);
      // All non-null tag arrays are subsets of [1,2,3,4,5]
      expect(labels(resultData(result))).toEqual(["Alpha", "bravo", "Charlie", "Echo"]);
    });

    it("overlap matches arrays with any shared element", async () => {
      const {schema} = await buildProbeInstance();
      // tags with element 4: [3,4,5]
      const result = await graphql({schema, source: `{
        models { Probe(where: {tags: {overlap: [4]}}, orderBy: idASC) { edges { node { label } } } }
      }`});
      validateResult(result);
      expect(labels(resultData(result))).toEqual(["Charlie"]);
    });
  });
}

// ---------------------------------------------------------------------------
// Postgres-only operators on SQLite: clear error
// ---------------------------------------------------------------------------

if (currentDialect() === "sqlite") {
  describe("postgres-only operators raise clear error on sqlite", () => {
    // These are list-valued operators present in the schema. They sit under a
    // field filter. On SQLite, the adapter raises a dialect error at runtime.
    for (const op of ["contains", "contained", "overlap", "adjacent", "strictLeft", "strictRight", "noExtendRight", "noExtendLeft"]) {
      it(`"${op}" raises a dialect error at runtime`, async () => {
        const {schema} = await buildProbeInstance();
        const result = await graphql({schema, source: `{
          models { Probe(where: {value: {${op}: [1]}}, orderBy: idASC) { edges { node { label } } } }
        }`});
        expect(result.errors).toBeDefined();
        expect(result.errors!.length).toBeGreaterThan(0);
        expect(result.errors![0].message).toContain("requires the postgres dialect");
      });
    }

    // Regex operators are not in the schema by default (enableRegexpOperators
    // is false), so they produce a GraphQL validation error, not our runtime
    // dialect check. This test confirms they are rejected.
    for (const op of ["regexp", "notRegexp", "iRegexp", "notIRegexp"]) {
      it(`"${op}" is rejected (not in schema without enableRegexpOperators)`, async () => {
        const {schema} = await buildProbeInstance();
        const result = await graphql({schema, source: `{
          models { Probe(where: {label: {${op}: "x"}}, orderBy: idASC) { edges { node { label } } } }
        }`});
        expect(result.errors).toBeDefined();
        expect(result.errors!.length).toBeGreaterThan(0);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Schema shape: any/all should NOT be present as combinators
// ---------------------------------------------------------------------------

describe("schema shape: any/all removed from combinators", () => {
  it("the where input type has and/or but not any/all", async () => {
    const {schema} = await buildProbeInstance();
    const whereType = schema.getType("GQLTQueryProbeWhere") as GraphQLInputObjectType;
    const fields = Object.keys(whereType.getFields());
    expect(fields).toContain("and");
    expect(fields).toContain("or");
    expect(fields).not.toContain("any");
    expect(fields).not.toContain("all");
  });
});

// ---------------------------------------------------------------------------
// Schema shape: gt is now available
// ---------------------------------------------------------------------------

describe("schema shape: gt operator available", () => {
  it("each field filter includes gt", async () => {
    const {schema} = await buildProbeInstance();
    const whereType = schema.getType("GQLTQueryProbeWhere") as GraphQLInputObjectType;
    const labelFilter = whereType.getFields().label.type as GraphQLInputObjectType;
    const ops = Object.keys(labelFilter.getFields());
    expect(ops).toContain("gt");
    expect(ops).toContain("gte");
    expect(ops).toContain("lt");
    expect(ops).toContain("lte");
    expect(ops).toContain("eq");
    expect(ops).toContain("ne");
  });
});

// ---------------------------------------------------------------------------
// computed where from an exposed instance method
// ---------------------------------------------------------------------------

describe("computed where from instance method", () => {
  it("filters by a computed field", async () => {
    const PersonModel = (await import("./helper/models/person")).default;
    const {PetModel} = await import("./helper/models/person");
    const personInstance = await createInstance([PersonModel, PetModel]);
    await personInstance.models.Person.create({firstName: "John", lastName: "Smith"});
    await personInstance.models.Person.create({firstName: "Ada", lastName: "Lovelace"});
    const personSchema = await createSchema(personInstance);

    const result = await graphql({schema: personSchema, source: `{
      models { Person(where: {fullName: {eq: "John Smith"}}) { edges { node { fullName } } } }
    }`});
    validateResult(result);
    const data = resultData<{models: {Person: Connection<{fullName: string}>}}>(result);
    expect(data.models.Person.edges.map((e) => e.node.fullName)).toEqual(["John Smith"]);
  });
});
