import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    exclude: ["node_modules/**", "tests/fixtures/**/*"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
