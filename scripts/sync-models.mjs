#!/usr/bin/env node
/**
 * Regenerate `MODEL_CATALOGUE` in lib/index.js from the models.dev catalogue.
 *
 *   node scripts/sync-models.mjs            # fetch https://models.dev/api.json
 *   node scripts/sync-models.mjs api.json   # use a local copy
 *
 * models.dev is the maintained mirror of Mistral's model catalogue: it carries
 * the wire id, display name, context/output limits, whether the model accepts
 * attachments, and the exact `reasoning_effort` values the provider accepts.
 * Mistral's own documentation page lists the same models with prose, so the
 * machine-readable mirror is the better source for a generated block.
 *
 * Deprecated ids, embeddings and audio-only endpoints are skipped: the harness
 * route answers chat completions, and anything Mistral still serves but this
 * list misses is picked up at runtime by "Fetch models".
 */
import fs from "node:fs";
import path from "node:path";

const API = "https://models.dev/api.json";
const root = path.resolve(import.meta.dirname, "..");
const indexPath = path.join(root, "lib", "index.js");
const BEGIN = "// <catalogue:begin>";
const END = "// <catalogue:end>";

const local = process.argv[2];
let payload;
if (local !== undefined) {
  payload = JSON.parse(fs.readFileSync(path.resolve(local), "utf8"));
} else {
  const response = await fetch(API, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
  payload = await response.json();
}

const provider = payload.mistral;
if (provider === undefined || provider.models === undefined) {
  throw new Error("models.dev payload has no `mistral` provider");
}

/**
 * models.dev marks a non-chat record with its own `type` (`embedding`,
 * `speech`, `transcription`); chat records carry no `type` at all. Matching id
 * fragments (embed/ocr/tts) only guessed at that, so read the field instead.
 */
function isChatModel(model) {
  return model.type === undefined || model.type === "chat";
}

/** The real modality list. `attachment` is not it: it is also true for pdf/audio. */
function acceptsImages(model) {
  return Array.isArray(model.modalities?.input) && model.modalities.input.includes("image");
}

/** Map models.dev effort values onto the harness thinking levels. */
function levelsOf(model) {
  const option = Array.isArray(model.reasoning_options)
    ? model.reasoning_options.find((entry) => entry?.type === "effort")
    : undefined;
  if (model.reasoning !== true || option === undefined || !Array.isArray(option.values)) return undefined;
  const levels = option.values.map((value) => (value === "none" ? "off" : value));
  return levels.length === 0 ? undefined : levels;
}

const rows = Object.values(provider.models)
  .filter((model) => {
    if (model.status === "deprecated") return false;
    if (!isChatModel(model)) return false;
    if (!Number.isSafeInteger(model.limit?.context) || model.limit.context <= 0) return false;
    return true;
  })
  .sort((a, b) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")))
  .map((model) => {
    const levels = levelsOf(model);
    return {
      id: model.id,
      name: model.name,
      contextWindow: model.limit.context,
      maxTokens: Number.isSafeInteger(model.limit.output) && model.limit.output > 0 ? model.limit.output : 32768,
      image: acceptsImages(model),
      cost:
        Number.isFinite(model.cost?.input) && Number.isFinite(model.cost?.output)
          ? { input: model.cost.input, output: model.cost.output }
          : undefined,
      ...(levels === undefined
        ? {}
        : { levels, wire: Object.fromEntries(levels.map((level) => [level, level === "off" ? "none" : level])) }),
      ...(model.status === "beta" ? { beta: true } : {}),
    };
  });

if (rows.length === 0) throw new Error("models.dev returned no usable Mistral chat models");

// models.dev lists an alias beside the model it names (`mistral-medium-latest`
// and `mistral-medium-2604` are one model). The picker shows one row per model,
// so the alias is dropped from the catalogue and kept as a redirect: a session
// that selected it still resolves to the dated entry.
const ids = rows.map((row) => row.id);
const retired = new Map();
for (const id of ids) {
  if (!id.endsWith("-latest")) continue;
  const base = id.slice(0, -"-latest".length);
  const dated = ids.find((other) => other !== id && other.startsWith(`${base}-`) && /-\d{4}$/.test(other));
  if (dated !== undefined) retired.set(id, dated);
}
const kept = rows.filter((row) => !retired.has(row.id));

const body = kept
  .map((row) => {
    const lines = [
      "  {",
      `    id: ${JSON.stringify(row.id)},`,
      `    name: ${JSON.stringify(row.name)},`,
      `    contextWindow: ${row.contextWindow},`,
      `    maxTokens: ${row.maxTokens},`,
    ];
    if (row.image) lines.push("    image: true,");
    if (row.cost !== undefined) lines.push(`    cost: ${JSON.stringify(row.cost)},`);
    if (row.beta) lines.push("    beta: true,");
    if (row.levels !== undefined) {
      lines.push(`    levels: ${JSON.stringify(row.levels)},`);
      lines.push(`    wire: ${JSON.stringify(row.wire)},`);
    }
    lines.push("  },");
    return lines.join("\n");
  })
  .join("\n");

const source = fs.readFileSync(indexPath, "utf8");
const begin = source.indexOf(BEGIN);
const end = source.indexOf(END, begin);
if (begin < 0 || end < 0) throw new Error("catalogue markers are missing from lib/index.js");

const head = source.slice(0, begin);
const tail = source.slice(end);
const block = [
  BEGIN,
  `// Generated from ${API} (provider "mistral") by scripts/sync-models.mjs.`,
  "// Deprecated ids, embeddings and audio endpoints are excluded; anything else",
  '// Mistral serves is added at runtime by "Fetch models".',
  "export const MODEL_CATALOGUE = [",
  body,
  "];",
  "",
  "/**",
  " * Ids models.dev still lists beside the dated model they alias. The catalogue",
  " * ships one row per model, so a session that selected the `-latest` id",
  " * redirects to the dated entry instead of losing its model.",
  " */",
  "export const RETIRED_MODEL_IDS = {",
  ...[...retired].map(([alias, dated]) => `  ${JSON.stringify(alias)}: ${JSON.stringify(dated)},`),
  "};",
  "",
].join("\n");

fs.writeFileSync(indexPath, `${head}${block}${tail}`);
console.log(`wrote ${kept.length} models to lib/index.js`);
for (const [alias, dated] of retired) console.log(`  alias ${alias} -> ${dated}`);
for (const row of kept) {
  const level = row.levels === undefined ? "no reasoning" : row.levels.join("/");
  console.log(`  ${row.id.padEnd(28)} ctx=${String(row.contextWindow).padEnd(8)} out=${String(row.maxTokens).padEnd(7)} ${level}`);
}
