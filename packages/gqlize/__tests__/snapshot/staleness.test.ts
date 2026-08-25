import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import {isObjectType, printSchema} from "graphql";
import Sequelize from "sequelize";
import SequelizeAdapter from "@azerothian/ormize-adapter-sequelize";
import {Ormize} from "@azerothian/ormize";
import {describe, it, expect, beforeAll, afterAll, jest} from "@jest/globals";

import {createSchema} from "../../src";
import {loadSchema, materializeSchema, readSnapshot, snapshotSchema} from "../../src/snapshot";
import type {Definition, GqlizeOptions} from "../../src/types";
import type {SnapshotOptions} from "../../src/graphql/snapshot/snapshot";

/**
 * The loader's staleness behaviour end to end: build an artifact against one set
 * of definitions, then load it against a different set and check that each
 * `onMismatch` mode does what it advertises.
 */

function defs(extra = false): Definition[] {
  return [
    {
      name: "Parent",
      define: {name: {type: Sequelize.STRING, allowNull: false}},
      relationships: [{
        type: "hasMany", model: "Child", name: "children",
        options: {as: "children", foreignKey: "parentId"},
      }],
    },
    {
      name: "Child",
      define: {
        name: {type: Sequelize.STRING, allowNull: true},
        ...(extra ? {extra: {type: Sequelize.STRING, allowNull: true}} : {}),
      },
      relationships: [{
        type: "belongsTo", model: "Parent", name: "parent",
        options: {foreignKey: "parentId"},
      }],
    },
  ];
}

async function orm(extra = false) {
  const db = new Ormize();
  db.registerAdapter(new SequelizeAdapter({}, {dialect: "sqlite", logging: false}), "db");
  for (const def of defs(extra)) {
    await db.addDefinition(def);
  }
  await db.initialise();
  return db;
}

/** artifact from the base definitions, through JSON as it would be on disk */
async function artifactFor(db: Ormize, opts: SnapshotOptions & {options?: GqlizeOptions} = {}) {
  return JSON.parse(JSON.stringify(snapshotSchema(await createSchema(db, opts.options), opts)));
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gqlize-artifact-"));
});
afterAll(() => {
  rmSync(dir, {recursive: true, force: true});
});

describe("artifact fingerprint", () => {
  it("is recorded without the caller passing the orm back in", async() => {
    // `createSchema` remembers which instance built the schema, so the documented
    // one-liner `snapshotSchema(schema)` still produces a checkable artifact.
    const artifact = await artifactFor(await orm());
    expect(artifact.fingerprint).toMatchObject({
      formatVersion: 1,
      gqlizeVersion: expect.any(String),
      graphqlVersion: expect.any(String),
      permissionProfile: null,
    });
  });

  it("carries the permissionProfile it was built with", async() => {
    const artifact = await artifactFor(await orm(), {permissionProfile: "admin"});
    expect(artifact.fingerprint.permissionProfile).toEqual("admin");
  });

  it("can be omitted deliberately with `orm: false`", async() => {
    const schema = await createSchema(await orm());
    expect(snapshotSchema(schema, {orm: false}).fingerprint).toBeUndefined();
  });
});

