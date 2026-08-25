import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CandidateSynthesisSection,
  SynthesisTrail,
  type CompanySynthesisTrail,
} from "./synthesis-trail.js";

// tsx honors the web tsconfig's JSX-preserve setting; emulate Next's JSX runtime.
Reflect.set(globalThis, "React", React);

const trail: CompanySynthesisTrail = {
  company: {
    id: "company-1",
    name: "Acme Flight Systems",
    domain: "acmeflight.example",
  },
  identifiers: [
    {
      id: "identifier-cage",
      label: "CAGE",
      value: "1A2B3",
      status: "canonical",
      authority: "SAM.gov",
      officialUrl: "https://sam.gov/entity/1A2B3",
      excerpt: "CAGE Code 1A2B3",
      locator: "Entity registration, identifiers",
      freshness: "Observed 2026-08-24",
    },
  ],
  facilities: [
    {
      id: "facility-main",
      name: "Main manufacturing facility",
      address: "100 Flight Way, Wichita, KS",
      status: "pending",
      authority: "SAM.gov",
      officialUrl: "https://sam.gov/entity/1A2B3",
      excerpt: "Physical address: 100 Flight Way",
      locator: "Entity registration, address",
      freshness: "Observed 2026-08-24",
    },
  ],
  sourceRecords: [
    {
      id: "source-sam",
      sourceKey: "sam.gov",
      locator: "UEI ACME12345678",
      authority: "U.S. General Services Administration",
      status: "pending",
      facts: [
        {
          id: "observation-sam-name",
          label: "Legal business name",
          value: "Acme Flight Systems LLC",
          status: "canonical",
          excerpt: "Legal Business Name: Acme Flight Systems LLC",
        },
      ],
      evidenceUrls: ["https://sam.gov/entity/1A2B3"],
      expectedObservationIds: ["observation-sam-name"],
      freshness: "Observed 2026-08-24",
    },
  ],
  qualifications: [
    {
      id: "pma-1",
      holderNumber: "PQ1234CE",
      status: "Current",
      part: {
        number: "AFS-42",
        name: "Fuel pump housing",
        replacementFor: "OEM-9000",
      },
      make: "Cessna",
      models: ["172S", "182T"],
      approvalBasis: "Test and computation",
      supplement: "Supplement 7",
      facility: {
        id: "facility-main",
        name: "Main manufacturing facility",
        address: "100 Flight Way, Wichita, KS",
      },
      materializationStatus: "active",
      authority: "Federal Aviation Administration",
      officialUrl: "https://drs.faa.gov/pma/PQ1234CE",
      locator: "PMA database, supplement 7",
      freshness: "Published 2026-07-11",
    },
  ],
  conflicts: [
    {
      id: "conflict-name",
      field: "Legal business name",
      summary: "SAM.gov and the FAA record use different legal suffixes.",
      facts: [
        {
          id: "sam-name",
          label: "SAM.gov name",
          value: "Acme Flight Systems LLC",
          status: "conflict",
          authority: "SAM.gov",
          officialUrl: "https://sam.gov/entity/1A2B3",
          excerpt: "Acme Flight Systems LLC",
          locator: "Entity registration",
          freshness: "Observed 2026-08-24",
        },
        {
          id: "faa-name",
          label: "FAA holder name",
          value: "Acme Flight Systems Inc.",
          status: "conflict",
          authority: "Federal Aviation Administration",
          officialUrl: "https://drs.faa.gov/pma/PQ1234CE",
          excerpt: "Acme Flight Systems Inc.",
          locator: "PMA holder",
          freshness: "Published 2026-07-11",
        },
      ],
    },
  ],
  gaps: [
    {
      id: "gap-ownership",
      question: "Who is the current beneficial owner?",
      reason: "Neither primary record identifies beneficial ownership.",
      priority: "high",
    },
  ],
  confidence: {
    sourceCount: 2,
    primarySourceCount: 2,
    conflictCount: 1,
    score: 0.82,
  },
};

const viewerMarkup = renderToStaticMarkup(
  createElement(SynthesisTrail, { trail, role: "viewer" }),
);

