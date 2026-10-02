import { afterEach, afterAll } from "@jest/globals";
import { teardownAll, teardownSuite, shutdownShared } from "../helper/dialect";

// Close the per-test Sequelize connection(s) after each test (no-op for sqlite).
afterEach(async () => {
  await teardownAll();
});

// Stop the shared PGlite server once the file's tests are done so Jest can exit.
afterAll(async () => {
  await teardownSuite();
  await shutdownShared();
});
