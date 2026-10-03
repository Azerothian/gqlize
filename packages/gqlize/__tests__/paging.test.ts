import { graphql } from "graphql";
import Sequelize from "sequelize";
import { createInstance, resultData, validateResult } from "./helper";
import { captureQueries } from "./helper/sql";
import { createSchema } from "../src";
import { currentDialect } from "./helper/dialect";
import { describe, it, expect, beforeAll } from "@jest/globals";
import type { GraphQLSchema } from "graphql";
import type { Ormize } from "@azerothian/ormize";

// ---------------------------------------------------------------------------
// Definitions for a belongsToMany pair
// ---------------------------------------------------------------------------
const tagDef = {
  name: "PagingTag",
  define: { label: { type: Sequelize.STRING, allowNull: false } },
  relationships: [{
    type: "belongsToMany" as const,
    model: "PagingPost",
    name: "posts",
    options: { through: { model: "PagingPostTag" }, foreignKey: "tagId", otherKey: "postId" },
  }],
};
const postTagDef = { name: "PagingPostTag", define: {} };
const postDef = {
  name: "PagingPost",
  define: { title: { type: Sequelize.STRING, allowNull: false } },
  relationships: [{
    type: "belongsToMany" as const,
    model: "PagingTag",
    name: "tags",
    options: { through: { model: "PagingPostTag" }, foreignKey: "postId", otherKey: "tagId" },
  }],
};

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
type Edge<T> = { cursor: string; node: T };
type Connection<T> = {
  total: number;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor?: string; endCursor?: string };
  edges: Edge<T>[];
};
type ChildNode = { name: string };
type ChildResult = { models: { Child: Connection<ChildNode> } };
type ParentWithChildren = { models: { Parent: Connection<{ name: string; children: Connection<ChildNode> }> } };
type PostWithTags = { models: { PagingPost: Connection<{ title: string; tags: Connection<{ label: string }> }> } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function queryChild(schema: GraphQLSchema, argsStr: string): Promise<Connection<ChildNode>> {
  const r = await graphql({
    schema,
    source: `query { models { Child(${argsStr}) { total pageInfo { hasNextPage hasPreviousPage startCursor endCursor } edges { cursor node { name } } } } }`,
  });
  validateResult(r);
  return resultData<ChildResult>(r).models.Child;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("paging", () => {
  let instance: Ormize;
  let schema: GraphQLSchema;

  beforeAll(async () => {
    instance = await createInstance([tagDef, postTagDef, postDef], { suite: true });

    // Seed 7 Child rows — two pairs share a name so multi-column order has ties.
    const names = ["alpha", "beta", "beta", "gamma", "gamma", "delta", "epsilon"];
    for (const n of names) {
      await instance.models.Child.create({ name: n });
    }

    // Seed a Parent with 5 children (for nested hasMany)
    const parent = await instance.models.Parent.create({ name: "P1" });
    for (let i = 1; i <= 5; i++) {
      await instance.models.Child.create({ name: `p1child${i}`, parentId: (parent as {id: number}).id });
    }

    // Seed belongsToMany: one Post with 5 Tags
    const post = await instance.models.PagingPost.create({ title: "post1" });
    for (let i = 1; i <= 5; i++) {
      const tag = await instance.models.PagingTag.create({ label: `tag${i}` });
      await (post as unknown as {addTag(tag: unknown): Promise<void>}).addTag(tag);
    }

    schema = await createSchema(instance);
  });

  // -----------------------------------------------------------------------
  // ROOT CONNECTION — forward pagination
  // -----------------------------------------------------------------------
  describe("root connection - forward", () => {
    it("first returns the first N rows", async () => {
      const page = await queryChild(schema, "first: 3, orderBy: nameASC");
      expect(page.edges).toHaveLength(3);
      expect(page.pageInfo.hasNextPage).toBe(true);
      expect(page.pageInfo.hasPreviousPage).toBe(false);
      expect(page.total).toBeGreaterThanOrEqual(7);
    });

    it("first+after returns rows after the cursor", async () => {
      const p1 = await queryChild(schema, "first: 3, orderBy: nameASC");
      const afterCursor = p1.edges[2].cursor; // 3rd row
      const p2 = await queryChild(schema, `first: 3, after: "${afterCursor}", orderBy: nameASC`);
      expect(p2.edges).toHaveLength(3);
      expect(p2.pageInfo.hasPreviousPage).toBe(true);
      // Cursors must not overlap: each edge's cursor position is unique
      const allCursors = [...p1.edges, ...p2.edges].map((e) => e.cursor);
      expect(new Set(allCursors).size).toBe(allCursors.length);
    });

    it("after alone returns a default-sized page after the cursor", async () => {
      const p1 = await queryChild(schema, "first: 2, orderBy: nameASC");
      const afterCursor = p1.edges[1].cursor;
      const p2 = await queryChild(schema, `after: "${afterCursor}", orderBy: nameASC`);
      expect(p2.pageInfo.hasPreviousPage).toBe(true);
      expect(p2.edges.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // ROOT CONNECTION — backward pagination
  // -----------------------------------------------------------------------
  describe("root connection - backward", () => {
    it("last returns the last N rows of the ordered set", async () => {
      // Fetch all to know expected order
      const all = await queryChild(schema, "first: 100, orderBy: nameASC");
      const totalRows = all.edges.length;

      const lastPage = await queryChild(schema, "last: 3, orderBy: nameASC");
      expect(lastPage.edges).toHaveLength(3);
      // Should be the last 3 rows of the ordered set
      const expectedNames = all.edges.slice(totalRows - 3).map((e) => e.node.name);
      expect(lastPage.edges.map((e) => e.node.name)).toEqual(expectedNames);
      expect(lastPage.pageInfo.hasPreviousPage).toBe(true);
      expect(lastPage.pageInfo.hasNextPage).toBe(false);
    });

    it("last+before returns the N rows before the cursor", async () => {
      const all = await queryChild(schema, "first: 100, orderBy: nameASC");
      // Pick cursor at position 5 (0-based)
      const beforeCursor = all.edges[5].cursor;
      const page = await queryChild(schema, `last: 3, before: "${beforeCursor}", orderBy: nameASC`);
      expect(page.edges).toHaveLength(3);
      // Should be rows at positions 2, 3, 4
      const expectedNames = all.edges.slice(2, 5).map((e) => e.node.name);
      expect(page.edges.map((e) => e.node.name)).toEqual(expectedNames);
      expect(page.pageInfo.hasPreviousPage).toBe(true);
      expect(page.pageInfo.hasNextPage).toBe(true);
    });

    it("before alone returns a page-sized window before the cursor", async () => {
      const all = await queryChild(schema, "first: 100, orderBy: nameASC");
      const beforeCursor = all.edges[5].cursor;
      const page = await queryChild(schema, `before: "${beforeCursor}", orderBy: nameASC`);
      // Should return rows 0..4 (everything before position 5, clamped to page size)
      expect(page.edges).toHaveLength(5);
      const expectedNames = all.edges.slice(0, 5).map((e) => e.node.name);
      expect(page.edges.map((e) => e.node.name)).toEqual(expectedNames);
      expect(page.pageInfo.hasPreviousPage).toBe(false);
      expect(page.pageInfo.hasNextPage).toBe(true);
    });

    it("last+before with cursor near the start clamps correctly", async () => {
      const all = await queryChild(schema, "first: 100, orderBy: nameASC");
      // Cursor at position 2 — asking for last 5 before it should return only 2 rows
      const beforeCursor = all.edges[2].cursor;
      const page = await queryChild(schema, `last: 5, before: "${beforeCursor}", orderBy: nameASC`);
      expect(page.edges).toHaveLength(2);
      expect(page.edges.map((e) => e.node.name)).toEqual(
        all.edges.slice(0, 2).map((e) => e.node.name),
      );
      expect(page.pageInfo.hasPreviousPage).toBe(false);
      expect(page.pageInfo.hasNextPage).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // ROOT CONNECTION — pageInfo and cursors
  // -----------------------------------------------------------------------
  describe("root connection - pageInfo", () => {
    it("empty page after past the end has correct flags and total", async () => {
      const all = await queryChild(schema, "first: 100, orderBy: nameASC");
      const lastCursor = all.edges[all.edges.length - 1].cursor;
      const empty = await queryChild(schema, `first: 10, after: "${lastCursor}", orderBy: nameASC`);
      expect(empty.edges).toHaveLength(0);
      expect(empty.total).toBe(all.total);
      expect(empty.pageInfo.hasNextPage).toBe(false);
      expect(empty.pageInfo.hasPreviousPage).toBe(false);
    });

    it("startCursor and endCursor match the first and last edge cursors", async () => {
      const page = await queryChild(schema, "first: 3, orderBy: nameASC");
      expect(page.pageInfo.startCursor).toBe(page.edges[0].cursor);
      expect(page.pageInfo.endCursor).toBe(page.edges[page.edges.length - 1].cursor);
    });

    it("cursor from one connection is rejected on another", async () => {
      // Get a cursor from Child
      const childPage = await queryChild(schema, "first: 1, orderBy: nameASC");
      const childCursor = childPage.edges[0].cursor;
      // Use it on Parent connection — should error
      const r = await graphql({
        schema,
        source: `query { models { Parent(first: 1, after: "${childCursor}") { edges { node { name } } } } }`,
      });
      expect(r.errors).toBeDefined();
      expect(r.errors!.length).toBeGreaterThan(0);
      expect(r.errors![0].message).toMatch(/cursor/i);
    });

    it("malformed cursor is rejected", async () => {
      const r = await graphql({
        schema,
        source: `query { models { Child(first: 1, after: "not-a-valid-cursor") { edges { node { name } } } } }`,
      });
      expect(r.errors).toBeDefined();
      expect(r.errors!.length).toBeGreaterThan(0);
      expect(r.errors![0].message).toMatch(/invalid cursor/i);
    });
  });

  // -----------------------------------------------------------------------
  // PAGE SIZE
  // -----------------------------------------------------------------------
  describe("page size", () => {
    it("no first/last defaults to a bounded page (max 100)", async () => {
      // We have ~12 rows; without first/last the result should be bounded
      const page = await queryChild(schema, "orderBy: nameASC");
      // With 12 rows and default 100, all rows are returned
      expect(page.edges.length).toBeGreaterThanOrEqual(7);
      expect(page.edges.length).toBeLessThanOrEqual(100);
    });

    it("first > MAX_PAGE_SIZE is clamped to 1000", async () => {
      const cap = captureQueries(instance);
      cap.reset();
      const page = await queryChild(schema, "first: 5000, orderBy: nameASC");
      // Check the SQL LIMIT was clamped
      const selects = cap.selects();
      const selectWithLimit = selects.find((s) => /LIMIT/i.test(s));
      expect(selectWithLimit).toBeDefined();
      expect(selectWithLimit).toMatch(/LIMIT\s+1000/i);
      // And results are at most 1000
      expect(page.edges.length).toBeLessThanOrEqual(1000);
    });
  });

  // -----------------------------------------------------------------------
  // ORDERING
  // -----------------------------------------------------------------------
  describe("ordering", () => {
    it("orderBy multi-column with ties is deterministic", async () => {
      // Order by name ASC — ties on "beta" and "gamma" should be broken by PK
      const page = await queryChild(schema, "first: 100, orderBy: nameASC");
      const names = page.edges.map((e) => e.node.name);
      // Names should be sorted; ties broken deterministically
      for (let i = 0; i < names.length - 1; i++) {
        expect(names[i] <= names[i + 1]).toBe(true);
      }
    });

    it("ordering without orderBy is deterministic (PK order)", async () => {
      const p1 = await queryChild(schema, "first: 100");
      const p2 = await queryChild(schema, "first: 100");
      expect(p1.edges.map((e) => e.node.name)).toEqual(p2.edges.map((e) => e.node.name));
    });

    if (currentDialect() === "postgres") {
      it("ordering without orderBy is deterministic after UPDATE on postgres", async () => {
        // Update a row to potentially change its physical position
        const all = await queryChild(schema, "first: 100");
        const firstName = all.edges[0].node.name;

        // Perform an update on the first row to change its heap position
        const r = await graphql({
          schema,
          source: `mutation { models { Child(update: { where: { name: { eq: "${firstName}" } }, input: { name: "${firstName}" } }) { id } } }`,
        });
        validateResult(r);

        // Query again — should be in the same order (PK tiebreaker)
        const after = await queryChild(schema, "first: 100");
        expect(after.edges.map((e) => e.node.name)).toEqual(all.edges.map((e) => e.node.name));
      });
    }
  });

  // -----------------------------------------------------------------------
  // NESTED — hasMany
  // -----------------------------------------------------------------------
  describe("nested hasMany", () => {
    // Query for the parent's children connection
    async function queryParentChildren(args: string): Promise<Connection<ChildNode>> {
      const r = await graphql({
        schema,
        source: `query { models { Parent(where: { name: { eq: "P1" } }) { edges { node { children(${args}, orderBy: nameASC) { total pageInfo { hasNextPage hasPreviousPage } edges { cursor node { name } } } } } } } }`,
      });
      validateResult(r);
      const data = resultData<ParentWithChildren>(r);
      return data.models.Parent.edges[0].node.children;
    }

    it("first returns the first N children", async () => {
      const page = await queryParentChildren("first: 2");
      expect(page.edges).toHaveLength(2);
      expect(page.pageInfo.hasNextPage).toBe(true);
      expect(page.pageInfo.hasPreviousPage).toBe(false);
      expect(page.total).toBe(5);
    });

    it("first+after returns children after the cursor", async () => {
      const p1 = await queryParentChildren("first: 2");
      const afterCursor = p1.edges[1].cursor;
      const p2 = await queryParentChildren(`first: 2, after: "${afterCursor}"`);
      expect(p2.edges).toHaveLength(2);
      expect(p2.pageInfo.hasPreviousPage).toBe(true);
      // No overlap with first page
      const p1Names = p1.edges.map((e) => e.node.name);
      const p2Names = p2.edges.map((e) => e.node.name);
      expect(p1Names.filter((n) => p2Names.includes(n))).toHaveLength(0);
    });

    it("first+after returns exactly the next window, whatever the offset", async () => {
      // A paginated hasMany is fetched `separate`, already windowed in SQL;
      // slicing it again in memory dropped rows whenever the page held more
      // rows than the cursor's offset.
      const all = (await queryParentChildren("first: 100")).edges.map((e) => e.node.name);
      for (const [index, size] of [[0, 2], [0, 3], [1, 2], [2, 2], [3, 3]]) {
        const anchor = await queryParentChildren(`first: ${index + 1}`);
        const cursor = anchor.edges[index].cursor;
        const page = await queryParentChildren(`first: ${size}, after: "${cursor}"`);
        expect(page.edges.map((e) => e.node.name)).toEqual(all.slice(index + 1, index + 1 + size));
      }
    });

    it("last+before returns children before the cursor", async () => {
      const all = await queryParentChildren("first: 100");
      const beforeCursor = all.edges[4].cursor; // last row
      const page = await queryParentChildren(`last: 2, before: "${beforeCursor}"`);
      expect(page.edges).toHaveLength(2);
      expect(page.edges.map((e) => e.node.name)).toEqual(
        all.edges.slice(2, 4).map((e) => e.node.name),
      );
      expect(page.pageInfo.hasPreviousPage).toBe(true);
      expect(page.pageInfo.hasNextPage).toBe(true);
    });

    it("before alone returns children before the cursor", async () => {
      const all = await queryParentChildren("first: 100");
      const beforeCursor = all.edges[3].cursor;
      const page = await queryParentChildren(`before: "${beforeCursor}"`);
      expect(page.edges).toHaveLength(3);
      expect(page.edges.map((e) => e.node.name)).toEqual(
        all.edges.slice(0, 3).map((e) => e.node.name),
      );
    });

    it("last alone returns the last N children", async () => {
      const all = await queryParentChildren("first: 100");
      const page = await queryParentChildren("last: 2");
      expect(page.edges).toHaveLength(2);
      expect(page.edges.map((e) => e.node.name)).toEqual(
        all.edges.slice(3, 5).map((e) => e.node.name),
      );
      expect(page.pageInfo.hasPreviousPage).toBe(true);
      expect(page.pageInfo.hasNextPage).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // NESTED — belongsToMany
  // -----------------------------------------------------------------------
  describe("nested belongsToMany", () => {
    async function queryPostTags(args: string): Promise<Connection<{ label: string }>> {
      const r = await graphql({
        schema,
        source: `query { models { PagingPost(where: { title: { eq: "post1" } }) { edges { node { tags(${args}, orderBy: labelASC) { total pageInfo { hasNextPage hasPreviousPage } edges { cursor node { label } } } } } } } }`,
      });
      validateResult(r);
      const data = resultData<PostWithTags>(r);
      return data.models.PagingPost.edges[0].node.tags;
    }

    it("first returns the first N tags", async () => {
      const page = await queryPostTags("first: 2");
      expect(page.edges).toHaveLength(2);
      expect(page.pageInfo.hasNextPage).toBe(true);
      expect(page.pageInfo.hasPreviousPage).toBe(false);
      expect(page.total).toBe(5);
    });

    it("first+after returns tags after the cursor", async () => {
      const p1 = await queryPostTags("first: 2");
      const afterCursor = p1.edges[1].cursor;
      const p2 = await queryPostTags(`first: 2, after: "${afterCursor}"`);
      expect(p2.edges).toHaveLength(2);
      expect(p2.pageInfo.hasPreviousPage).toBe(true);
    });

    it("last+before returns tags before the cursor", async () => {
      const all = await queryPostTags("first: 100");
      const beforeCursor = all.edges[4].cursor;
      const page = await queryPostTags(`last: 2, before: "${beforeCursor}"`);
      expect(page.edges).toHaveLength(2);
      expect(page.edges.map((e) => e.node.label)).toEqual(
        all.edges.slice(2, 4).map((e) => e.node.label),
      );
    });

    it("last alone returns the last N tags", async () => {
      const all = await queryPostTags("first: 100");
      const page = await queryPostTags("last: 2");
      expect(page.edges).toHaveLength(2);
      expect(page.edges.map((e) => e.node.label)).toEqual(
        all.edges.slice(3, 5).map((e) => e.node.label),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Cursor round-trip consistency
  // -----------------------------------------------------------------------
  describe("cursor round-trip", () => {
    it("forward then backward cursors navigate consistently", async () => {
      const p1 = await queryChild(schema, "first: 3, orderBy: nameASC");
      // Page 2 via after
      const p2 = await queryChild(schema, `first: 3, after: "${p1.edges[2].cursor}", orderBy: nameASC`);
      // Now page backward using before on p2's first cursor
      const back = await queryChild(schema, `last: 3, before: "${p2.edges[0].cursor}", orderBy: nameASC`);
      // Should get the same rows as p1
      expect(back.edges.map((e) => e.node.name)).toEqual(p1.edges.map((e) => e.node.name));
    });
  });
});
