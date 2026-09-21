import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `pnpm build` emits declaration/runtime copies of test files under dist.
    // Keep the executable test source set explicit so a prior build can never
    // double-count stale compiled tests or hide source/compiled divergence.
    include: ["test/**/*.test.ts"],
    // Windows native process/ConPTY tests are substantially more sensitive to
    // process-spawn and antivirus scheduling than the Unix lanes. Running test
    // files sequentially there also prevents one suite's process-tree cleanup
    // from contending with another suite's workers.
    fileParallelism: process.platform !== "win32",
    testTimeout: process.platform === "win32" ? 60_000 : 15_000,
    hookTimeout: process.platform === "win32" ? 30_000 : 15_000,
  },
});
