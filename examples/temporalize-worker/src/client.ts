import { Client } from "@temporalio/client";
import { createTemporalizeClient } from "@azerothian/temporalize";
import { QUEUE_MAP } from "./shared";

// No ormize instance and no database connection here — just the queue map.
const t = createTemporalizeClient(new Client(), QUEUE_MAP);

const admin = { userId: "u1", role: "admin" };
const reader = { userId: "u2", role: "reader" };

async function main() {
  const item = t.model("Item");
  const task = t.model("Task");

  const [groceries] = await item.create({ context: admin, input: { label: "Groceries" } });
  console.log("created Item:", groceries);

  await task.create({ context: admin, input: { name: "Buy milk", itemId: groceries.id } });
  await task.create({ context: admin, input: { name: "Buy eggs", itemId: groceries.id, done: true } });

  const tasks = await task.findAll({ context: admin, where: { done: { eq: false } }, limit: 10 });
  console.log("outstanding tasks:", tasks);

  // classMethods / instanceMethods are activities too.
  console.log("Item.labelsUpper:", await item.classMethod("labelsUpper", { context: admin }));
  console.log(
    "Item.describe:",
    await item.instanceMethod("describe", { context: admin, id: groceries.id, args: { suffix: " (list)" } })
  );

  // Reads are fine for the reader role...
  console.log("reader sees", await task.count({ context: reader }), "tasks");

  // ...writes are not. This comes back as a non-retryable ApplicationFailure:
  // the workflow fails immediately rather than retrying a 403 forever.
  try {
    await task.create({ context: reader, input: { name: "not allowed" } });
    console.error("BUG: the reader role was allowed to write");
  } catch (e: any) {
    // WorkflowFailedError -> ActivityFailure -> the ApplicationFailure temporalize
    // threw. Temporal does not flatten the chain, so callers walk it.
    const failure = e.cause?.cause;
    console.log("reader create rejected:", failure?.type, "-", failure?.message);
    console.log("  nonRetryable:", failure?.nonRetryable);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
