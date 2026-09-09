import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    maxWorkers: 2,
  },
  resolve: {
    alias: {
      "@getexception/browser": new URL(
        "./packages/browser/src/index.ts",
        import.meta.url,
      ).pathname,
      "@getexception/react": new URL(
        "./packages/react/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
