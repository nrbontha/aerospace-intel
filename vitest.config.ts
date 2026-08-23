import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Apps Web's "@/..." imports resolve so route/lib modules can be
      // unit-tested directly.
      "@": path.resolve(import.meta.dirname, "apps/web/src"),
    },
  },
  test: {
    environment: "node",
    include: [
      "tests/**/*.{test,spec}.{ts,tsx}",
      "apps/**/*.{test,spec}.{ts,tsx}",
      "packages/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    setupFiles: ["./tests/setup.ts"],
  },
});
