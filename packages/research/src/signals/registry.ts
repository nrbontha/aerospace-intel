import { z } from "zod";

import type { SourceHarvester } from "./harvester.js";

const harvesterIdSchema = z.string().trim().min(1).max(100);
type RegisteredHarvester = SourceHarvester<unknown>;

export class DuplicateSourceHarvesterError extends Error {
  constructor(readonly harvesterId: string) {
    super(`Source harvester already registered: ${harvesterId}`);
    this.name = "DuplicateSourceHarvesterError";
  }
}

export class SourceHarvesterRegistry {
  readonly #harvesters = new Map<string, RegisteredHarvester>();

  register<Config>(harvester: SourceHarvester<Config>): this {
    const id = harvesterIdSchema.parse(harvester.id);
    if (this.#harvesters.has(id)) {
      throw new DuplicateSourceHarvesterError(id);
    }

    this.#harvesters.set(id, harvester as RegisteredHarvester);
    return this;
  }

  lookup(id: string): RegisteredHarvester | undefined {
    return this.#harvesters.get(id);
  }

  list(): readonly RegisteredHarvester[] {
    return [...this.#harvesters.values()];
  }
}
