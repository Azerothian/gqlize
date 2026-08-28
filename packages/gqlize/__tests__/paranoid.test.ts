import Sequelize from "sequelize";
import { graphql, printSchema } from "graphql";
import type { GraphQLSchema } from "graphql";
import { Ormize as Database } from "@azerothian/ormize";
import type { Definition, Permission } from "@azerothian/utilize";
import type { ScopePredicate } from "@azerothian/utilize/gate";
import { describe, it, expect, beforeEach } from "@jest/globals";

import { createSchema } from "../src";
import { createAdapterForDialect, registerTeardown } from "./helper/dialect";

/**
 * Soft delete, end to end.
 *
 * The riskiest part of this feature is not the argument, it is that a backend's
 * implicit `deletedAt IS NULL` is applied *per query node* — the root fetch, the
 * count behind `total`, and every eager-loaded join each carry their own. Miss
 * one and the failure is a silently wrong answer, not an error: `total` counting
 * live rows while `edges` return deleted ones. Most of what follows is aimed at
 * that.
 */

const MemoDef: Definition = {
  name: "Memo",
  options: { paranoid: true },
  define: {
    body: { type: Sequelize.STRING, allowNull: false },
    ownerId: { type: Sequelize.STRING, allowNull: true, writable: true },
    parentId: { type: Sequelize.INTEGER, allowNull: true, writable: true },
  },
  relationships: [
    { type: "hasMany", model: "Memo", name: "replies", options: { as: "replies", foreignKey: "parentId" } },
    { type: "belongsTo", model: "Memo", name: "parent", options: { as: "parent", foreignKey: "parentId" } },
  ],
};

/** A hard-deleting neighbour, so "absent because paranoid is off" is testable. */
const LogDef: Definition = {
  name: "Log",
  define: { line: { type: Sequelize.STRING, allowNull: false } },
};

interface Connection<T> {
  total: number;
  edges: { node: T }[];
}
interface MemoNode {
  id: string;
  body: string;
  replies?: Connection<MemoNode>;
}
interface Response {
  errors?: readonly { message: string }[];
  data: { models: { Memo: Connection<MemoNode> & MemoNode[] } };
}

async function build(permission?: Permission, scope?: ScopePredicate) {
  const db = new Database(scope ? { permission: { scope } } : undefined);
  const { adapter, name, teardown } = await createAdapterForDialect();
  registerTeardown(teardown);
  db.registerAdapter(adapter, name);
  await db.addDefinition(MemoDef);
  await db.addDefinition(LogDef);
  await db.initialise();
  await db.sync();
  return { db, schema: await createSchema(db, permission ? { permission } : {}) };
}

const ask = (schema: GraphQLSchema, source: string, context: unknown = {}) =>
  graphql({ schema, source, contextValue: context }) as unknown as Promise<Response>;

/**
 * Fail the seeding itself loudly. A `beforeEach` cannot hold `expect`, and a
 * silently half-seeded table would make every assertion below wrong in a way
 * that reads like a bug in the feature.
 */
function seed(result: Response, expected: number) {
  if (result.errors) {
    throw new Error(`seeding failed: ${JSON.stringify(result.errors)}`);
  }
  const rows = result.data.models.Memo;
  if (rows.length !== expected) {
    throw new Error(`seeding affected ${rows.length} rows, expected ${expected}`);
  }
  return result;
}

