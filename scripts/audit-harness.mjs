/**
 * Audit this adapter against the contracts the installed DeepSeek Harness
 * actually enforces, using the harness's own code rather than a copy of it.
 *
 * The interesting failures are not syntax errors: they are shape errors the
 * registry only reports at runtime, such as
 *   - `resolved.id !== model`            -> INVALID_MODEL_INFO
 *   - `contextWindow` not a positive int -> INVALID_MODEL_CONTEXT
 *   - a duplicate catalog id             -> INVALID_CATALOG
 *   - an unknown stream chunk            -> assertNever in AssistantStreamAccumulator
 * Each one throws away a whole turn, so they are checked here by feeding this
 * adapter's output through the harness's real normalizers.
 *
 * Usage: node scripts/audit-harness.mjs
 * Set DSH_LLM_PATH to point at a different @deepseek-ai/dsh-llm bundle. The
 * script exits 0 with SKIP when the harness is not installed on this machine,
 * so it stays safe to run in CI.
 */
import { existsSync } from "node:fs";

const DEFAULT_HARNESS =
  "C:\\Users\\Win\\AppData\\Local\\Programs\\DSH NEXT\\resources\\app\\node_modules\\@deepseek-ai\\dsh-llm\\lib\\index.js";
const harnessPath = process.env.DSH_LLM_PATH ?? DEFAULT_HARNESS;

if (!existsSync(harnessPath)) {
  console.log(`SKIP harness contract audit: ${harnessPath} not found`);
  process.exit(0);
}

const { MistralVibeAdapter, MODEL_CATALOGUE, RETIRED_MODEL_IDS } = await import("../lib/index.js");
const { LlmRuntime, AssistantStreamAccumulator, BlockAssembler } = await import(`file://${harnessPath}`);

const PROVIDER = "mistral-vibe";
const failures = [];
const checks = [];

async function check(name, run) {
  try {
    // Adapter lookups are async; an unawaited rejection would silently "pass".
    const detail = await run();
    checks.push(`PASS ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  } catch (error) {
    failures.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The registry methods are written against `this` and only touch a handful of
 * members, so the real implementations can run against a stub registry. Calling
 * the harness's own code keeps this audit honest.
 */
const registry = {
  registration: (provider) => ({ provider: { id: provider }, adapter }),
  normalizeModelInfo: LlmRuntime.prototype.normalizeModelInfo,
  detachedModalities: LlmRuntime.prototype.detachedModalities,
  listModels: LlmRuntime.prototype.listModels,
};

const adapter = new MistralVibeAdapter(() => ({
  apiKey: "audit-key-not-used",
  baseURL: "http://127.0.0.1:1/v1",
  disabledModels: [],
}));

// `listModels` on the registry needs a registered route; build one by hand so no
// context or fiber is required.
registry.adapters = new Map([[PROVIDER, { provider: { id: PROVIDER }, adapter }]]);

const catalogue = await adapter.listModels(PROVIDER);
const normalCatalog = await registry.listModels.call(registry, PROVIDER);

await check("listModels survives the registry's catalog validation", () => {
  const ids = new Set(normalCatalog.map((row) => row.id));
  if (ids.size !== normalCatalog.length) throw new Error("duplicate id");
  return `${normalCatalog.length} models`;
});

await check("every advertised model resolves under the registry's model validation", async () => {
  for (const row of catalogue) {
    const resolved = await adapter.resolveModel(PROVIDER, row.id);
    registry.normalizeModelInfo(registry.registration(PROVIDER), row.id, resolved);
  }
  return `${catalogue.length} models`;
});

await check("prepareCall's model info passes the same validation", async () => {
  for (const row of catalogue) {
    const prepared = await adapter.prepareCall(PROVIDER, row.id);
    registry.normalizeModelInfo(registry.registration(PROVIDER), row.id, prepared.model);
    if (typeof prepared.stream !== "function") throw new Error(`no stream for ${row.id}`);
  }
  return `${catalogue.length} models`;
});

await check("a retired alias resolves without breaking the exact-id rule", async () => {
  const aliases = Object.keys(RETIRED_MODEL_IDS);
  if (aliases.length === 0) throw new Error("RETIRED_MODEL_IDS is empty");
  for (const alias of aliases) {
    const resolved = await adapter.resolveModel(PROVIDER, alias);
    registry.normalizeModelInfo(registry.registration(PROVIDER), alias, resolved);
    if (resolved.id !== alias) throw new Error(`${alias} echoed id ${resolved.id}`);
    const prepared = await adapter.prepareCall(PROVIDER, alias);
    registry.normalizeModelInfo(registry.registration(PROVIDER), alias, prepared.model);
  }
  return `${aliases.length} aliases`;
});

await check("an unknown id still returns valid model metadata", async () => {
  const resolved = await adapter.resolveModel(PROVIDER, "not-a-real-model");
  registry.normalizeModelInfo(registry.registration(PROVIDER), "not-a-real-model", resolved);
});

await check("catalogue windows and output caps are inside the registry's accepted range", () => {
  for (const entry of MODEL_CATALOGUE) {
    if (!Number.isSafeInteger(entry.contextWindow) || entry.contextWindow <= 0) {
      throw new Error(`${entry.id} contextWindow ${entry.contextWindow}`);
    }
    if (!Number.isSafeInteger(entry.maxTokens) || entry.maxTokens <= 0) {
      throw new Error(`${entry.id} maxTokens ${entry.maxTokens}`);
    }
  }
  return `${MODEL_CATALOGUE.length} entries`;
});

await check("reasoning ladders have unique ids and a default inside the ladder", async () => {
  for (const row of catalogue) {
    const resolved = await adapter.resolveModel(PROVIDER, row.id);
    const reasoning = resolved.reasoning;
    if (reasoning === undefined) continue;
    const ids = reasoning.efforts.map((effort) => effort.id);
    if (new Set(ids).size !== ids.length) throw new Error(`${row.id} repeats an effort`);
    if (!ids.includes(reasoning.defaultEffort)) {
      throw new Error(`${row.id} default ${reasoning.defaultEffort} not in ${ids.join(",")}`);
    }
  }
});

await check("a streamed reply is made only of chunks the harness accepts", async () => {
  // The harness validates every chunk (safe index, string text, string id, a
  // string argumentsDelta, nothing after finish) and rejects an unknown type.
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const model = MODEL_CATALOGUE[0].id;
    const prepared = await adapter.prepareCall(PROVIDER, model);
    const assembler = new BlockAssembler();
    const accumulator = new AssistantStreamAccumulator();
    let time = 1_700_000_000_000;
    for await (const chunk of prepared.stream({ model, messages: [] })) {
      accumulator.push({ time, chunk });
      assembler.push(chunk);
      time += 1;
    }
    const message = assembler.message({ kind: "model", provider: PROVIDER, model });
    if (message === undefined) throw new Error("the assembler produced no message");
    // assembled() returns { blocks, usage, replayState }, not a bare array.
    const assembled = assembler.assembled();
    const blocks = assembled.blocks;
    if (!Array.isArray(blocks)) throw new Error("assembled() did not return blocks");
    const snapshot = accumulator.snapshot();
    if (snapshot === undefined) throw new Error("the accumulator produced no snapshot");
    return `${blocks.length} blocks`;
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const line of checks) console.log(line);
for (const line of failures) console.log(line);
console.log(
  failures.length === 0
    ? `\n${checks.length} harness-contract checks passed`
    : `\n${failures.length} of ${checks.length + failures.length} harness-contract checks failed`,
);
process.exit(failures.length === 0 ? 0 : 1);
