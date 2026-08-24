import { describe, it, expect } from "@jest/globals";
import { unknownPermissionKeys } from "@azerothian/utilize";
import type { Permission } from "@azerothian/utilize";
import type { TemporalizeOptions } from "../src/types";

/**
 * A regression guard for the compiler, not for the runtime.
 *
 * `isAllowed` treats an absent predicate as ALLOW, so a misspelled key does not
 * fail closed — it silently lets an activity through for a role that was never
 * granted it. `Permission` is therefore a closed type: the excess-property check
 * on an object literal is what turns the typo into a compile error. Temporalize
 * builds its bag inside `resolvePermission`, so the check has to hold on a
 * returned literal too. If `Permission` ever regains an index signature the
 * `@ts-expect-error` below stops firing and `tsc -p tsconfig.test.json` fails
 * with TS2578.
 */
describe("temporalize - permission typing", () => {
  it("rejects a misspelled permission key at compile time", () => {
    const options: TemporalizeOptions = {
      // The return is annotated so the literal below gets `Permission` as its
      // contextual type directly. Left to inference the mismatch is reported
      // against the whole function, which is a weaker signal.
      resolvePermission: (): Permission => ({
        // @ts-expect-error - `modle` is not a permission key
        modle: () => true,
      }),
    };
    // and at runtime, for JS callers and bags built programmatically
    expect(unknownPermissionKeys(options.resolvePermission!(undefined) as any)).toEqual(["modle"]);
  });
});
