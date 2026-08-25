import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("qualification observability rendering", () => {
  it("renders zero/nonzero source signals and paused/running qualifier states", async () => {
    await expect(
      run("npx", ["tsx", "apps/web/src/components/research-control/qualification-observability.render.tsx"], {
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({ stderr: "" });
  });
});
