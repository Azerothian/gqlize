import { graphql, printSchema } from "graphql";
import { describe, it, expect, jest } from "@jest/globals";

import { createInstance, resultData, validateResult } from "../helper";
import type { GqlizeOptions } from "../../src";
import { createSchema, prefixIdCodec, plainCursorCodec, rawIdCodec } from "../../src";
import type { SchemaSnapshot, SnapshotOptions } from "../../src/snapshot";
import { materializeSchema, snapshotSchema } from "../../src/snapshot";

const id = prefixIdCodec({
  prefixes: {Task: "TSK", TaskItem: "TSKI", Item: "ITM", Parent: "PAR", Child: "CHD"},
  pad: 6,
});
const cursor = plainCursorCodec();

type Instance = Awaited<ReturnType<typeof createInstance>>;

/** artifact from a live schema, through JSON as it would be on disk */
async function artifactFor(
  instance: Instance,
  opts: SnapshotOptions & {options?: GqlizeOptions} = {},
): Promise<SchemaSnapshot> {
  return JSON.parse(JSON.stringify(
    snapshotSchema(await createSchema(instance, opts.options), opts),
  )) as SchemaSnapshot;
}

/** the one query these tests run, and the shape it selects */
type ChildEdges = {models: {Child: {edges: {cursor: string; node: {id: string; name: string}}[]}}};

describe("codecs through the snapshot artifact", () => {
  it("mints the same ids and cursors as a live build", async() => {
    const instance = await createInstance();
    for (let i = 1; i <= 3; i++) {
      await instance.models.Child.create({name: `c${i}`});
    }
    const options = {id, cursor};
    const artifact = await artifactFor(instance, {options, idProfile: "prefix", cursorProfile: "plain"});
    const loaded = await materializeSchema(artifact, instance, {
      ...options, idProfile: "prefix", cursorProfile: "plain",
    });

    const source = `query { models { Child(first: 2, orderBy: nameASC) { edges { cursor node { id name } } } } }`;
    const live = await graphql({schema: await createSchema(instance, options), source});
    const fromArtifact = await graphql({schema: loaded, source});
    validateResult(live);
    validateResult(fromArtifact);
    expect(fromArtifact.data).toEqual(live.data);
    // ...and they really are this codec's formats, not the defaults.
    const [edge] = resultData<ChildEdges>(fromArtifact).models.Child.edges;
    expect(edge.node.id).toMatch(/^CHD0*1$/);
    expect(cursor.decode({value: edge.cursor})!.index).toEqual(0);
  });

  it("records the id and cursor profiles in the fingerprint", async() => {
    const instance = await createInstance();
    const artifact = await artifactFor(instance, {
      options: {id, cursor}, idProfile: "prefix", cursorProfile: "plain",
    });
    expect(artifact.fingerprint).toMatchObject({idProfile: "prefix", cursorProfile: "plain"});
  });

  // The failure this exists to catch: an artifact built with codecs, loaded
  // without them. It resolves — it just hands clients a different format than
  // the one it accepts.
  it("refuses to load an artifact built with codecs when none are supplied", async() => {
    const instance = await createInstance();
    const artifact = await artifactFor(instance, {options: {id, cursor}});
    await expect(materializeSchema(artifact, instance))
      .rejects.toThrow(/artifact is stale — optionsShape differs/);
  });

  it("refuses to load an artifact built without codecs when some are supplied", async() => {
    const instance = await createInstance();
    const artifact = await artifactFor(instance);
    await expect(materializeSchema(artifact, instance, {id, cursor}))
      .rejects.toThrow(/artifact is stale — optionsShape differs/);
  });

  it("names the profile when the codec was swapped for another of the same shape", async() => {
    const instance = await createInstance();
    const artifact = await artifactFor(instance, {options: {id}, idProfile: "prefix-v1"});
    const other = prefixIdCodec({prefixes: {Task: "T", TaskItem: "TI", Item: "I", Parent: "P", Child: "C"}});
    await expect(materializeSchema(artifact, instance, {id: other, idProfile: "prefix-v2"}))
      .rejects.toThrow(/idProfile \(artifact "prefix-v1", live "prefix-v2"\)/);
  });

  it("warns rather than failing when a profile is simply not supplied at load", async() => {
    const instance = await createInstance();
    const artifact = await artifactFor(instance, {options: {id}, idProfile: "prefix-v1"});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await materializeSchema(artifact, instance, {id});
      expect(warn.mock.calls.map((c) => `${c[0]}`).join("\n")).toMatch(/built with idProfile "prefix-v1"/);
    } finally {
      warn.mockRestore();
    }
  });

  it("carries the omitted node field through the artifact for a codec with no type", async() => {
    const instance = await createInstance();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    let artifact: SchemaSnapshot;
    try {
      artifact = await artifactFor(instance, {options: {id: rawIdCodec()}});
      expect(warn.mock.calls.map((c) => `${c[0]}`).join("\n")).toMatch(/carriesType: false/);
    } finally {
      warn.mockRestore();
    }
    const loaded = await materializeSchema(artifact, instance, {id: rawIdCodec()});
    expect(loaded.getQueryType()!.getFields().node).toBeUndefined();
    expect(printSchema(loaded))
      .toEqual(printSchema(await createSchema(instance, {id: rawIdCodec()})));
  });
});
