import { startPglite } from "./pglite";
import { buildOrm, seenContexts } from "./orm";

/**
 * Demonstrates a coordinated ormize transaction across two adapters (SQLite +
 * in-memory Postgres) and AsyncLocalStorage request-context tracking.
 */
async function main() {
  const pg = await startPglite();
  try {
    const orm: any = await buildOrm(pg.dir);

    // 1. Happy path — an Order (SQLite) and its Payment (Postgres) committed atomically.
    await orm.transaction(async () => {
      await orm.processCreate("Order", null, { input: { ref: "ORD-1" } }, {}, undefined);
      await orm.processCreate("Payment", null, { input: { orderRef: "ORD-1", amount: 100 } }, {}, undefined);
    });
    console.log(
      "1) committed  → Orders(sqlite)=%d  Payments(pg)=%d",
      await orm.models.Order.count(),
      await orm.models.Payment.count(),
    );

    // 2. Failure path — the Postgres write fails (amount NOT NULL). The Order was
    //    already written on the SQLite adapter; the coordinator must roll it back too.
    let threw = false;
    try {
      await orm.transaction(async () => {
        await orm.processCreate("Order", null, { input: { ref: "ORD-2" } }, {}, undefined); // SQLite: succeeds
        await orm.processCreate("Payment", null, { input: { orderRef: "ORD-2", amount: null } }, {}, undefined); // Postgres: fails
      });
    } catch (e: any) {
      threw = true;
      console.log("2) failed     → rolled back both, cause:", String(e?.message).split("\n")[0]);
    }
    const orders = await orm.models.Order.count();
    const payments = await orm.models.Payment.count();
    console.log("   after fail → Orders(sqlite)=%d  Payments(pg)=%d (ORD-2 must be absent)", orders, payments);
    const rolledBackAcrossAdapters = threw && orders === 1 && payments === 1;

    // 3. Ambient context — read inside the Order `before` hook without threading it.
    await orm.runWithContext({ user: "alice" }, async () => {
      await orm.transaction(async () => {
        await orm.processCreate("Order", null, { input: { ref: "ORD-3" } }, {}, undefined);
        await orm.processCreate("Payment", null, { input: { orderRef: "ORD-3", amount: 50 } }, {}, undefined);
      });
    });
    const hookSawUser = seenContexts.some((c) => c && c.user === "alice");
    console.log("3) context    → hook observed user:", JSON.stringify(seenContexts.at(-1)));

    const pass = rolledBackAcrossAdapters && hookSawUser;
    console.log(
      pass
        ? "\nDEMO: PASS — a Postgres failure rolled back the SQLite write, and the hook saw the ambient context."
        : "\nDEMO: FAIL",
      { rolledBackAcrossAdapters, hookSawUser },
    );
    process.exitCode = pass ? 0 : 1;
  } finally {
    await pg.shutdown();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
