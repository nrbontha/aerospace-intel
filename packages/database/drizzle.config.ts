import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: resolve(packageDirectory, "src/schema.ts"),
  out: resolve(packageDirectory, "../../migrations"),
  strict: true,
  verbose: false,
  ...(databaseUrl === undefined || databaseUrl.length === 0
    ? {}
    : { dbCredentials: { url: databaseUrl } }),
});
