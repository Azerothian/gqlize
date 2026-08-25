import { graphql } from "graphql";
import { createInstance, resultData, validateResult } from "./helper";
import { createSchema } from "../src";
import { describe, it, expect } from "@jest/globals";

// Relay pageInfo was previously derived from `first`/`last` + the cursor index,
// which mis-reported hasPreviousPage for a window starting between 1 and `count`
// (and used an unsound forward/backward flag swap). The flags are now derived
// from the returned window's absolute position, so they are exact.
type ChildPageResult = {
  models: {
    Child: {
      total: number;
      pageInfo: {hasNextPage: boolean; hasPreviousPage: boolean};
      edges: {cursor: string; node: {name: string}}[];
    };
  };
};

describe("pageInfo - forward pagination", () => {
  it("reports hasNextPage/hasPreviousPage from the window position", async () => {
    const instance = await createInstance();
    for (let i = 1; i <= 5; i++) {
      await instance.models.Child.create({ name: `c${i}` });
    }
    const schema = await createSchema(instance);
    const page = async (args: string) => {
      const r = await graphql({
        schema,
        source: `query { models { Child(${args}, orderBy: nameASC) { total pageInfo { hasNextPage hasPreviousPage } edges { cursor node { name } } } } }`,
      });
      validateResult(r);
      return resultData<ChildPageResult>(r).models.Child;
    };

    const p1 = await page("first: 2");
    expect(p1.edges.map((e) => e.node.name)).toEqual(["c1", "c2"]);
    expect(p1.pageInfo).toEqual({ hasNextPage: true, hasPreviousPage: false });

    // Regression: a window starting between 1 and `count` must report a previous page.
    const afterFirst = await page(`first: 2, after: "${p1.edges[0].cursor}"`);
    expect(afterFirst.edges.map((e) => e.node.name)).toEqual(["c2", "c3"]);
    expect(afterFirst.pageInfo).toEqual({ hasNextPage: true, hasPreviousPage: true });

    // Final (partial) page.
    const fourth = (await page("first: 4")).edges[3].cursor;
    const lastPage = await page(`first: 2, after: "${fourth}"`);
    expect(lastPage.edges.map((e) => e.node.name)).toEqual(["c5"]);
    expect(lastPage.pageInfo).toEqual({ hasNextPage: false, hasPreviousPage: true });

    // Whole set in one page.
    const all = await page("first: 10");
    expect(all.pageInfo).toEqual({ hasNextPage: false, hasPreviousPage: false });
  });
});
