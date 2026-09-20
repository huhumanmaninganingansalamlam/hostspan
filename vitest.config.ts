import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Windows native process/ConPTY tests are substantially more sensitive to
    // process-spawn and antivirus scheduling than the Unix lanes. Running test
    // files sequentially there also prevents one suite's process-tree cleanup
    // from contending with another suite's workers.
    fileParallelism: process.platform !== "win32",
    testTimeout: process.platform === "win32" ? 60_000 : 15_000,
    hookTimeout: process.platform === "win32" ? 30_000 : 15_000,
  },
});
