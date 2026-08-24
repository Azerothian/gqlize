import { describe, it, expect } from "@jest/globals";
import { unknownPermissionKeys } from "@azerothian/utilize";
import type { NestizeOptions } from "../src/types";

/**
 * A regression guard for the compiler, not for the runtime.
 *
 * `isAllowed` treats an absent predicate as ALLOW, so a misspelled key does not
 * fail closed — it silently produces a more permissive API than its author
 * asked for. `Permission` is therefore a closed type: the excess-property check
 * on an object literal is what turns the typo into a compile error. If
 * `Permission` ever regains an index signature the `@ts-expect-error` below
 * stops firing and `tsc -p tsconfig.test.json` fails with TS2578.
 */
describe("nestize - permission typing", () => {
  it("rejects a misspelled permission key at compile time", () => {
    const options: NestizeOptions = {
      permission: {
        // @ts-expect-error - `modle` is not a permission key
        modle: () => true,
      },
    };
    // and at runtime, for JS callers and bags built programmatically
    expect(unknownPermissionKeys(options.permission)).toEqual(["modle"]);
  });
});
