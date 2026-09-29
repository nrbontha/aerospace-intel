import type {
  InvestorPickCreateInput,
  InvestorPickDto,
  InvestorPicksPageDto,
  InvestorPickUpdateInput,
  InvestorReferenceImportResultDto,
  InvestorReferenceSet,
} from "@asi/contracts";
import {
  createInvestorPick,
  getDatabase,
  importInvestorReferenceSet,
  listInvestorPicks,
  updateInvestorPick,
} from "@asi/database";
import { currentFaaReviewInputContract } from "@asi/research";

export type InvestorPicksActor = { readonly kind: "admin"; readonly userId: string };

export async function listInvestorPicksForUser(input: {
  readonly canManage: boolean;
  readonly includeInactive?: boolean;
}): Promise<InvestorPicksPageDto> {
  const page = await listInvestorPicks(getDatabase(), {
    expectedReviewInputContract: currentFaaReviewInputContract(),
    ...(input.includeInactive === undefined
      ? {}
      : { includeInactive: input.includeInactive }),
  });

  return { ...page, canManage: input.canManage };
}

export async function createInvestorPickForAdmin(input: {
  readonly input: InvestorPickCreateInput;
  readonly actor: InvestorPicksActor;
}): Promise<InvestorPickDto> {
  return createInvestorPick(getDatabase(), {
    input: input.input,
    actor: input.actor,
    expectedReviewInputContract: currentFaaReviewInputContract(),
  });
}

export async function updateInvestorPickForAdmin(input: {
  readonly id: string;
  readonly input: InvestorPickUpdateInput;
  readonly actor: InvestorPicksActor;
}): Promise<InvestorPickDto> {
  return updateInvestorPick(getDatabase(), {
    id: input.id,
    input: input.input,
    actor: input.actor,
    expectedReviewInputContract: currentFaaReviewInputContract(),
  });
}

export async function importInvestorReferenceSetForAdmin(input: {
  readonly set: InvestorReferenceSet;
  readonly actor: InvestorPicksActor;
}): Promise<InvestorReferenceImportResultDto> {
  return importInvestorReferenceSet(getDatabase(), {
    set: input.set,
    actor: input.actor,
    expectedReviewInputContract: currentFaaReviewInputContract(),
  });
}
