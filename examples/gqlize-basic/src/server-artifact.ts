import { createServer } from "node:http";
import { join } from "node:path";
import { createYoga } from "graphql-yoga";
import { loadSchema } from "@azerothian/gqlize/snapshot";
import { buildOrm } from "./orm";

/**
 * The same server as `server.ts`, but served off a pre-generated artifact.
 *
 * Run `pnpm schema:build` first. The ormize instance is still required — it is
 * the resolution engine the schema binds to; the artifact only replaces the
 * *type construction* step, not the database.
 */
async function main() {
  const orm = await buildOrm();

  const artifact = join(__dirname, "..", "generated", "schema.json");
  const schema = await loadSchema(artifact, orm, {
    // "throw" (the default) refuses to serve a schema that no longer matches the
    // models. In development, "rebuild" falls back to a live build instead so a
    // model edit does not force a rebuild step mid-iteration.
    onMismatch: process.env.NODE_ENV === "production" ? "throw" : "rebuild",
  });

  const yoga = createYoga({ schema, context: () => ({ instance: orm }) });

  const port = Number(process.env.PORT) || 4000;
  createServer(yoga).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`gqlize example (from artifact) listening on http://localhost:${port}/graphql`);
  });
}

main();
