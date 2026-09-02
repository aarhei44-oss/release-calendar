import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  test: {
    environment: "node",
    exclude: ["node_modules/**", "tests/e2e/**"],
    env: {
      DATABASE_URL: "file:./prisma/test.db",
      ADMIN_EMAILS: "admin@example.com, Other.Admin@Example.com",
    },
    globalSetup: "./tests/globalSetup.ts",
  },
});
