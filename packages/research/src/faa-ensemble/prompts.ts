/**
 * FAA two-model ensemble prompts. The template consts below transcribe the
 * source-of-truth spec verbatim (placeholders intact); the builders only
 * substitute caller-supplied evidence. Prompt text lives here and nowhere
 * else — never inline copies in the runner or elsewhere.
 */

export const FAA_QUALIFICATION_PROMPT_VERSION = "faa_qualification_v1";
export const FAA_ADJUDICATOR_PROMPT_VERSION = "faa_adjudicator_v1";

export interface FaaEvaluatorEvidence {
  readonly companyName: string;
  readonly identifiers: string;
  readonly sourceSignals: string;
  readonly companyDescription: string;
  readonly evidence: string;
}

export interface FaaAdjudicatorEvidence {
  readonly companyName: string;
  readonly identifiers: string;
  readonly sourceSignals: string;
  readonly evidence: string;
}

export const FAA_EVALUATOR_PROMPT_TEMPLATE = `You are evaluating aerospace and defense companies as potential acquisition targets for a private equity sourcing project.

Your job is NOT to prove that a company is a good acquisition target.

Your job is to make a conservative first-pass determination of whether the company deserves additional research.

The acquisition thesis is approximately:

* Small aerospace or defense supplier
* Prefer privately held / independently owned businesses
* Likely acquisition value below roughly $50M
* Tier 3 / Tier 4 supplier rather than a prime contractor
* Manufactures components, assemblies, tooling, ground-support equipment, specialized systems, or other physical aerospace/defense products
* Particularly attractive when there is evidence of:

  * proprietary products
  * FAA-approved or qualified parts
  * PMA/STC/TSO or similar certifications
  * sole-source or limited-source position
  * recurring aftermarket demand
  * installed-base exposure
  * qualification on specific aircraft or defense platforms
  * difficult manufacturing or engineering capabilities
  * mission-critical but low-dollar components
  * niche market leadership

Generic machine shops, commodity contract manufacturers, distributors, consultants, software companies, airlines, airports, government agencies, universities, major primes, and obviously large strategic companies are generally poor fits unless there is unusually strong contrary evidence.

Important operating principle:

DO NOT infer facts that are not supported by the supplied evidence.

In particular, do not invent or infer:

* revenue
* EBITDA
* ownership
* employee count
* valuation
* customer concentration
* sole-source status
* proprietary status

A lack of evidence is not itself a reason to reject an otherwise plausible company.

The purpose of this stage is to avoid false negatives.

If a small obscure aerospace manufacturer plausibly resembles the target profile but important facts are unknown, classify it for further research.

## Input

COMPANY NAME:
{{company_name}}

KNOWN IDENTIFIERS:
{{identifiers}}

FAA / GOVERNMENT / DATABASE SIGNALS:
{{source_signals}}

AVAILABLE COMPANY DESCRIPTION:
{{company_description}}

AVAILABLE WEB OR DATABASE EVIDENCE:
{{evidence}}

## Evaluation

Evaluate:

1. Is this actually an aerospace/defense supplier?
2. Does it manufacture physical products?
3. Is it likely Tier 3 / Tier 4 rather than a prime?
4. Is there evidence of specialized or difficult-to-replace products?
5. Is there certification, qualification, PMA, STC, TSO, platform, or similar evidence?
6. Is there evidence of proprietary products rather than purely build-to-print work?
7. Is there evidence suggesting aftermarket or recurring replacement demand?
8. Is there affirmative evidence that the company is too large or otherwise outside the acquisition thesis?
9. What important facts remain unknown?
10. Could rejecting this company create a meaningful false-negative risk?

## Output

Return ONLY valid JSON:

{
  "decision": "reject | research | high_priority",
  "confidence": 0,
  "company_type": "",
  "aerospace_defense_relevance": "none | weak | moderate | strong",
  "manufacturing_evidence": "none | weak | moderate | strong",
  "thesis_signals": [],
  "disqualifiers": [],
  "missing_evidence": [],
  "false_negative_risk": "low | medium | high",
  "reason": ""
}

Confidence is 0-100 confidence in the decision, not confidence that all facts are known.

Keep reason under 80 words.

Do not use outside knowledge unless explicitly contained in the supplied evidence.

Do not reward famous companies merely because you recognize them.

Favor evidence over familiarity.`;

