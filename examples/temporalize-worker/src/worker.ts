import { buildQueueMap, createWorkers } from "@azerothian/temporalize";
import { buildOrm } from "./orm";
import { TEMPORALIZE_OPTIONS } from "./shared";

/**
 * In your own app this is:
 *
 *   workflowsPath: require.resolve("@azerothian/temporalize/workflows")
 *
 * Inside this workspace the package is consumed from source rather than from a
 * built `publish/` directory, so the subpath export does not exist yet — point
 * at the source module instead. Temporal's bundler compiles TypeScript workflow
 * entrypoints itself.
 */
const workflowsPath = require.resolve("../../../packages/temporalize/src/workflows.ts");

async function main() {
  const orm = await buildOrm();

  const workers = await createWorkers(orm, {
    ...TEMPORALIZE_OPTIONS,
    workflowsPath,
    // Defaults to localhost:7233 — where `temporal server start-dev` listens.
  });

  // Same JSON as src/shared.ts's hardcoded QUEUE_MAP; the client uses that copy.
  console.log("queue map:", JSON.stringify(buildQueueMap(orm, TEMPORALIZE_OPTIONS), null, 2));
  for (const w of workers.workers) {
    console.log(`worker polling ${w.queue} (models: ${w.models.join(", ")})`);
  }

  const stop = () => workers.shutdownAll();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Resolves once every worker has drained after shutdown.
  await workers.runAll();
  console.log("workers stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
