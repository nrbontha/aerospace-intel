import { fetchWebsiteEvidence } from "../packages/research/src/enrichment/website.js";
import { checkAcquisitionHistory } from "../packages/research/src/enrichment/ownership.js";

const apiKey = process.env.EXA_API_KEY ?? "";
const web = await fetchWebsiteEvidence(
  apiKey,
  "zephyrintl.com",
  "Zephyr International LLC",
);
console.log(
  "WEB:",
  web.websiteOffering,
  "pages:",
  web.fetchesSucceeded,
  "cost:",
  web.costUsd,
);
const own = await checkAcquisitionHistory(apiKey, "Dart Aerospace");
console.log(
  "OWN:",
  own.status,
  "|",
  own.owner,
  "|",
  own.year,
  "|",
  (own.excerpt || "").slice(0, 120),
);
