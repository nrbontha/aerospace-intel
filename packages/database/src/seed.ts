import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function runSeed(): void {
  // Production data is intentionally never synthesized by this entrypoint.
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  pathToFileURL(resolve(entryPoint)).href === import.meta.url
) {
  runSeed();
  process.stdout.write("No seed data configured; nothing to apply.\n");
}
