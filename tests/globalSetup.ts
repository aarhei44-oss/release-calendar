import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const TEST_DB_PATH = "prisma/test.db";

export default function setup() {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const file = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(file)) rmSync(file);
  }

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: `file:./${TEST_DB_PATH}` },
    stdio: "inherit",
  });
}
