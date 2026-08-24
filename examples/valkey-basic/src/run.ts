import { connect } from "./redis";
import { buildOrm } from "./orm";

async function main() {
  const { client, shutdown } = await connect();
  try {
    const orm: any = await buildOrm(client);
    const adapter: any = orm.getModelAdapter("Item");

    // Seed two items + tasks (FK set directly — that's how you associate on a KV store).
    const [box] = await orm.processCreate("Item", null, { input: { label: "box", sku: "SKU-1" } }, {}, undefined);
    const [bag] = await orm.processCreate("Item", null, { input: { label: "bag", sku: "SKU-2" } }, {}, undefined);
    await orm.processCreate("Task", null, { input: { name: "pack", itemId: box.id } }, {}, undefined);
    await orm.processCreate("Task", null, { input: { name: "seal", itemId: box.id } }, {}, undefined);

    // 1. Index-only query (never scans the keyspace).
    const boxes = await orm.resolveFindAll("Item", null, { where: { label: "box" } }, {}, undefined);
    console.log("1) query label=box →", boxes.models.map((m: any) => m.sku));

    // 2. Relationship read via the foreign-key index map.
    const assoc = adapter.getAssociations("Item").tasks;
    const tasks = await adapter.resolveManyRelationship("Task", assoc, box, {args: {}, offset: 0});
    console.log("2) box.tasks (via itemId index) →", tasks.models.map((m: any) => m.name), `(total ${tasks.total})`);

    // 3. Expiry cascades to the index maps: expire `bag`, and it disappears from
    //    index results once elapsed (and is purged) — no scan involved.
    await adapter.setExpiry("Item", bag.id, 100);
    const before = (await orm.resolveFindAll("Item", null, {}, {}, undefined)).total;
    await new Promise((r) => setTimeout(r, 200));
    const after = (await orm.resolveFindAll("Item", null, {}, {}, undefined)).total;
    console.log(`3) expiry cascade → items before=${before} after=${after} (bag expired out of the ids/label maps)`);

    const pass =
      boxes.models.length === 1 && boxes.models[0].sku === "SKU-1" &&
      tasks.total === 2 &&
      before === 2 && after === 1;
    console.log(pass ? "\nDEMO: PASS" : "\nDEMO: FAIL");
    process.exitCode = pass ? 0 : 1;
  } finally {
    await shutdown();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
