import { describe, expect, it } from "vitest";

import { classifySentence } from "../packages/research/src/enrichment/ownership.js";

describe("classifySentence acquisition verbs", () => {
  it("catches Completes/Announces Acquisition headlines", () => {
    expect(
      classifySentence(
        "TransDigm Completes Acquisition of DART Aerospace",
        "Dart Aerospace",
      ),
    ).toMatchObject({ status: "acquired", owner: "TransDigm" });
    expect(
      classifySentence(
        "TransDigm Announces Acquisition of DART Aerospace",
        "Dart Aerospace",
      ),
    ).toMatchObject({ status: "acquired", owner: "TransDigm" });
  });

  it("still catches acquired-by phrasing", () => {
    expect(
      classifySentence(
        "Dart Aerospace was acquired by TransDigm in 2022",
        "Dart Aerospace",
      ),
    ).toMatchObject({ status: "acquired" });
  });

  it("does not vote without an owner", () => {
    expect(
      classifySentence("The company announced growth plans", "Dart Aerospace"),
    ).toBeNull();
  });
});
