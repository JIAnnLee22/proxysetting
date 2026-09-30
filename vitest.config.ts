import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
