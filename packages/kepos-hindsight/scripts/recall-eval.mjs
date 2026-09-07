#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { HindsightClient } from "@vectorize-io/hindsight-client";

const VARIANTS = [
  { name: "baseline", types: ["observation", "world", "experience"], dedupe: false },
  { name: "observation", types: ["observation"], dedupe: false },
  { name: "observation_experience", types: ["observation", "experience"], dedupe: false },
  { name: "baseline_dedup", source: "baseline", dedupe: true },
  { name: "observation_experience_dedup", source: "observation_experience", dedupe: true },
  { name: "baseline_semantic", source: "baseline", requireSemantic: true, rank: "semantic" },
  { name: "baseline_semantic_035", source: "baseline", minSemantic: 0.35, rank: "semantic" },
  { name: "baseline_semantic_040", source: "baseline", minSemantic: 0.4, rank: "semantic" },
  { name: "observation_experience_semantic", source: "observation_experience", requireSemantic: true, rank: "semantic" }
];

function usage() {
  return `Usage: pnpm recall:eval -- --queries <file.json> [options]

Options:
  --bank <id>             Bank ID (default: yuki-memory)
  --config <path>         Hindsight config (default: ~/.hindsight/coding-agent.json)
  --budget <level>        low, mid, or high (default: low)
  --max-tokens <number>   Recall token budget (default: 900)
  --top-k <number>        Results retained per variant after dedupe (default: 3)
  --details               Include raw query and memory text in stdout

The default output contains hashes and aggregate metrics, not raw private text.`;
}

function parseArgs(argv) {
  const options = {
    bank: "yuki-memory",
    config: resolve(homedir(), ".hindsight", "coding-agent.json"),
    budget: "low",
    maxTokens: 900,
    topK: 3,
    details: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--details") options.details = true;
    else if (arg === "--queries") options.queries = argv[++index];
    else if (arg === "--bank") options.bank = argv[++index];
    else if (arg === "--config") options.config = argv[++index];
    else if (arg === "--budget") options.budget = argv[++index];
    else if (arg === "--max-tokens") options.maxTokens = positiveInteger(argv[++index], arg);
    else if (arg === "--top-k") options.topK = positiveInteger(argv[++index], arg);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["low", "mid", "high"].includes(options.budget)) {
    throw new Error(`Invalid budget: ${options.budget}`);
  }
  return options;
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} requires a positive integer`);
  return parsed;
}

function normalizeText(text) {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function dedupeResults(results) {
  const ids = new Set();
  const texts = new Set();
  return results.filter((result) => {
    const id = typeof result.id === "string" ? result.id : undefined;
    const text = normalizeText(result.text);
    if ((id && ids.has(id)) || texts.has(text)) return false;
    if (id) ids.add(id);
    texts.add(text);
    return true;
  });
}

function duplicateCount(results) {
  return results.length - dedupeResults(results).length;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeMarkers(value, field, caseId) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${caseId}.${field} must be an array`);
  return value.map((marker, index) => {
    if (typeof marker === "string" && marker.trim()) return { label: marker, terms: [marker] };
    if (!marker || typeof marker !== "object" || typeof marker.label !== "string" || !Array.isArray(marker.terms)) {
      throw new Error(`${caseId}.${field}[${index}] must be a string or { label, terms[] }`);
    }
    const terms = marker.terms.filter((term) => typeof term === "string" && term.trim());
    if (!terms.length) throw new Error(`${caseId}.${field}[${index}] has no terms`);
    return { label: marker.label, terms };
  });
}

function validateCases(input) {
  const cases = Array.isArray(input) ? input : input?.cases;
  if (!Array.isArray(cases) || !cases.length) throw new Error("Query file must contain a non-empty array or { cases: [...] }");
  const ids = new Set();
  return cases.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`cases[${index}] must be an object`);
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id : `case-${index + 1}`;
    if (ids.has(id)) throw new Error(`Duplicate case id: ${id}`);
    ids.add(id);
    if (typeof entry.query !== "string" || !entry.query.trim()) throw new Error(`${id}.query must be non-empty`);
    if (entry.queryTimestamp !== undefined && Number.isNaN(Date.parse(entry.queryTimestamp))) {
      throw new Error(`${id}.queryTimestamp must be an ISO date-time`);
    }
    return {
      id,
      query: entry.query.trim(),
      queryTimestamp: entry.queryTimestamp,
      recallExpected: entry.recallExpected !== false,
      gold: normalizeMarkers(entry.gold, "gold", id),
      unwanted: normalizeMarkers(entry.unwanted, "unwanted", id)
    };
  });
}

function markerHits(markers, results) {
  const texts = results.map((result) => normalizeText(result.text));
  return markers.map((marker) => ({
    label: marker.label,
    hit: marker.terms.some((term) => texts.some((text) => text.includes(normalizeText(term))))
  }));
}

function safeResult(result, details) {
  const text = normalizeText(result.text);
  return {
    idHash: typeof result.id === "string" ? hash(result.id) : undefined,
    type: result.type,
    finalScore: result.scores?.final,
    semanticScore: result.scores?.semantic,
    keywordScore: result.scores?.keyword,
    rerankerScore: result.scores?.reranker,
    mentionedAt: result.mentioned_at,
    occurredStart: result.occurred_start,
    documentIdHash: typeof result.document_id === "string" ? hash(result.document_id) : undefined,
    textHash: hash(text),
    textChars: text.length,
    ...(details ? { id: result.id, documentId: result.document_id, text } : {})
  };
}

