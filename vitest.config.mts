import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    exclude: ["node_modules/**", "tests/e2e/**"],
    env: {
      DATABASE_URL: "file:./prisma/test.db",
    },
    globalSetup: "./tests/globalSetup.ts",
  },
});
