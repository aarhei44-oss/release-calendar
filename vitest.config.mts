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
    // Test files share one SQLite file via better-sqlite3 (single connection,
    // file-level locking); running files in parallel causes lock timeouts.
    fileParallelism: false,
    env: {
      DATABASE_URL: "file:./prisma/test.db",
      ADMIN_EMAILS: "admin@example.com, Other.Admin@Example.com",
    },
    globalSetup: "./tests/globalSetup.ts",
  },
});
