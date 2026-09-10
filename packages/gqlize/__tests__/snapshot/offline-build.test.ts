import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {graphql, printSchema} from "graphql";
import {describe, it, expect, beforeAll, afterAll} from "@jest/globals";

import {liveInstance, offlineInstance, probeConnection, TRIPWIRE_MESSAGE} from "../helper/offline";
import {createSchema} from "../../src";
import {buildArtifact, loadSchema, materializeSchema, readSnapshot} from "../../src/snapshot";

/**
 * Generating a schema needs no database.
 *
 * That is the whole reason `gqlize build` / `check` can be a CI gate on a runner
 * with no database service, and it holds only because every step reads model
 * metadata: `getFields` off `rawAttributes`, `getAssociations`, the type mapper,
 * `softDeletes`. Nothing here mocks the adapter out — it is the real Sequelize
 * adapter, pointed at a postgres server that does not exist, with a
 * `beforeConnect` tripwire so a regression that reintroduces a connection fails
 * these tests by name instead of hanging.
 *
 * `__tests__/snapshot/fingerprint.test.ts` relies on the same property for its
 * dialect test; this pins it for the whole build path.
 */
describe("offline schema generation", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gqlize-offline-"));
  });
  afterAll(() => rmSync(dir, {recursive: true, force: true}));

  it("arms the tripwire it relies on", async() => {
    const instance = await offlineInstance();
    // Guards the tests below: if a connection could be opened silently, "no
    // connection was opened" would be unfalsifiable here.
    await expect(probeConnection(instance)).rejects.toThrow(TRIPWIRE_MESSAGE);
  });

  it("builds a schema with no database behind it", async() => {
    const schema = await createSchema(await offlineInstance());
    const sdl = printSchema(schema);

    expect(sdl).toContain("type Author");
    expect(sdl).toContain("type Book");
    // The relationship was wired by `initialise({ddl: false})`, in memory.
    expect(sdl).toContain("books(");
    // `paranoid` is read off model options, so the soft-delete surface is there too.
    expect(sdl).toContain("deleted");
  });

  it("writes an artifact and materializes it back", async() => {
    const instance = await offlineInstance();
    const out = join(dir, "schema.json");
    const sdl = join(dir, "schema.graphql");

    const result = await buildArtifact(instance, {out, sdl});
    expect(result.typeCount).toBeGreaterThan(0);
    expect(readFileSync(sdl, "utf8")).toContain("type Book");

    const materialized = await materializeSchema(await readSnapshot(out), instance);
    expect(printSchema(materialized)).toEqual(printSchema(await createSchema(instance)));
  });

  it("produces an artifact a live, differently-dialected instance can serve", async() => {
    // The whole point of the offline build: the artifact is generated against a
    // postgres that does not exist and loaded against a live sqlite. The dialect
    // is deliberately excluded from the fingerprint, so this is not a mismatch.
    const out = join(dir, "portable.json");
    await buildArtifact(await offlineInstance(), {out});

    const live = await liveInstance();
    const schema = await loadSchema(out, live);

    const author = await live.models.Author.create({name: "Ada"});
    await live.models.Book.create({title: "Notes", authorId: author.id});

    const result = await graphql({
      schema,
      source: "{ models { Author { edges { node { name books { edges { node { title } } } } } } } }",
      contextValue: {instance: live},
    });

    expect(result.errors).toBeUndefined();
    expect(JSON.stringify(result.data)).toContain("Notes");
  });
});
