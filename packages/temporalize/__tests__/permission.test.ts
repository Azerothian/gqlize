import { beforeEach, describe, expect, it } from "@jest/globals";
import { createRoleBasedPermissions } from "@azerothian/utilize";
import type { Permission, PermissionContext, RoleRules } from "@azerothian/utilize";
import type { Ormize } from "@azerothian/ormize";
import { createActivities } from "../src/activities";
import { ErrorType } from "../src/workflow-types";
import type { FindAllResult } from "../src/workflow-types";
import type { ActivityMap } from "../src/types";
import { buildOrm, expectFailure } from "./helper";

/** Plain-JSON row shape for the `Item` fixture model, as it leaves an activity. */
type ItemRow = { id: number; label: string; secret?: string };

/**
 * Role rules exercised below. `defaultDeny: false` keeps everything else open so
 * each test isolates the one denial it cares about.
 */
const RULES: RoleRules = {
  admin: { model: "allow", field: "allow", mutation: "allow" },
  reader: { mutation: "deny" },
  redacted: { field: { Item: { secret: "deny" } } },
  outsider: { model: { Item: "deny" } },
  nocreate: { mutationCreate: { Item: "deny" } },
  nomethods: { mutationClassMethods: { Item: { labelsUpper: "deny" } } },
};

function forRole(role: string) {
  // Memoized per role: `resolvePermission` returning a stable object lets the
  // registry cache the generated Zod schemas by permission identity.
  return createRoleBasedPermissions(role, RULES, { defaultDeny: false });
}

const permissions: { [role: string]: Permission } = {};
const resolvePermission = (context: PermissionContext) =>
  (permissions[context.role] = permissions[context.role] || forRole(context.role));

describe("permission gating", () => {
  let orm: Ormize;
  let acts: ActivityMap;
  const as = (role: string) => ({ userId: "u1", role });

  beforeEach(async () => {
    orm = await buildOrm();
    acts = createActivities(orm, { resolvePermission });
  });

  it("does no gating when resolvePermission is omitted", async () => {
    const ungated = createActivities(orm);
    await expect(
      ungated["Item.create"]({ context: as("outsider"), input: { label: "x" } })
    ).resolves.toHaveLength(1);
  });

  it("hides a denied model behind an unknown-model failure", async () => {
    await expectFailure(acts["Item.findAll"]({ context: as("outsider") }), ErrorType.UnknownModel);
    // Task is untouched by that rule.
    await expect(acts["Task.findAll"]({ context: as("outsider") })).resolves.toMatchObject({ total: 0 });
  });

  it("denies mutations for a read-only role but allows reads", async () => {
    await acts["Item.create"]({ context: as("admin"), input: { label: "alpha" } });
    await expectFailure(
      acts["Item.create"]({ context: as("reader"), input: { label: "beta" } }),
      ErrorType.Forbidden
    );
    await expectFailure(acts["Item.destroy"]({ context: as("reader"), all: true }), ErrorType.Forbidden);
    await expect(acts["Item.count"]({ context: as("reader") })).resolves.toBe(1);
  });

  it("denies a single mutation kind while leaving the others open", async () => {
    await expectFailure(
      acts["Item.create"]({ context: as("nocreate"), input: { label: "alpha" } }),
      ErrorType.Forbidden
    );
    await expect(
      acts["Item.destroy"]({ context: as("nocreate"), all: true })
    ).resolves.toEqual([]);
  });

  it("gates select as a mutation, not a read", async () => {
    await acts["Item.create"]({ context: as("admin"), input: { label: "alpha" } });
    await expectFailure(
      acts["Item.select"]({ context: as("reader"), where: { label: { eq: "alpha" } }, input: {} }),
      ErrorType.Forbidden
    );
  });

  it("strips a denied field from activity results", async () => {
    await acts["Item.create"]({ context: as("admin"), input: { label: "alpha", secret: "s3cret" } });

    const visible = (await acts["Item.findAll"]({ context: as("admin") })) as FindAllResult<ItemRow>;
    expect(visible.rows[0].secret).toBe("s3cret");

    const redacted = (await acts["Item.findAll"]({ context: as("redacted") })) as FindAllResult<ItemRow>;
    expect(redacted.rows[0].label).toBe("alpha");
    expect(redacted.rows[0]).not.toHaveProperty("secret");
  });

  it("refuses to filter or order on a denied field", async () => {
    await acts["Item.create"]({ context: as("admin"), input: { label: "alpha", secret: "s3cret" } });
    // Otherwise the row count leaks the value of a field that never appears in
    // the result — a blind oracle over a denied column.
    await expectFailure(
      acts["Item.findAll"]({ context: as("redacted"), where: { secret: { eq: "s3cret" } } }),
      ErrorType.Forbidden
    );
    await expectFailure(
      acts["Item.findAll"]({ context: as("redacted"), orderBy: [["secret", "ASC"]] }),
      ErrorType.Forbidden
    );
  });

  it("looks inside and/or/not branches of a filter", async () => {
    await expectFailure(
      acts["Item.findAll"]({
        context: as("redacted"),
        where: { and: [{ label: { eq: "alpha" } }, { secret: { eq: "s3cret" } }] },
      }),
      ErrorType.Forbidden
    );
  });

  it("gates class methods", async () => {
    await acts["Item.create"]({ context: as("admin"), input: { label: "alpha" } });
    await expect(acts["Item.classMethods.labelsUpper"]({ context: as("admin") })).resolves.toEqual(["ALPHA"]);
    await expectFailure(
      acts["Item.classMethods.labelsUpper"]({ context: as("nomethods") }),
      ErrorType.Forbidden
    );
  });
});
