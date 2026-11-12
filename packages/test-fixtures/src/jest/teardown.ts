// Jest `setupFilesAfterEnv` entry: closes the connections `../dialect` handed
// out, and stops the file's PGlite once its tests are done so Jest can exit.
import { afterAll, afterEach } from "@jest/globals";
import { shutdownShared, teardownAll, teardownSuite } from "../dialect";

afterEach(async () => {
  await teardownAll();
});

afterAll(async () => {
  await teardownSuite();
  await shutdownShared();
});
