import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it, expect} from "@jest/globals";

import {VERSION} from "../src/version";

describe("VERSION", () => {
  it("matches package.json", () => {
    // The fingerprint folds `VERSION` in as the "which gqlize built this" key.
    // If it drifts, a schema artifact built by an older release loads silently
    // against a newer one — so this is a release gate, not a nicety.
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    expect(VERSION).toEqual(pkg.version);
  });
});