export const FAA_ADJUDICATOR_PROMPT_TEMPLATE = `You are the final adjudicator in a multi-model aerospace acquisition-target screening system.

Two independent screening models evaluated the same company and disagreed.

Your job is to resolve that disagreement using the underlying evidence, not by voting or averaging their answers.

The objective of this stage is:

1. eliminate obvious false positives;
2. avoid losing obscure but potentially valuable acquisition targets;
3. distinguish missing evidence from affirmative negative evidence.

A false positive at this stage costs additional research.

A false negative may permanently remove a potentially attractive acquisition target.

Therefore, when evidence is genuinely ambiguous, prefer research over reject.

Do NOT prefer high_priority unless strong positive evidence exists.

## Acquisition thesis

The desired target is generally:

* small aerospace/defense supplier
* likely independently/private ownership
* likely acquisition value below approximately $50M
* Tier 3 / Tier 4
* physical product manufacturer
* specialized components, assemblies, tooling, GSE, subsystems, or related products

Especially attractive signals include:

* FAA PMA
* STC
* TSO
* OEM/platform qualification
* proprietary products
* sole/limited-source characteristics
* recurring aftermarket demand
* installed-base exposure
* niche engineering/manufacturing capability
* mission-critical low-dollar products

Typical negative examples include:

* major primes
* obviously large strategics
* airlines
* airports
* government entities
* universities
* pure consulting
* pure software
* unrelated companies
* distributors without meaningful manufacturing
* entity-resolution mistakes

Missing ownership, revenue, employee count, or valuation is NOT sufficient reason to reject.

## Company

COMPANY NAME:
{{company_name}}

IDENTIFIERS:
{{identifiers}}

SOURCE SIGNALS:
{{source_signals}}

EVIDENCE:
{{evidence}}

## Model A assessment

{{model_a_result}}

## Model B assessment

{{model_b_result}}

## Adjudication procedure

First identify the substantive reason the models disagree.

Possible causes include:

* different interpretation of the same evidence
* unsupported inference by one model
* missing evidence
* entity-resolution ambiguity
* different treatment of generic manufacturing
* different treatment of company size
* different treatment of aerospace relevance
* different treatment of proprietary/qualified products
* another identifiable reason

Then independently determine the correct disposition.

Important:

If one model rejects because information is UNKNOWN while the other advances because the company remains plausible, normally choose research.

If one model identifies affirmative evidence of a clear disqualifier and that evidence is supported, normally choose reject.

If one model claims a positive thesis signal that is not actually supported by the evidence, ignore that claimed signal.

Do not infer private ownership, small size, revenue, proprietary status, sole-source status, or qualification merely from company language.

## Final categories

reject — Clear affirmative evidence that the company is outside the thesis.

research — Plausibly relevant and not affirmatively disqualified, but important evidence remains missing.

high_priority — Strong evidence that the company closely resembles the desired acquisition archetype.

## Output

Return ONLY valid JSON:

{
  "decision": "reject | research | high_priority",
  "confidence": 0,
  "disagreement_type": "",
  "model_a_error": "",
  "model_b_error": "",
  "decisive_evidence": [],
  "missing_evidence": [],
  "false_negative_risk": "low | medium | high",
  "reason": ""
}

model_a_error and model_b_error may be "none".

Confidence is confidence in the final disposition.

Keep reason under 100 words.`;

/** Literal placeholder substitution (no regex, so `$` in values is safe). */
function fill(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  let out = template;
  for (const [placeholder, value] of Object.entries(values)) {
    out = out.split(placeholder).join(value);
  }
  return out;
}

export function buildEvaluatorPrompt(evidence: FaaEvaluatorEvidence): string {
  return fill(FAA_EVALUATOR_PROMPT_TEMPLATE, {
    "{{company_name}}": evidence.companyName,
    "{{identifiers}}": evidence.identifiers,
    "{{source_signals}}": evidence.sourceSignals,
    "{{company_description}}": evidence.companyDescription,
    "{{evidence}}": evidence.evidence,
  });
}

export function buildAdjudicatorPrompt(
  evidence: FaaAdjudicatorEvidence,
  modelA: string,
  modelB: string,
): string {
  return fill(FAA_ADJUDICATOR_PROMPT_TEMPLATE, {
    "{{company_name}}": evidence.companyName,
    "{{identifiers}}": evidence.identifiers,
    "{{source_signals}}": evidence.sourceSignals,
    "{{evidence}}": evidence.evidence,
    "{{model_a_result}}": modelA,
    "{{model_b_result}}": modelB,
  });
}
