import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("SynthesisTrail rendered markup", () => {
  it("renders the full source trail, review permissions, honest states, and confirmed scarcity guard", async () => {
    await expect(
      run(
        "npx",
        [
          "tsx",
          "apps/web/src/components/candidate-profile/synthesis-trail.render.tsx",
        ],
        { cwd: process.cwd() },
      ),
    ).resolves.toMatchObject({ stderr: "" });
  });
});