async function recall(client, bank, testCase, variant, options) {
  const started = performance.now();
  const response = await client.recall(bank, testCase.query, {
    budget: options.budget,
    maxTokens: options.maxTokens,
    preferObservations: true,
    types: variant.types,
    queryTimestamp: testCase.queryTimestamp,
    includeEntities: false
  });
  return { results: response.results, latencyMs: performance.now() - started };
}

function summarizeVariant(variant, rawResults, latencyMs, testCase, options) {
  let candidates = variant.dedupe ? dedupeResults(rawResults) : rawResults;
  if (variant.requireSemantic) candidates = candidates.filter((result) => typeof result.scores?.semantic === "number");
  if (variant.minSemantic !== undefined) {
    candidates = candidates.filter((result) => typeof result.scores?.semantic === "number" && result.scores.semantic >= variant.minSemantic);
  }
  if (variant.rank === "semantic") {
    candidates = candidates.toSorted((left, right) => (right.scores?.semantic ?? -Infinity) - (left.scores?.semantic ?? -Infinity));
  }
  const results = candidates.slice(0, options.topK);
  const typeCounts = {};
  for (const result of results) {
    const type = result.type ?? "unknown";
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }
  return {
    name: variant.name,
    latencyMs: Math.round(latencyMs * 10) / 10,
    returned: rawResults.length,
    retained: results.length,
    exactDuplicates: duplicateCount(rawResults),
    retainedChars: results.reduce((sum, result) => sum + normalizeText(result.text).length, 0),
    typeCounts,
    gold: markerHits(testCase.gold, results),
    unwanted: markerHits(testCase.unwanted, results),
    recallExpected: testCase.recallExpected,
    results: results.map((result) => safeResult(result, options.details))
  };
}

function aggregate(cases) {
  const variants = {};
  for (const testCase of cases) {
    for (const variant of testCase.variants) {
      const aggregateVariant = variants[variant.name] ??= {
        queries: 0,
        latencyMs: [],
        returned: 0,
        retained: 0,
        exactDuplicates: 0,
        retainedChars: 0,
        goldHits: 0,
        goldTotal: 0,
        unwantedHits: 0,
        unwantedTotal: 0,
        unneededQueries: 0,
        unneededRetained: 0,
        unneededEmpty: 0
      };
      aggregateVariant.queries += 1;
      aggregateVariant.latencyMs.push(variant.latencyMs);
      aggregateVariant.returned += variant.returned;
      aggregateVariant.retained += variant.retained;
      aggregateVariant.exactDuplicates += variant.exactDuplicates;
      aggregateVariant.retainedChars += variant.retainedChars;
      if (variant.recallExpected) {
        aggregateVariant.goldHits += variant.gold.filter((item) => item.hit).length;
        aggregateVariant.goldTotal += variant.gold.length;
      }
      aggregateVariant.unwantedHits += variant.unwanted.filter((item) => item.hit).length;
      aggregateVariant.unwantedTotal += variant.unwanted.length;
      if (!variant.recallExpected) {
        aggregateVariant.unneededQueries += 1;
        aggregateVariant.unneededRetained += variant.retained;
        if (variant.retained === 0) aggregateVariant.unneededEmpty += 1;
      }
    }
  }
  return Object.fromEntries(Object.entries(variants).map(([name, value]) => {
    const sortedLatency = value.latencyMs.toSorted((left, right) => left - right);
    return [name, {
      queries: value.queries,
      meanReturned: value.returned / value.queries,
      meanRetained: value.retained / value.queries,
      exactDuplicates: value.exactDuplicates,
      meanRetainedChars: value.retainedChars / value.queries,
      goldRecall: value.goldTotal ? value.goldHits / value.goldTotal : null,
      unwantedHitRate: value.unwantedTotal ? value.unwantedHits / value.unwantedTotal : null,
      meanResultsWhenRecallUnneeded: value.unneededQueries ? value.unneededRetained / value.unneededQueries : null,
      correctEmptyRateWhenRecallUnneeded: value.unneededQueries ? value.unneededEmpty / value.unneededQueries : null,
      p50LatencyMs: percentile(sortedLatency, 0.5),
      p95LatencyMs: percentile(sortedLatency, 0.95)
    }];
  }));
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.queries) throw new Error(`--queries is required\n\n${usage()}`);
  const [configText, queryText] = await Promise.all([
    readFile(options.config, "utf8"),
    readFile(resolve(options.queries), "utf8")
  ]);
  const config = JSON.parse(configText);
  const testCases = validateCases(JSON.parse(queryText));
  const client = new HindsightClient({
    baseUrl: config.apiUrl ?? "https://api.hindsight.vectorize.io",
    ...(config.apiToken ? { apiKey: config.apiToken } : {})
  });
  const version = await client.getVersion();
  const evaluatedCases = [];
  for (const testCase of testCases) {
    const recalled = {};
    for (const variant of VARIANTS.filter((entry) => !entry.source)) {
      recalled[variant.name] = await recall(client, options.bank, testCase, variant, options);
    }
    const variants = VARIANTS.map((variant) => {
      const source = recalled[variant.source ?? variant.name];
      return summarizeVariant(variant, source.results, source.latencyMs, testCase, options);
    });
    evaluatedCases.push({
      id: testCase.id,
      queryHash: hash(testCase.query),
      ...(options.details ? { query: testCase.query } : {}),
      variants
    });
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    serverVersion: version.api_version,
    bank: options.bank,
    privacy: options.details ? "raw text included by explicit --details" : "raw query and memory text omitted",
    settings: { budget: options.budget, maxTokens: options.maxTokens, topK: options.topK },
    aggregate: aggregate(evaluatedCases),
    cases: evaluatedCases
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
