/**
 * This suite has been split into smaller, focused files:
 *
 *   mutation-crud.test.ts     — basic CRUD operations, hooks, and input checks
 *   mutation-complex.test.ts  — complex object creation, relationship mutations,
 *                               and nested (2-degree) mutations
 *
 * This file is kept so that imports referencing it do not break.
 */
import {it, expect} from "@jest/globals";

it("mutation tests have moved — see mutation-crud.test.ts and mutation-complex.test.ts", () => {
  expect(true).toBe(true);
});