describe("gqlize - paranoid (soft delete)", () => {
  describe("the query surface", () => {
    let schema: GraphQLSchema;
    const run = (source: string) => ask(schema, source);

    /**
     * Two roots, each with two replies; the second of each pair is soft deleted.
     * So: 2 live / 2 deleted at the root, and 1 live / 1 deleted per reply set.
     */
    beforeEach(async() => {
      ({ schema } = await build());
      seed(await run(`mutation {
        models { Memo(create: [
          {body: "alpha", replies: {create: [{body: "alpha-1"}, {body: "alpha-2"}]}},
          {body: "beta", replies: {create: [{body: "beta-1"}, {body: "beta-2"}]}}
        ]) { id body } }
      }`), 2);
      seed(await run(`mutation {
        models { Memo(delete: [{body: {in: ["beta", "alpha-2", "beta-2"]}}]) { id } }
      }`), 3);
    });

    const bodies = (r: Response) => r.data.models.Memo.edges.map((e) => e.node.body).sort();

    it("omits soft-deleted rows by default", async() => {
      const result = await run("query { models { Memo { total edges { node { body } } } } }");
      expect(result.errors).toBeUndefined();
      expect(bodies(result)).toEqual(["alpha", "alpha-1", "beta-1"]);
      expect(result.data.models.Memo.total).toEqual(3);
    });

    it("EXCLUDE is the default spelled out", async() => {
      const result = await run("query { models { Memo(deleted: EXCLUDE) { total edges { node { body } } } } }");
      expect(bodies(result)).toEqual(["alpha", "alpha-1", "beta-1"]);
      expect(result.data.models.Memo.total).toEqual(3);
    });

    it("INCLUDE returns live and deleted rows, and counts both", async() => {
      const result = await run("query { models { Memo(deleted: INCLUDE) { total edges { node { body } } } } }");
      expect(result.errors).toBeUndefined();
      expect(bodies(result)).toEqual(["alpha", "alpha-1", "alpha-2", "beta", "beta-1", "beta-2"]);
      // The count is a separate query (or a window function) from the fetch —
      // this is the assertion that says the flag reached both.
      expect(result.data.models.Memo.total).toEqual(6);
    });

    it("ONLY returns just the deleted rows, and counts just those", async() => {
      const result = await run("query { models { Memo(deleted: ONLY) { total edges { node { body } } } } }");
      expect(result.errors).toBeUndefined();
      expect(bodies(result)).toEqual(["alpha-2", "beta", "beta-2"]);
      expect(result.data.models.Memo.total).toEqual(3);
    });

    it("counts the root correctly when only `total` is selected", async() => {
      // No `edges` means no fetch at all — `total` comes from a count bag built
      // separately, which has its own chance to lose the flag.
      const inc = await run("query { models { Memo(deleted: INCLUDE) { total } } }");
      expect(inc.errors).toBeUndefined();
      expect(inc.data.models.Memo.total).toEqual(6);
      const only = await run("query { models { Memo(deleted: ONLY) { total } } }");
      expect(only.data.models.Memo.total).toEqual(3);
      const live = await run("query { models { Memo { total } } }");
      expect(live.data.models.Memo.total).toEqual(3);
    });

    it("applies `deleted` per node: a nested connection keeps its own", async() => {
      // The parent asks for deleted rows, the child does not — so `alpha`'s
      // replies stay live-only even though the root is INCLUDE. This is the
      // whole reason the flag is set per include entry rather than once.
      const result = await run(`query { models { Memo(deleted: INCLUDE, where: {parentId: {eq: null}}) {
        edges { node { body replies { total edges { node { body } } } } }
      } } }`);
      expect(result.errors).toBeUndefined();
      const alpha = result.data.models.Memo.edges.find((e) => e.node.body === "alpha")!;
      expect(alpha.node.replies!.edges.map((e) => e.node.body)).toEqual(["alpha-1"]);
      expect(alpha.node.replies!.total).toEqual(1);
    });

    it("a nested connection's total agrees with its edges under INCLUDE", async() => {
      const result = await run(`query { models { Memo(where: {body: {eq: "alpha"}}) {
        edges { node { body replies(deleted: INCLUDE) { total edges { node { body } } } } }
      } } }`);
      expect(result.errors).toBeUndefined();
      const [alpha] = result.data.models.Memo.edges;
      expect(alpha.node.replies!.edges.map((e) => e.node.body).sort()).toEqual(["alpha-1", "alpha-2"]);
      expect(alpha.node.replies!.total).toEqual(2);
    });

    it("a nested connection's total agrees with its edges under ONLY", async() => {
      const result = await run(`query { models { Memo(where: {body: {eq: "alpha"}}) {
        edges { node { replies(deleted: ONLY) { total edges { node { body } } } } }
      } } }`);
      expect(result.errors).toBeUndefined();
      const [alpha] = result.data.models.Memo.edges;
      expect(alpha.node.replies!.edges.map((e) => e.node.body)).toEqual(["alpha-2"]);
      expect(alpha.node.replies!.total).toEqual(1);
    });

    it("counts a nested connection correctly when only `total` is selected", async() => {
      // No `edges` — the resolver runs a count instead of a fetch, through a
      // hand-built options bag that the overlay has to reach separately.
      const result = await run(`query { models { Memo(where: {body: {eq: "alpha"}}) {
        edges { node { replies(deleted: INCLUDE) { total } } }
      } } }`);
      expect(result.errors).toBeUndefined();
      expect(result.data.models.Memo.edges[0].node.replies!.total).toEqual(2);
    });

    it("honours `deleted` on an explicit include, and on a separate one", async() => {
      const result = await run(`query { models { Memo(
        where: {body: {eq: "alpha"}},
        include: [{replies: {deleted: INCLUDE, separate: true}}]
      ) { edges { node { replies { total edges { node { body } } } } } } } }`);
      expect(result.errors).toBeUndefined();
      const [alpha] = result.data.models.Memo.edges;
      expect(alpha.node.replies!.edges.map((e) => e.node.body).sort()).toEqual(["alpha-1", "alpha-2"]);
    });

    it("paginates a separate nested connection over deleted rows", async() => {
      const result = await run(`query { models { Memo(where: {body: {eq: "alpha"}}) {
        edges { node { replies(deleted: INCLUDE, first: 1, orderBy: [bodyASC]) { total edges { node { body } } } } }
      } } }`);
      expect(result.errors).toBeUndefined();
      const [alpha] = result.data.models.Memo.edges;
      expect(alpha.node.replies!.edges.map((e) => e.node.body)).toEqual(["alpha-1"]);
      // Per-parent pagination bounds the page, not the count.
      expect(alpha.node.replies!.total).toEqual(2);
    });
  });

  describe("the schema surface", () => {
    it("emits `deleted` and `restore` only for a model that soft deletes", async() => {
      const { schema } = await build();
      const sdl = printSchema(schema);
      expect(sdl).toContain("deleted: GQLTDeletedFilter");
      // `Log` is not paranoid: neither the argument nor the mutation exists for
      // it, because there would be no deleted row for either to name.
      expect(sdl).not.toMatch(/Log\([^)]*deleted:/);
      expect(sdl).not.toMatch(/This will restore soft-deleted elements for Log/);
      expect(sdl).toContain("This will restore soft-deleted elements for Memo");
    });

    it("omits `deleted` when queryDeleted denies it, so a query naming it fails validation", async() => {
      const { schema } = await build({ queryDeleted: () => false });
      expect(printSchema(schema)).not.toContain("deleted: GQLTDeletedFilter");
      const result = await ask(schema, "query { models { Memo(deleted: INCLUDE) { total } } }");
      expect(result.errors?.[0].message).toMatch(/Unknown argument "deleted"/);
    });

    it("omits `restore` when mutationRestore denies it", async() => {
      const { schema } = await build({ mutationRestore: () => false });
      const sdl = printSchema(schema);
      expect(sdl).not.toContain("This will restore soft-deleted elements for Memo");
      // The `deleted` argument is a separate gate and is untouched by this one.
      expect(sdl).toContain("deleted: GQLTDeletedFilter");
    });
  });

  describe("restore", () => {
    it("round-trips delete then restore", async() => {
      const { schema } = await build();
      const run = (source: string) => ask(schema, source);
      await run(`mutation { models { Memo(create: {body: "alpha"}) { id } } }`);
      await run(`mutation { models { Memo(delete: [{body: {eq: "alpha"}}]) { id } } }`);

      const gone = await run("query { models { Memo { total } } }");
      expect(gone.data.models.Memo.total).toEqual(0);

      const restored = await run(`mutation { models { Memo(restore: [{body: {eq: "alpha"}}]) { body } } }`);
      expect(restored.errors).toBeUndefined();
      expect(restored.data.models.Memo.map((m) => m.body)).toEqual(["alpha"]);

      const back = await run("query { models { Memo { total edges { node { body } } } } }");
      expect(back.data.models.Memo.total).toEqual(1);
      expect(back.data.models.Memo.edges[0].node.body).toEqual("alpha");
    });

    it("is a no-op on a row that was never deleted", async() => {
      const { schema } = await build();
      const run = (source: string) => ask(schema, source);
      await run(`mutation { models { Memo(create: {body: "alpha"}) { id } } }`);
      const result = await run(`mutation { models { Memo(restore: [{body: {eq: "alpha"}}]) { body } } }`);
      expect(result.errors).toBeUndefined();
      expect(result.data.models.Memo).toEqual([]);
    });
  });

  describe("row-level scope", () => {
    const owned: ScopePredicate = (_defName, _operation, _options, context) => {
      const id = (context as { user?: string } | undefined)?.user;
      return { where: { ownerId: { eq: id } }, set: { ownerId: id } };
    };

    it("still filters deleted rows the caller may not see", async() => {
      const { schema } = await build(undefined, owned);
      const run = (source: string, user: string) => ask(schema, source, { user });
      await run(`mutation { models { Memo(create: {body: "ours"}) { id } } }`, "u1");
      await run(`mutation { models { Memo(create: {body: "theirs"}) { id } } }`, "u2");
      await run(`mutation { models { Memo(delete: [{body: {eq: "ours"}}]) { id } } }`, "u1");
      await run(`mutation { models { Memo(delete: [{body: {eq: "theirs"}}]) { id } } }`, "u2");

      // Seeing deleted rows is not the same permission as seeing other people's.
      const result = await run("query { models { Memo(deleted: INCLUDE) { total edges { node { body } } } } }", "u1");
      expect(result.errors).toBeUndefined();
      expect(result.data.models.Memo.edges.map((e) => e.node.body)).toEqual(["ours"]);
      expect(result.data.models.Memo.total).toEqual(1);
    });

    it("refuses to restore a row outside the caller's scope", async() => {
      const { schema } = await build(undefined, owned);
      const run = (source: string, user: string) => ask(schema, source, { user });
      await run(`mutation { models { Memo(create: {body: "theirs"}) { id } } }`, "u2");
      await run(`mutation { models { Memo(delete: [{body: {eq: "theirs"}}]) { id } } }`, "u2");

      const result = await run(`mutation { models { Memo(restore: [{body: {eq: "theirs"}}]) { body } } }`, "u1");
      expect(result.data.models.Memo).toEqual([]);
      const still = await run("query { models { Memo(deleted: ONLY) { total edges { node { body } } } } }", "u2");
      expect(still.data.models.Memo.total).toEqual(1);
    });
  });
});