assert.match(viewerMarkup, /Identity consensus/);
assert.match(viewerMarkup, /Facilities/);
assert.match(viewerMarkup, /Source records/);
assert.match(viewerMarkup, /sam\.gov/);
assert.match(viewerMarkup, /U\.S\. General Services Administration/);
assert.match(viewerMarkup, /FAA PMA qualification graph/);
assert.match(viewerMarkup, /PMA PQ1234CE/);
assert.match(viewerMarkup, /Company: <strong>Acme Flight Systems<\/strong>/);
assert.match(viewerMarkup, /Facility: <strong>Main manufacturing facility<\/strong>/);
assert.match(viewerMarkup, /PMA part: <strong>AFS-42<\/strong>/);
assert.match(viewerMarkup, /Make: <strong>Cessna<\/strong>/);
assert.match(viewerMarkup, /Model: 172S/);
assert.match(viewerMarkup, /Replaces: OEM-9000/);
assert.match(viewerMarkup, /Test and computation/);
assert.match(viewerMarkup, /Supplement 7/);
assert.match(viewerMarkup, /data-tone="success">active<\/span>/);
assert.match(viewerMarkup, /Conflicts/);
assert.match(viewerMarkup, /SAM\.gov and the FAA record use different legal suffixes/);
assert.match(viewerMarkup, /Research gaps/);
assert.match(viewerMarkup, /Who is the current beneficial owner\?/);
assert.match(viewerMarkup, /Confidence inputs/);
assert.match(viewerMarkup, /Inputs used to assess synthesis confidence/);
assert.match(viewerMarkup, /<caption[^>]*>Evidence-backed company identifiers<\/caption>/);
assert.match(viewerMarkup, /<th[^>]*scope="row"[^>]*>CAGE<\/th>/);
assert.match(
  viewerMarkup,
  /<button[^>]*disabled=""[^>]*>.*Accept source record.*<\/button>/,
);
assert.match(
  viewerMarkup,
  /<button[^>]*disabled=""[^>]*>.*Reject source record.*<\/button>/,
);
assert.match(viewerMarkup, /Viewer access is read-only/);
assert.doesNotMatch(viewerMarkup, /sole source/i);

const profileSynthesisMarkup = renderToStaticMarkup(
  createElement(CandidateSynthesisSection, {
    trail,
    loading: false,
    error: null,
    role: "viewer",
    reviewing: false,
    onAccept: () => undefined,
    onReject: () => undefined,
  }),
);
assert.match(
  profileSynthesisMarkup,
  /data-candidate-section=\"synthesis\"/,
);
assert.match(profileSynthesisMarkup, /FAA PMA qualification graph/);
assert.match(profileSynthesisMarkup, /https:\/\/drs\.faa\.gov\/pma\/PQ1234CE/);
assert.match(profileSynthesisMarkup, /data-tone="success">active<\/span>/);
assert.match(profileSynthesisMarkup, /Viewer access is read-only/);
assert.doesNotMatch(profileSynthesisMarkup, /sole source/i);

const analystMarkup = renderToStaticMarkup(
  createElement(SynthesisTrail, {
    trail,
    role: "analyst",
    onAcceptSourceRecord: () => undefined,
    onReject: () => undefined,
  }),
);
assert.doesNotMatch(
  analystMarkup,
  /<button[^>]*disabled=""[^>]*>.*Accept source record.*<\/button>/,
);
assert.doesNotMatch(analystMarkup, /Viewer access is read-only/);

const scarcityMarkup = renderToStaticMarkup(
  createElement(SynthesisTrail, {
    trail,
    confirmedScarcity: {
      confirmed: true,
      statement: "The airframe manufacturer confirms this approved replacement is exclusive.",
      authority: "Airframe manufacturer service bulletin",
      officialUrl: "https://manufacturer.example/service-bulletin/42",
      confirmedAt: "2026-08-25",
    },
  }),
);
assert.match(scarcityMarkup, /Confirmed source scarcity/);
assert.match(scarcityMarkup, /Confirmed sole source/);
assert.match(scarcityMarkup, /Airframe manufacturer service bulletin/);

const unconfirmedScarcityMarkup = renderToStaticMarkup(
  createElement(SynthesisTrail, {
    trail,
    confirmedScarcity: {
      confirmed: false,
      statement: "Unverified exclusivity claim",
      authority: "Reseller",
      officialUrl: "https://reseller.example/claim",
      confirmedAt: "2026-08-25",
    },
  }),
);
assert.doesNotMatch(unconfirmedScarcityMarkup, /sole source/i);
assert.doesNotMatch(unconfirmedScarcityMarkup, /Unverified exclusivity claim/);

const loadingMarkup = renderToStaticMarkup(
  createElement(SynthesisTrail, { trail: null, loading: true }),
);
assert.match(loadingMarkup, /aria-busy="true"/);
assert.match(loadingMarkup, /Loading source-backed synthesis/);

const errorMarkup = renderToStaticMarkup(
  createElement(SynthesisTrail, { trail: null, error: "Upstream timeout" }),
);
assert.match(errorMarkup, /role="alert"/);
assert.match(errorMarkup, /Upstream timeout/);

const emptyMarkup = renderToStaticMarkup(
  createElement(SynthesisTrail, { trail: null }),
);
assert.match(emptyMarkup, /No synthesis trail/);
assert.match(emptyMarkup, /Unknown values remain unknown/);