describe("materializeSchema staleness", () => {
  it("loads cleanly against the definitions it was built from", async() => {
    const db = await orm();
    const artifact = await artifactFor(db);
    const rebuilt = await materializeSchema(artifact, db);
    expect(printSchema(rebuilt)).toEqual(printSchema(await createSchema(db)));
  });

  it("throws by default when a model has changed", async() => {
    const artifact = await artifactFor(await orm());
    await expect(materializeSchema(artifact, await orm(true)))
      .rejects.toThrow(/artifact is stale — models differs/);
  });

  it("names the permissionProfile in the message when that is what moved", async() => {
    const artifact = await artifactFor(await orm(), {permissionProfile: "admin"});
    await expect(materializeSchema(artifact, await orm(), {permissionProfile: "public"}))
      .rejects.toThrow(/pass the `permissionProfile` the artifact was built with/);
  });

  it("reports the differing values, not just the key", async() => {
    const artifact = await artifactFor(await orm(), {permissionProfile: "admin"});
    await expect(materializeSchema(artifact, await orm(), {permissionProfile: "public"}))
      .rejects.toThrow(/permissionProfile \(artifact "admin", live "public"\)/);
  });

  it("carries the artifact's permissionProfile forward when the loader names none", async() => {
    // The loading process builds its own options object and is not claiming the
    // profile changed by staying silent about it. Comparing against `null` here
    // made every CLI-built artifact report drift on its first load.
    const db = await orm();
    const artifact = await artifactFor(db, {permissionProfile: "admin"});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(materializeSchema(artifact, db)).resolves.toBeDefined();
      expect(warn.mock.calls.flat().join(" ")).toMatch(/permissionProfile/);
    } finally {
      warn.mockRestore();
    }
  });

  it("loads clean against an independently constructed options object", async() => {
    // Nothing here is shared with the build: fresh closures, a different set of
    // permission predicates, no profile named.
    const db = await orm();
    const artifact = await artifactFor(db, {
      options: {permission: {model: () => true, field: () => true}},
    });
    await expect(materializeSchema(artifact, db, {
      permission: {relationship: () => true},
      onMismatch: "throw",
    })).resolves.toBeDefined();
  });

  it("loads clean with no options at all", async() => {
    const db = await orm();
    const artifact = await artifactFor(db, {options: {permission: {model: () => true}}});
    await expect(materializeSchema(artifact, db)).resolves.toBeDefined();
  });

  it("still reports a genuine model change through the relaxed check", async() => {
    // The relaxations above must not swallow real staleness.
    const artifact = await artifactFor(await orm(), {permissionProfile: "admin"});
    await expect(materializeSchema(artifact, await orm(true)))
      .rejects.toThrow(/artifact is stale — models differs/);
  });

  it("passes when the loader supplies the matching permissionProfile", async() => {
    const db = await orm();
    const artifact = await artifactFor(db, {permissionProfile: "admin"});
    await expect(materializeSchema(artifact, db, {permissionProfile: "admin"}))
      .resolves.toBeDefined();
  });

  it("loads the stale artifact anyway under `warn`", async() => {
    const artifact = await artifactFor(await orm());
    const rebuilt = await materializeSchema(artifact, await orm(true), {onMismatch: "warn"});
    // the artifact's shape, not the live one — `extra` is genuinely absent
    const rebuiltChild = rebuilt.getType("Child");
    expect(rebuiltChild).toBeDefined();
    if (!isObjectType(rebuiltChild)) {
      throw new Error('Expected "Child" to be a GraphQLObjectType');
    }
    expect(rebuiltChild.getFields().extra).toBeUndefined();
  });

  it("falls back to a live build under `rebuild`", async() => {
    const artifact = await artifactFor(await orm());
    const live = await orm(true);
    const rebuilt = await materializeSchema(artifact, live, {onMismatch: "rebuild"});
    // the *live* shape, so the new field is there
    const rebuiltChild = rebuilt.getType("Child");
    if (!isObjectType(rebuiltChild)) {
      throw new Error('Expected "Child" to be a GraphQLObjectType');
    }
    expect(rebuiltChild.getFields().extra).toBeDefined();
    expect(printSchema(rebuilt)).toEqual(printSchema(await createSchema(live)));
  });

  it("treats an unreadable formatVersion as fatal except under `rebuild`", async() => {
    const db = await orm();
    const artifact = await artifactFor(db);
    await expect(materializeSchema({...artifact, formatVersion: 99}, db))
      .rejects.toThrow(/formatVersion 99 is not supported/);
    await expect(materializeSchema({...artifact, formatVersion: 99}, db, {onMismatch: "warn"}))
      .rejects.toThrow(/formatVersion 99 is not supported/);
    await expect(materializeSchema({...artifact, formatVersion: 99}, db, {onMismatch: "rebuild"}))
      .resolves.toBeDefined();
  });

  it("skips the check entirely under `checkStaleness: false`, but says so", async() => {
    // The escape hatch for deployments that already proved freshness in CI. It
    // has to actually skip the walk — computing the fingerprint and ignoring the
    // answer would buy nothing, since the walk is the whole cost — and it has to
    // be loud, because an unchecked load is indistinguishable from a fresh one.
    const artifact = await artifactFor(await orm());
    const changed = await orm(true);
    await expect(materializeSchema(artifact, changed)).rejects.toThrow(/stale/i);

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rebuilt = await materializeSchema(artifact, changed, {checkStaleness: false});
      // the artifact's shape, exactly as under `warn` — the model moved and the
      // load did not notice, which is the deal being struck
      const rebuiltChild = rebuilt.getType("Child");
      if (!isObjectType(rebuiltChild)) {
        throw new Error('Expected "Child" to be a GraphQLObjectType');
      }
      expect(rebuiltChild.getFields().extra).toBeUndefined();
      expect(warn.mock.calls.flat().join(" ")).toMatch(/checkStaleness is false/);
    } finally {
      warn.mockRestore();
    }
  });

  it("still checks under `checkStaleness: true`, and by omission", async() => {
    const artifact = await artifactFor(await orm());
    await expect(materializeSchema(artifact, await orm(true), {checkStaleness: true}))
      .rejects.toThrow(/stale/i);
    await expect(materializeSchema(artifact, await orm(true))).rejects.toThrow(/stale/i);
  });

  it("loads a fingerprint-less artifact, but says so", async() => {
    const db = await orm();
    const artifact = await artifactFor(db);
    delete artifact.fingerprint;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(materializeSchema(artifact, await orm(true))).resolves.toBeDefined();
      expect(warn.mock.calls.flat().join(" ")).toMatch(/no fingerprint/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("loadSchema", () => {
  it("reads a JSON artifact from disk", async() => {
    const db = await orm();
    const path = join(dir, "schema.json");
    writeFileSync(path, JSON.stringify(await artifactFor(db)));

    expect(printSchema(await loadSchema(path, db))).toEqual(printSchema(await createSchema(db)));
  });

  it("transparently decompresses a gzipped artifact", async() => {
    const db = await orm();
    const path = join(dir, "schema.json.gz");
    writeFileSync(path, gzipSync(JSON.stringify(await artifactFor(db))));

    expect(printSchema(await loadSchema(path, db))).toEqual(printSchema(await createSchema(db)));
  });

  it("detects gzip by magic bytes, not by extension", async() => {
    // deploy pipelines rename artifacts; the content is the authority
    const db = await orm();
    const path = join(dir, "renamed.json");
    writeFileSync(path, gzipSync(JSON.stringify(await artifactFor(db))));

    await expect(loadSchema(path, db)).resolves.toBeDefined();
  });

  it("names the path when the file is missing", async() => {
    await expect(loadSchema(join(dir, "nope.json"), await orm()))
      .rejects.toThrow(/could not read schema artifact ".*nope\.json"/);
  });

  it("names the path when the file is not JSON", async() => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not json");
    await expect(loadSchema(path, await orm())).rejects.toThrow(/is not valid JSON/);
  });

  it("exposes the read step on its own", async() => {
    const db = await orm();
    const path = join(dir, "read-only.json");
    const artifact = await artifactFor(db);
    writeFileSync(path, JSON.stringify(artifact));

    expect(await readSnapshot(path)).toEqual(artifact);
  });
});
