/**
 * Mistral Vibe for DeepSeek Harness.
 *
 * A self-contained LLM adapter for Mistral La Plateforme. It owns one route
 * (`mistral-vibe`), its own model catalogue, and its own wire implementation, so
 * it does not depend on any other plugin, on the shipped pi-ai catalogue
 * version, or on `@deepseek-ai/dsh-llm` at import time.
 *
 * Design notes:
 * - Reasoning levels follow Mistral Vibe's `written_reasoning_levels` contract:
 *   a level set that can be turned off advertises `off` plus the remaining
 *   levels lowest-first, and a level set without `off` starts at its own lowest
 *   level (Vibe then reports that lowest level as the default).
 * - `off` is sent as `reasoning_effort: "none"`; a model that has no `off`
 *   simply never receives the parameter for that level.
 * - Every provider request carries the harness attribution User-Agent, as the
 *   `LlmAdapter` contract requires.
 */


import { createHash } from "node:crypto";
import Schema from "../vendor/schemastery.mjs";
import { isVolatile } from "../vendor/cosmokit.mjs";

const ENTRY_ID = "llm-mistral-vibe";
const PROVIDER = "mistral-vibe";
const DISPLAY_NAME = "Mistral Vibe";
const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_API_KEY_ENV = "MISTRAL_API_KEY";
const STUDIO_KEY_ENV = "MISTRAL_STUDIO_API_KEY";
const ACCESS_TOKEN_ENV = "MISTRAL_VIBE_ACCESS_TOKEN";
/**
 * Where the thinking ladders come from.
 *
 * `/v1/models` says whether a model reasons, never which `reasoning_effort`
 * values it accepts, and guessing a ladder would send an effort the model may
 * reject. models.dev publishes the exact effort list per model, so a discovered
 * row borrows its ladder from there. Deprecated rows are still read: Mistral
 * serves them, models.dev simply marks them.
 */
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000;
const MODELS_DEV = { at: 0, models: new Map() };

/**
 * Map models.dev effort values onto this route's thinking levels.
 *
 * models.dev publishes the ladder as `reasoning_options: [{type: "effort",
 * values: [...]}]`; the values are whatever that model accepts, in order, and
 * `none` is this route's `off`. Nothing here is a fixed list.
 */
export function levelsOf(modelsDevModel) {
  const options = Array.isArray(modelsDevModel?.reasoning_options) ? modelsDevModel.reasoning_options : [];
  const option = options.find((entry) => entry?.type === "effort");
  if (modelsDevModel?.reasoning !== true || option === undefined || !Array.isArray(option.values)) {
    return undefined;
  }
  const levels = option.values
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => (value === "none" ? "off" : value));
  return levels.length === 0 ? undefined : levels;
}

/**
 * Everything this route needs from one models.dev record, read from the record's
 * own fields:
 *
 * - `type` is present only on non-chat models (`embedding`, `speech`,
 *   `transcription`), so its absence is what makes a row chattable — far more
 *   reliable than matching id fragments.
 * - `modalities.input` is the real modality list. `attachment: true` is *not*
 *   the same thing: a pdf- or audio-only model also sets it.
 * - `limit.context` / `limit.output` are the windows, `0` meaning unknown.
 * - `reasoning` plus `reasoning_options` give the ladder.
 */
export function modelsDevFacts(model) {
  if (model === null || typeof model !== "object") return undefined;
  const input = Array.isArray(model.modalities?.input) ? model.modalities.input : [];
  const context = Number.isSafeInteger(model.limit?.context) && model.limit.context > 0 ? model.limit.context : undefined;
  const output = Number.isSafeInteger(model.limit?.output) && model.limit.output > 0 ? model.limit.output : undefined;
  return {
    chat: model.type === undefined || model.type === "chat",
    name: typeof model.name === "string" && model.name.length > 0 ? model.name : undefined,
    contextWindow: context,
    maxTokens: output,
    vision: input.includes("image"),
    reasoning: model.reasoning === true,
    levels: levelsOf(model),
    deprecated: model.status === "deprecated",
  };
}

/** The mistral lobe of models.dev, cached for a few hours. */
async function modelsDevModels(signal) {
  if (Date.now() - MODELS_DEV.at < MODELS_DEV_TTL_MS && MODELS_DEV.models.size > 0) {
    return MODELS_DEV.models;
  }
  const response = await fetch(process.env.MISTRAL_MODELS_DEV_URL ?? MODELS_DEV_URL, {
    method: "GET",
    headers: { "user-agent": ATTRIBUTION_UA, accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`models.dev answered HTTP ${response.status}`);
  const payload = await response.json();
  const models = payload?.mistral?.models;
  if (models === null || typeof models !== "object") throw new Error("models.dev has no mistral provider");
  MODELS_DEV.models = new Map(Object.entries(models));
  MODELS_DEV.at = Date.now();
  return MODELS_DEV.models;
}

/**
 * Fill the thinking ladder (and any missing name or limit) of discovered rows
 * from models.dev. A model models.dev does not know keeps an unknown ladder: the
 * row then advertises reasoning without a level control, which is honest and
 * never sends an unsupported effort.
 *
 * `options.modalities === false` leaves `inputModalities` alone. The re-enrich
 * pass over the merged list uses it: models.dev's modality record can lag the
 * provider (deepseek-v4-1-flash-1017 was text-only there while Mistral already
 * served vision), so a ladder refresh must not silently downgrade a model that
 * this route already advertises with images.
 */
export async function enrichFromModelsDev(rows, signal, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  let models;
  try {
    models = await modelsDevModels(signal);
  } catch {
    // Offline, or models.dev is down: the rows stay as the API described them.
    return rows;
  }
  const modalities = options.modalities !== false;
  for (const row of rows) {
    const facts = modelsDevFacts(models.get(row.id));
    if (facts === undefined) continue;
    if (facts.chat === false) {
      // models.dev calls this an embedding / speech / transcription model: it
      // cannot answer a chat turn, whatever the API row implied.
      row.chat = false;
      continue;
    }
    if (facts.levels !== undefined) {
      row.levels = facts.levels;
      row.reasoning = true;
    } else if (facts.reasoning === true) {
      row.reasoning = true;
    }
    if (facts.name !== undefined && row.name === row.id) row.name = facts.name;
    // models.dev is the curated record for this provider, so its windows win over
    // the generic defaults a persisted id was rehydrated with.
    if (facts.contextWindow !== undefined) row.contextWindow = facts.contextWindow;
    if (facts.maxTokens !== undefined) row.maxTokens = facts.maxTokens;
    if (!modalities) continue;
    if (facts.vision === true) {
      row.inputModalities = ["text", "image"];
    } else if (Array.isArray(row.inputModalities) && row.inputModalities.includes("image")) {
      // The API row claimed vision, models.dev's modality list disagrees.
      row.inputModalities = ["text"];
    }
  }
  return rows;
}

const ATTRIBUTION_UA =
  "deepseek-harness/0.2.2 (+https://github.com/deepseek-ai/deepseek-harness)";

/** Canonical thinking levels, escalation order. Mirrors Vibe's THINKING_LEVELS. */
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const LEVEL_NAMES = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const LEVEL_DESCRIPTIONS = {
  off: "Ask for no reasoning trace (reasoning_effort: none).",
  low: "Fastest reasoning budget (reasoning_effort: low).",
  medium: "Balanced reasoning budget (reasoning_effort: medium).",
  high: "Deepest reasoning budget (reasoning_effort: high).",
  max: "Highest published reasoning budget (reasoning_effort: max).",
};

/**
 * The Vibe-facing Mistral catalogue.
 *
 * `levels` lists the selectable thinking levels for the model, `wire` maps each
 * level onto the `reasoning_effort` value Mistral accepts. Models without
 * `levels` do not expose a reasoning control at all. `image` marks a model that
 * accepts attachments: the harness projects an image to a text placeholder
 * unless the model advertises the `image` input modality, so a missing flag
 * silently disables vision rather than failing loudly.
 */
// <catalogue:begin>
// Generated from https://models.dev/api.json (provider "mistral") by scripts/sync-models.mjs.
// Deprecated ids, embeddings and audio endpoints are excluded; anything else
// Mistral serves is added at runtime by "Fetch models".
export const MODEL_CATALOGUE = [
  {
    id: "deepseek-v4-1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017",
    contextWindow: 1048576,
    maxTokens: 128000,
    image: true,
    cost: {"input":0.3,"output":1.2},
    levels: ["off","low","high","max"],
    wire: {"off":"none","low":"low","high":"high","max":"max"},
  },
  {
    id: "mistral-large-4",
    name: "Mistral Large 4",
    contextWindow: 1048576,
    maxTokens: 262144,
    image: true,
    cost: {"input":0.7,"output":2.1},
    beta: true,
    levels: ["low","medium","high"],
    wire: {"low":"low","medium":"medium","high":"high"},
  },
  {
    id: "mistral-large-4-0-8",
    name: "Mistral Large 4.0.8",
    contextWindow: 1048576,
    maxTokens: 262144,
    image: true,
    cost: {"input":0.7,"output":2.1},
    beta: true,
    levels: ["low","medium","high"],
    wire: {"low":"low","medium":"medium","high":"high"},
  },
  {
    id: "zai-glm-5-3-flash",
    name: "GLM-5.3-Flash",
    contextWindow: 1048576,
    maxTokens: 131072,
    image: true,
    cost: {"input":0.15,"output":0.5},
    levels: ["low","high","max"],
    wire: {"low":"low","high":"high","max":"max"},
  },
  {
    id: "zai-glm-5-3",
    name: "GLM-5.3",
    contextWindow: 1048576,
    maxTokens: 131072,
    cost: {"input":1.4,"output":4.4},
    levels: ["low","high","max"],
    wire: {"low":"low","high":"high","max":"max"},
  },
  {
    id: "mistral-medium-2604",
    name: "Mistral Medium 3.5",
    contextWindow: 262144,
    maxTokens: 262144,
    image: true,
    cost: {"input":1.5,"output":7.5},
    levels: ["off","high"],
    wire: {"off":"none","high":"high"},
  },
  {
    id: "mistral-small-2603",
    name: "Mistral Small 4",
    contextWindow: 262144,
    maxTokens: 256000,
    image: true,
    cost: {"input":0.15,"output":0.6},
    levels: ["off","high"],
    wire: {"off":"none","high":"high"},
  },
  {
    id: "ministral-8b-2512",
    name: "Ministral 3 8B",
    contextWindow: 262144,
    maxTokens: 262144,
    image: true,
    cost: {"input":0.15,"output":0.15},
  },
  {
    id: "ministral-14b-2512",
    name: "Ministral 3 14B",
    contextWindow: 262144,
    maxTokens: 262144,
    image: true,
    cost: {"input":0.2,"output":0.2},
  },
  {
    id: "ministral-3b-2512",
    name: "Ministral 3 3B",
    contextWindow: 131072,
    maxTokens: 262144,
    image: true,
    cost: {"input":0.1,"output":0.1},
  },
  {
    id: "codestral-2508",
    name: "Codestral 25.08",
    contextWindow: 256000,
    maxTokens: 8192,
    cost: {"input":0.3,"output":0.9},
  },
  {
    id: "voxtral-small-2507",
    name: "Voxtral Small",
    contextWindow: 32768,
    maxTokens: 32000,
    cost: {"input":0.1,"output":0.4},
  },
  {
    id: "mistral-large-2512",
    name: "Mistral Large 3",
    contextWindow: 262144,
    maxTokens: 262144,
    image: true,
    cost: {"input":0.5,"output":1.5},
  },
];

/**
 * Ids models.dev still lists beside the dated model they alias. The catalogue
 * ships one row per model, so a session that selected the `-latest` id
 * redirects to the dated entry instead of losing its model.
 */
export const RETIRED_MODEL_IDS = {
  "mistral-medium-latest": "mistral-medium-2604",
  "mistral-small-latest": "mistral-small-2603",
  "voxtral-small-latest": "voxtral-small-2507",
  "mistral-large-latest": "mistral-large-2512",
  "ministral-3b-latest": "ministral-3b-2512",
  "ministral-8b-latest": "ministral-8b-2512",
  "codestral-latest": "codestral-2508",
};
// <catalogue:end>

const CATALOGUE_BY_ID = new Map(MODEL_CATALOGUE.map((entry) => [entry.id, entry]));

/**
 * The catalogue id an id names, directly or through an alias, or `undefined`
 * when the shipped catalogue does not serve it.
 */
function catalogueIdOf(id) {
  if (CATALOGUE_BY_ID.has(id)) return id;
  const dated = RETIRED_MODEL_IDS[id];
  return dated !== undefined && CATALOGUE_BY_ID.has(dated) ? dated : undefined;
}

/**
 * What a live `/v1/models` read said about a catalogue id's vision capability.
 *
 * The catalogue is a build-time snapshot of models.dev, so it can only be as
 * fresh as the last release. `/v1/models` is the provider answering for itself,
 * and its `capabilities.vision` is what actually governs the request, so a
 * discovery read overrides the snapshot in both directions: it adds images to a
 * model models.dev still calls text-only, and it drops them from one the
 * provider no longer serves with vision.
 *
 * Only a row a discovery read wrote carries `visionFromApi`; a list saved by an
 * older bundle has no such field, so upgrading the bundle is never undone by a
 * stale store.
 */
const API_VISION = new Map();

/**
 * Record the vision flags a `/v1/models` read reported for catalogue ids.
 *
 * Aliases of one model are one answer: a `true` from any of them wins, which is
 * the direction that keeps a working capability instead of hiding it.
 */
function rememberApiVision(entries) {
  const seen = new Map();
  for (const entry of entries) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) continue;
    const id = catalogueIdOf(entry.id);
    if (id === undefined) continue;
    const flag = entry?.capabilities?.vision;
    if (typeof flag !== "boolean") continue;
    const previous = seen.get(id);
    seen.set(id, previous === true || flag === true);
  }
  for (const [id, vision] of seen) API_VISION.set(id, vision);
}

/**
 * Metadata for models a live `/v1/models` read reported but the built-in
 * catalogue does not know. The ids are persisted in the row config
 * (`discoveredModels`), the richer metadata only lives for the process, so a
 * model released after this bundle still resolves to a usable entry.
 */
const DISCOVERED = new Map();

/** Record the metadata of the rows a discovery read returned. */
export function rememberDiscovered(rows) {
  if (!Array.isArray(rows)) return [];
  const extras = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    if (isCatalogueId(row.id)) continue;
    const reasoning = row.reasoning === true;
    const entry = {
      id: row.id,
      name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.id,
      contextWindow:
        Number.isSafeInteger(row.contextWindow) && row.contextWindow > 0 ? row.contextWindow : 262144,
      maxTokens: Number.isSafeInteger(row.maxTokens) && row.maxTokens > 0 ? row.maxTokens : 32768,
      vision: Array.isArray(row.inputModalities) && row.inputModalities.includes("image"),
      reasoning,
      ...(Array.isArray(row.levels) && row.levels.length > 0 ? { levels: row.levels } : {}),
    };
    DISCOVERED.set(entry.id, entry);
    extras.push(entry.id);
  }
  return extras;
}

/**
 * Ids that cannot answer a chat turn: embeddings, OCR, moderation, and the
 * transcription / speech / fill-in-the-middle families all live under
 * `/v1/models` beside the chat models, so the picker filters them out by id
 * whenever the endpoint does not declare `capabilities.completion_chat`.
 */
const NON_CHAT_ID = /(embed|moderation|ocr|tts|transcribe|realtime|fim|whisper)/i;

export function isChatModelId(id) {
  return typeof id === "string" && id.length > 0 && !NON_CHAT_ID.test(id);
}

/** True when the shipped catalogue already serves this id (directly or by redirect). */
function isCatalogueId(id) {
  return catalogueIdOf(id) !== undefined;
}

/** The metadata a previous discovery read persisted for this row. */
function persistedInfo(settings) {
  const raw = typeof settings.discoveredInfo === "string" ? settings.discoveredInfo : "";
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A hand-edited row with broken JSON must not take the Models page down.
    return {};
  }
}

/** Rows resolved from the last stored list, so an id lookup needs no settings. */
const STORED = new Map();

/** Remember a model row for id lookups that run outside a settings closure. */
export function rememberStoredRow(row) {
  if (row === null || typeof row !== "object") return;
  if (typeof row.id !== "string" || row.id.length === 0) return;
  const catalogueId = catalogueIdOf(row.id);
  if (catalogueId !== undefined) {
    // A discovery read wrote this row, so its modality is the provider's own
    // answer rather than the build-time snapshot's.
    if (typeof row.visionFromApi === "boolean") API_VISION.set(catalogueId, row.visionFromApi);
    return;
  }
  STORED.set(row.id, {
    id: row.id,
    name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.id,
    contextWindow:
      Number.isSafeInteger(row.contextWindow) && row.contextWindow > 0 ? row.contextWindow : 262144,
    maxTokens: Number.isSafeInteger(row.maxTokens) && row.maxTokens > 0 ? row.maxTokens : 32768,
    vision: Array.isArray(row.inputModalities) && row.inputModalities.includes("image"),
    reasoning: row.reasoning === true,
    ...(Array.isArray(row.levels) && row.levels.length > 0 ? { levels: row.levels } : {}),
  });
}

/**
 * The whole model list a previous fetch stored.
 *
 * One list, not a delta: the built-in catalogue is only a bootstrap for a row
 * that has never fetched, so a model Mistral serves stays in the picker after a
 * restart instead of requiring another fetch.
 */
export function storedModels(settings) {
  const raw = typeof settings?.modelsJson === "string" ? settings.modelsJson : "";
  if (raw.length === 0) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const rows = [];
  const seen = new Set();
  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    if (typeof row.id !== "string" || row.id.length === 0 || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    rememberStoredRow(row);
  }
  return rows.length === 0 ? undefined : rows;
}

/** A persisted discovered entry as a page row. */
function entryToRow(entry) {
  return {
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    inputModalities: entry.vision === true ? ["text", "image"] : ["text"],
    reasoning: entry.reasoning === true || (Array.isArray(entry.levels) && entry.levels.length > 0),
    ...(Array.isArray(entry.levels) && entry.levels.length > 0 ? { levels: entry.levels } : {}),
    discovered: true,
  };
}

/** The shipped catalogue as page rows. */
function catalogueRows(adapter) {
  return MODEL_CATALOGUE.map((entry) => ({
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    inputModalities: modalitiesFor(entry, adapter.ctx),
    reasoning: Array.isArray(entry.levels) && entry.levels.length > 0,
    ...(Array.isArray(entry.levels) && entry.levels.length > 0 ? { levels: entry.levels } : {}),
    ...(API_VISION.has(entry.id) ? { visionFromApi: API_VISION.get(entry.id) } : {}),
    discovered: false,
  }));
}

/** The discovered ids this row should keep advertising, newest first. */
function discoveredEntries(settings) {
  const persisted = Array.isArray(settings.discoveredModels) ? settings.discoveredModels : [];
  const saved = persistedInfo(settings);
  const ids = [...persisted, ...DISCOVERED.keys()];
  const seen = new Set();
  const entries = [];
  for (const id of ids) {
    if (!isChatModelId(id) || seen.has(id) || isCatalogueId(id)) continue;
    seen.add(id);
    const memory = DISCOVERED.get(id);
    const stored = saved[id];
    entries.push(
      memory ??
        (stored !== null && typeof stored === "object"
          ? {
              id,
              name: typeof stored.name === "string" && stored.name.length > 0 ? stored.name : id,
              contextWindow:
                Number.isSafeInteger(stored.contextWindow) && stored.contextWindow > 0 ? stored.contextWindow : 262144,
              maxTokens: Number.isSafeInteger(stored.maxTokens) && stored.maxTokens > 0 ? stored.maxTokens : 32768,
              vision: stored.vision === true,
              reasoning: stored.reasoning === true,
              ...(Array.isArray(stored.levels) && stored.levels.length > 0 ? { levels: stored.levels } : {}),
            }
          : {
              id,
              name: id,
              contextWindow: 262144,
              maxTokens: 32768,
            }),
    );
  }
  return entries;
}

/** Description shown for a route before any model is chosen. */
function catalogueEntry(modelId) {
  const known =
    CATALOGUE_BY_ID.get(modelId) ?? CATALOGUE_BY_ID.get(RETIRED_MODEL_IDS[modelId] ?? modelId);
  if (known !== undefined) return known;
  const discovered = DISCOVERED.get(modelId) ?? STORED.get(modelId);
  if (discovered !== undefined) return discovered;
  return {
    id: modelId,
    name: modelId,
    contextWindow: 262144,
    maxTokens: 32768,
  };
}

/**
 * The context window the registry will accept, or the conservative default.
 *
 * normalizeModelInfo rejects a non-integer or non-positive window
 * (INVALID_MODEL_CONTEXT), so a catalogue row with a bad number must not reach
 * it: the route would answer every resolve with an error instead of a model.
 */
function modelContextWindow(entry) {
  const window = entry?.contextWindow;
  if (Number.isSafeInteger(window) && window > 0) return window;
  return 131072;
}

/** The default output cap, inside the registry's 1..65536 range. */
function modelMaxTokens(entry) {
  const maxTokens = entry?.maxTokens;
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) return Math.min(maxTokens, 65536);
  return 8192;
}

/** The attachment service, read without touching an inject-gated property. */
function attachmentsOf(ctx) {
  if (ctx === undefined || ctx === null) return undefined;
  if (typeof ctx.get === "function") {
    const found = ctx.get("attachments");
    if (found !== undefined) return found;
  }
  try {
    return ctx.attachments;
  } catch {
    return undefined;
  }
}

/**
 * Input modalities to advertise for a model.
 *
 * A model only gets `image` when this route can actually turn the durable
 * attachment back into bytes (`readImageRequest`). Advertising an image
 * modality without that read would hand the model a message whose image was
 * silently dropped, which fails worse than the harness' own text placeholder.
 */
function modalitiesFor(entry, ctx) {
  // A discovery read's answer outranks the build-time snapshot; a discovered
  // row carries its own `vision` flag instead of the catalogue's `image` one.
  const image = API_VISION.has(entry.id)
    ? API_VISION.get(entry.id)
    : entry.image === true || entry.vision === true;
  if (!image) return ["text"];
  const attachments = attachmentsOf(ctx);
  return typeof attachments?.readImageRequest === "function" ? ["text", "image"] : ["text"];
}

/** Request-image budget the route asks the attachment service for. */
const IMAGE_REQUEST_TARGET = { width: 1568, height: 1568, maxBytes: 4 * 1024 * 1024 };

/**
 * Build an Error carrying the adapter-failure snapshot the harness trusts.
 *
 * `normalizeLlmFailure` accepts a foreign error's own `failure` only when it
 * agrees with the error's own `code`, so both are set here.
 */
function mistralFailure(message, code, extra) {
  const error = new Error(message);
  error.code = code;
  error.failure = {
    message,
    code,
    ...extra === undefined ? {} : extra,
  };
  return error;
}

/**
 * Last rate-limit observations, filled from response headers.
 *
 * Mistral answers with two independent budgets per response: requests
 * (`ratelimit-limit` / `-remaining` / `-reset`, sometimes mirrored as
 * `x-ratelimit-*-requests`) and tokens (`x-ratelimit-limit-tokens` /
 * `-remaining-tokens` / `-reset-tokens`). They are enforced independently, and
 * a `429` carries `Retry-After`. Capturing them costs nothing and turns every
 * ordinary request into a quota reading.
 */
const LIMITS = {
  rpm: { limit: undefined, remaining: undefined, resetAt: undefined },
  tpm: { limit: undefined, remaining: undefined, resetAt: undefined },
  retryAfterSeconds: undefined,
  status: undefined,
  at: undefined,
  source: undefined,
};

/** A rate-limit reset may be an epoch second, or seconds from now. */
function resetInstant(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  // Epoch seconds for any date after 1973 are far above a one-month delta.
  return seconds > 1e7 ? seconds * 1000 : Date.now() + seconds * 1000;
}

function headerValue(headers, name) {
  if (headers === undefined || headers === null) return undefined;
  const direct = typeof headers.get === "function" ? headers.get(name) : undefined;
  if (direct !== undefined && direct !== null) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function readBudget(headers, limitName, remainingName, resetName, altLimitName, altRemainingName, altResetName) {
  const limit = headerValue(headers, limitName) ?? headerValue(headers, altLimitName);
  const remaining = headerValue(headers, remainingName) ?? headerValue(headers, altRemainingName);
  const reset = headerValue(headers, resetName) ?? headerValue(headers, altResetName);
  if (limit === undefined && remaining === undefined && reset === undefined) return undefined;
  return {
    limit: limit === undefined ? undefined : Number(limit),
    remaining: remaining === undefined ? undefined : Number(remaining),
    resetAt: resetInstant(reset),
  };
}

/** Record whatever quota headers a Mistral response carried. */
export function captureLimits(headers, source) {
  if (headers === undefined || headers === null) return LIMITS;
  const rpm = readBudget(
    headers,
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
  );
  const tpm = readBudget(
    headers,
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
    "ratelimit-limit-tokens",
    "ratelimit-remaining-tokens",
    "ratelimit-reset-tokens",
  );
  if (rpm === undefined && tpm === undefined) return LIMITS;
  if (rpm !== undefined) LIMITS.rpm = rpm;
  if (tpm !== undefined) LIMITS.tpm = tpm;
  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    LIMITS.retryAfterSeconds = Number.isFinite(seconds) ? seconds : undefined;
  }
  LIMITS.source = source;
  LIMITS.at = new Date().toISOString();
  return LIMITS;
}

/** A serialisable reading for the settings page. */
export function limitSnapshot() {
  return {
    rpm: { ...LIMITS.rpm },
    tpm: { ...LIMITS.tpm },
    retryAfterSeconds: LIMITS.retryAfterSeconds,
    status: LIMITS.status,
    source: LIMITS.source,
    at: LIMITS.at,
  };
}

/**
 * Refuse a request the quota already rules out.
 *
 * Only an exhausted budget with a reset still in the future is treated as
 * certain — everything else just sends and learns from the response, because a
 * stale snapshot must never block work that would have succeeded.
 */
function exhaustedBudget(budget) {
  if (budget === undefined || budget.remaining === undefined) return undefined;
  if (budget.remaining > 0) return undefined;
  if (budget.resetAt !== undefined && budget.resetAt <= Date.now()) return undefined;
  return budget;
}

function preflight() {
  const rpm = exhaustedBudget(LIMITS.rpm);
  const tpm = exhaustedBudget(LIMITS.tpm);
  if (rpm === undefined && tpm === undefined) return;
  const resetAt = Math.min(
    ...[rpm?.resetAt, tpm?.resetAt].filter((value) => typeof value === "number"),
  );
  const retryAfterSeconds = Number.isFinite(resetAt) && resetAt > Date.now()
    ? Math.ceil((resetAt - Date.now()) / 1000)
    : LIMITS.retryAfterSeconds;
  throw mistralFailure(
    `Mistral Vibe: the ${rpm !== undefined ? "request" : "token"} budget is exhausted${
      retryAfterSeconds === undefined ? "" : `; retry in ${retryAfterSeconds}s`
    }.`,
    "RATE_LIMIT",
    retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
  );
}

function classifyStatus(status, bodyText) {
  const text = typeof bodyText === "string" ? bodyText : "";
  const body = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  const suffix = body.length > 0 ? `: ${body}` : "";
  if (status === 401 || status === 403) {
    return mistralFailure(`Mistral rejected the API key (${status})${suffix}`, "AUTH", { status });
  }
  if (status === 402) {
    return mistralFailure(`Mistral refused the request for lack of credit (${status})${suffix}`, "QUOTA_EXCEEDED", { status });
  }
  if (status === 429) {
    return mistralFailure(`Mistral rate-limited the request (429)${suffix}`, "RATE_LIMIT", { status });
  }
  if (status >= 500) {
    return mistralFailure(`Mistral failed the request (${status})${suffix}`, "SERVER", { status });
  }
  if (status === 408 || status === 504) {
    return mistralFailure(`Mistral timed out (${status})${suffix}`, "TIMEOUT", { status });
  }
  // The build is part of the message: a rejected body is only diagnosable when
  // the error names the code that composed it.
  return mistralFailure(`Mistral rejected the request (${status}) [${BUILD}]${suffix}`, "INVALID_REQUEST", {
    status,
  });
}

/** Read one credential reference through the credentials service, then the env. */
async function lookupSecret(ctx, ref) {
  const credentials = ctx === undefined ? undefined : ctx.get("credentials");
  if (credentials !== undefined && typeof credentials.resolve === "function") {
    try {
      const hit = await credentials.resolve(ref);
      const value = typeof hit === "string" ? hit : hit === undefined || hit === null ? undefined : hit.value;
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // A missing record is normal; fall through to the process environment.
    }
  }
  const fromEnv = typeof process !== "undefined" ? process.env?.[ref] : undefined;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : undefined;
}

/** A key is printable ASCII with no spaces; anything else cannot be an HTTP header value. */
const LEGAL_KEY = /^[\x21-\x7E]+$/;

function normaliseKey(raw, ref) {
  const value = raw.trim();
  if (value.length === 0) {
    throw mistralFailure(`Mistral Vibe: credential "${ref}" is blank`, "MISSING_CREDENTIAL");
  }
  if (!LEGAL_KEY.test(value)) {
    throw mistralFailure(
      `Mistral Vibe: credential "${ref}" contains characters an API key cannot contain`,
      "INVALID_REQUEST",
    );
  }
  return value;
}

/**
 * Stable 9-character tool-call id, matching Mistral's accepted id shape.
 *
 * The whole id is hashed, never truncated: harness ids share a long prefix
 * (`chatcmpltool…`), so slicing the first nine alphanumerics gave every call in
 * one message the same id `chatcmplt`, and the session log then refused to load
 * with "assistant/message repeats advertised tool call chatcmplt".
 */
function shortToolId(original, attempt, serial) {
  const seed = `${String(original)}#${attempt}${serial === undefined ? "" : `#${serial}`}`;
  let first = 2166136261;
  let second = 0x811c9dc5 ^ 0x5bf03635;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619) >>> 0;
    second = Math.imul(second ^ code, 2654435761) >>> 0;
  }
  const body = `${first.toString(36).padStart(7, "0")}${second.toString(36).padStart(5, "0")}`;
  return `c${body}`.slice(0, 9);
}

function blocksToText(content, allowNotes) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text") {
      text += typeof block.text === "string" ? block.text : "";
      continue;
    }
    if (!allowNotes) continue;
    if (block.type === "tool-addition") {
      text += `\n[tool available: ${block.name ?? "unknown"}]\n`;
      continue;
    }
    if (block.type === "tool-removal") {
      text += `\n[tool withdrawn: ${block.name ?? "unknown"}]\n`;
      continue;
    }
    if (block.type === "image") {
      text += "\n[image omitted]\n";
      continue;
    }
    if (block.type === "file") {
      text += "\n[file omitted]\n";
    }
  }
  return text;
}

function toolArgumentsOf(block) {
  if (typeof block.arguments === "string") return block.arguments;
  if (block.arguments === undefined || block.arguments === null) return "{}";
  try {
    return JSON.stringify(block.arguments);
  } catch {
    return "{}";
  }
}

/** Convert the harness transcript into Mistral chat messages. */
async function toMistralMessages(options, attachments, signal, replayReasoning = false) {
  const out = [];
  const ids = new Map();
  const used = new Set();
  const shortId = (original) => {
    const key = typeof original === "string" && original.length > 0 ? original : "call";
    const known = ids.get(key);
    if (known !== undefined) return known;
    let attempt = 0;
    let candidate = shortToolId(key, attempt);
    while (used.has(candidate)) {
      attempt += 1;
      candidate = shortToolId(key, attempt);
    }
    used.add(candidate);
    ids.set(key, candidate);
    return candidate;
  };

  /**
   * Turn one user message into Mistral content.
   *
   * A message with images becomes a content-part array; anything else stays a
   * plain string so the text path on the wire is unchanged. An image the route
   * cannot read is replaced by a placeholder rather than dropping silently or
   * failing the whole turn.
   */
  const userContent = async (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts = [];
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      if (block.type === "text") {
        if (typeof block.text === "string" && block.text.length > 0) {
          parts.push({ type: "text", text: block.text });
        }
        continue;
      }
      if (block.type !== "image") continue;
      const ref = block.attachment;
      if (typeof attachments?.readImageRequest !== "function") {
        parts.push({ type: "text", text: "\n[image omitted: this route is text only]\n" });
        continue;
      }
      try {
        const image = await attachments.readImageRequest(ref, IMAGE_REQUEST_TARGET, signal);
        const bytes = image?.data;
        if (bytes === undefined || bytes === null) throw new Error("empty image");
        const base64 = Buffer.from(bytes).toString("base64");
        parts.push({
          type: "image_url",
          image_url: `data:${image.mediaType ?? ref?.mediaType ?? "image/png"};base64,${base64}`,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        parts.push({ type: "text", text: `\n[image could not be read: ${reason.slice(0, 120)}]\n` });
      }
    }
    // Collapse to a string when nothing but text survived, matching Mistral's
    // simplest accepted shape.
    if (parts.every((part) => part.type === "text")) {
      return parts.map((part) => part.text).join("");
    }
    return parts;
  };

  let system = typeof options.system === "string" ? options.system.trim() : "";
  let sawConversation = false;

  for (const message of options.messages ?? []) {
    if (message === null || typeof message !== "object") continue;
    const role = message.role;

    if (!sawConversation && (role === "system" || role === "developer")) {
      const text = (typeof message.content === "string" ? message.content : blocksToText(message.content, true)).trim();
      if (text.length > 0) system = system.length > 0 ? `${system}\n\n${text}` : text;
      continue;
    }

    sawConversation = true;

    if (role === "system" || role === "developer") {
      const text = blocksToText(message.content, true).trim();
      if (text.length > 0) {
        out.push({ role: "user", content: `<system-reminder>\n${text}\n</system-reminder>` });
      }
      continue;
    }

    if (role === "user") {
      out.push({ role: "user", content: await userContent(message.content) });
      continue;
    }

    if (role === "assistant") {
      // Older and imported sessions store assistant content as a plain string.
      let text = typeof message.content === "string" ? message.content : "";
      const toolCalls = [];
      // Vibe replays reasoning as `thinking` chunks inside `content`, never as a
      // sibling field: that is the only shape Mistral's assistant message
      // declares, and it keeps the model's own reasoning across a replay.
      const thinking = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block === null || typeof block !== "object") continue;
        if (block.type === "text") {
          text += typeof block.text === "string" ? block.text : "";
          continue;
        }
        if (block.type === "reasoning") {
          if (replayReasoning && typeof block.text === "string" && block.text.length > 0) {
            thinking.push({ type: "thinking", thinking: [{ type: "text", text: block.text }] });
          }
          continue;
        }
        if (block.type === "tool-call") {
          toolCalls.push({
            id: shortId(block.id),
            type: "function",
            function: {
              name: String(block.name ?? "tool"),
              arguments: toolArgumentsOf(block),
            },
          });
        }
      }
      if (thinking.length === 0 && text.length === 0 && toolCalls.length === 0) continue;
      const content = thinking.length > 0
        ? [...thinking, ...(text.length > 0 ? [{ type: "text", text }] : [])]
        : text;
      const entry = { role: "assistant", content };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }

    if (role === "tool") {
      const callId = message.toolCallId ?? message.source?.callId;
      out.push({
        role: "tool",
        tool_call_id: shortId(callId),
        content: blocksToText(message.content, false),
      });
    }
  }

  if (system.length > 0) out.unshift({ role: "system", content: system });
  return out;
}

/**
 * Rebuild every wire message from the fields Mistral's schema declares.
 *
 * Mistral validates message shapes strictly — an extra key is a 422, not a
 * warning — and two upstream layers are known to widen an assistant turn:
 * pi-ai adds `reasoning_content` (its DeepSeek replay convention), and a
 * forked or imported session can replay whatever it stored. Rebuilding here
 * makes the wire independent of that: only role/content/tool_calls survive.
 */
export function sanitizeMessages(messages) {
  /** Keep only the chunk types Mistral's assistant content declares. */
  const cleanChunks = (content) => {
    if (!Array.isArray(content)) return undefined;
    const chunks = [];
    for (const chunk of content) {
      if (chunk === null || typeof chunk !== "object") continue;
      if (chunk.type === "thinking") {
        const items = Array.isArray(chunk.thinking) ? chunk.thinking : [];
        const texts = items
          .filter((item) => item !== null && typeof item === "object" && typeof item.text === "string")
          .map((item) => ({ type: "text", text: item.text }));
        if (texts.length > 0) chunks.push({ type: "thinking", thinking: texts });
        continue;
      }
      if (chunk.type === "text" && typeof chunk.text === "string") {
        chunks.push({ type: "text", text: chunk.text });
      }
    }
    return chunks;
  };

  const cleanToolCalls = (calls) =>
    calls
      .filter((call) => call !== null && typeof call === "object")
      .map((call) => ({
        id: typeof call.id === "string" ? call.id : "",
        type: "function",
        function: {
          name: String(call.function?.name ?? "tool"),
          arguments: call.function?.arguments ?? "{}",
        },
      }));

  const out = [];
  for (const message of messages ?? []) {
    if (message === null || typeof message !== "object") continue;
    const role = message.role;
    if (role === "assistant") {
      const chunks = cleanChunks(message.content);
      const text = typeof message.content === "string" ? message.content : "";
      const toolCalls = Array.isArray(message.tool_calls) ? cleanToolCalls(message.tool_calls) : [];
      // A thinking-only turn is still a turn: Vibe replays those chunks too.
      if (text.length === 0 && toolCalls.length === 0 && (chunks === undefined || chunks.length === 0)) {
        continue;
      }
      const clean = { role: "assistant", content: chunks ?? text };
      if (toolCalls.length > 0) clean.tool_calls = toolCalls;
      out.push(clean);
      continue;
    }
    if (role === "tool") {
      out.push({ role: "tool", tool_call_id: message.tool_call_id, content: message.content ?? "" });
      continue;
    }
    if (role === "system" || role === "user") {
      out.push({ role, content: message.content });
    }
  }
  return out;
}

/**
 * How `fetch` reached this module.
 *
 * A host may replace the global with an accessor that rewrites requests
 * (the inspector does). Knowing which one this adapter captured is the
 * difference between "my body was wrong" and "my body was altered after me".
 */
const FETCH_KIND = (() => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  if (descriptor === undefined) return "missing";
  return descriptor.get === undefined ? "value" : "accessor";
})();

/** A short, stable identity for a payload, so two reports can be compared. */
function payloadDigest(payload) {
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

/** Fields Mistral's message schema rejects outright. */
const STRIPPED_WIRE_FIELDS = ["reasoning_content", "reasoning", "cache_control", "provider_metadata"];

/**
 * Remove undeclared fields from the serialised request body.
 *
 * `sanitizeMessages` rebuilds every message, so this is redundant on the normal
 * path — but a body is only worth sending if it is malformed-proof. A 422 costs
 * the whole turn, and `reasoning_content` is the DeepSeek replay convention, so
 * it can appear in a history this route did not write (a fork, an import, or
 * another provider's cached conversation).
 *
 * It walks the parsed body rather than matching text: a JSON field can be first,
 * middle or last in its object, and a regex keyed on the preceding comma misses
 * the first-key case — which is exactly how one leak survived.
 */
export function stripWireFields(json) {
  let body;
  try {
    body = JSON.parse(json);
  } catch {
    // Not JSON: hand it back untouched rather than corrupting it.
    return json;
  }
  const lists = [body?.messages];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      if (message === null || typeof message !== "object") continue;
      for (const field of STRIPPED_WIRE_FIELDS) delete message[field];
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (call !== null && typeof call === "object") {
            for (const field of STRIPPED_WIRE_FIELDS) delete call[field];
          }
        }
      }
    }
  }
  return JSON.stringify(body);
}

function toMistralTools(tools) {
  const out = [];
  for (const tool of tools ?? []) {
    if (tool === null || typeof tool !== "object") continue;
    const name = tool.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const schema = tool.parameters ?? tool.inputSchema ?? tool.schema;
    out.push({
      type: "function",
      function: {
        name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters:
          schema !== null && typeof schema === "object" ? schema : { type: "object", properties: {} },
      },
    });
  }
  return out;
}

function reasoningMetadata(entry) {
  const levels = entry.levels;
  if (!Array.isArray(levels) || levels.length === 0) return undefined;
  const ordered = THINKING_ORDER.filter((level) => levels.includes(level));
  if (ordered.length === 0) return undefined;
  const efforts = ordered.map((level) => ({
    id: level,
    name: LEVEL_NAMES[level] ?? level,
    ...LEVEL_DESCRIPTIONS[level] === undefined ? {} : { description: LEVEL_DESCRIPTIONS[level] },
  }));
  const defaultEffort = ordered.includes("off") ? "off" : ordered[0];
  return { efforts, defaultEffort };
}

/**
 * Unwrap cosmokit volatile references in a resolved plugin config.
 * A `volatile()` schema field is materialised as a reference object whose
 * `get()` returns the immutable snapshot, so reading the field directly would
 * yield the wrapper instead of the configured value. `isVolatile` matches on a
 * globally registered symbol, so it works across module copies.
 */
function unwrapConfig(raw) {
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]),
  );
}

export class MistralVibeAdapter {
  constructor(config) {
    this.config = config;
    // Tool-call ids must be unique for the whole session, not just one turn: a
    // provider that numbers its calls `call_0`, `call_1`, … per response would
    // otherwise repeat an id and the log would refuse to load. This counter never
    // resets, so every emitted id is globally fresh.
    this.callSerial = 0;
  }

  settings() {
    const raw = unwrapConfig(this.config() ?? {});
    return {
      displayName: typeof raw.displayName === "string" && raw.displayName.length > 0 ? raw.displayName : DISPLAY_NAME,
      baseURL: typeof raw.baseURL === "string" && raw.baseURL.length > 0 ? raw.baseURL : DEFAULT_BASE_URL,
      apiKeyEnv:
        typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.length > 0 ? raw.apiKeyEnv : DEFAULT_API_KEY_ENV,
      apiKey: typeof raw.apiKey === "string" && raw.apiKey.length > 0 ? raw.apiKey : undefined,
      studioApiKey:
        typeof raw.studioApiKey === "string" && raw.studioApiKey.length > 0 ? raw.studioApiKey : undefined,
      disabledModels: Array.isArray(raw.disabledModels) ? raw.disabledModels : [],
      // The stored model list and its legacy per-id form, so a caller can read
      // the whole list without touching the settings document itself.
      modelsJson: typeof raw.modelsJson === "string" ? raw.modelsJson : "",
      discoveredModels: Array.isArray(raw.discoveredModels) ? raw.discoveredModels : [],
      discoveredInfo: typeof raw.discoveredInfo === "string" ? raw.discoveredInfo : "",
      // An in-process request rewriter (billion-context) rewrites assistant
      // messages on the way out; this header asks it to relay verbatim.
      bypassRewrite: raw.bypassRewrite !== false,
      // Exposed deployments: the page is served from the same origin as these
      // routes, so same-origin is enough; anything else needs this token.
      allowRemote: raw.allowRemote !== false,
      accessToken:
        typeof raw.accessToken === "string" && raw.accessToken.length > 0
          ? raw.accessToken
          : undefined,
    };
  }

  models() {
    const settings = this.settings();
    const disabled = new Set(settings.disabledModels);
    return MODEL_CATALOGUE.filter((entry) => !disabled.has(entry.id));
  }

  /**
   * The credential for account-level reads (billing, model listing).
   *
   * Mistral issues Studio/API keys and Vibe Code keys separately; a user may
   * hold only one. Preferring the Studio key, then falling back to the route
   * key, keeps a single-key setup working while allowing the split.
   */
  async studioKey() {
    const settings = this.settings();
    if (settings.studioApiKey !== undefined) return normaliseKey(settings.studioApiKey, "studioApiKey");
    const stored = await lookupSecret(this.ctx, STUDIO_KEY_ENV);
    if (stored !== undefined) return normaliseKey(stored, STUDIO_KEY_ENV);
    return this.apiKey();
  }

  async apiKey() {
    const settings = this.settings();
    if (settings.apiKey !== undefined) return normaliseKey(settings.apiKey, "apiKey");
    const refs = [settings.apiKeyEnv, DEFAULT_API_KEY_ENV, "MISTRAL_VIBE_API_KEY"].filter(
      (ref, index, all) => typeof ref === "string" && ref.length > 0 && all.indexOf(ref) === index,
    );
    for (const ref of refs) {
      const found = await lookupSecret(this.ctx, ref);
      if (found !== undefined) return normaliseKey(found, ref);
    }
    throw mistralFailure(
      `Mistral Vibe: no credential for provider route "${PROVIDER}". Store the Mistral API key as "${settings.apiKeyEnv}", or export it in the environment the host runs in.`,
      "MISSING_CREDENTIAL",
    );
  }

  providerInfo(provider) {
    return { id: provider, name: this.settings().displayName };
  }

  /**
   * No provider-specific retry policy: the harness retry plugin applies the
   * shared policy, and Mistral's own 429 carries no retry hint we trust.
   */
  providerRetryPolicy(_provider) {
    return undefined;
  }

  /** Text-only route: no image request pricing is ever produced. */
  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  /** Pass through the caller's image target sizing, unchanged. */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  listModels(provider) {
    const settings = this.settings();
    const disabled = new Set(settings.disabledModels);
    // Advertise the curated catalogue even before a credential exists. The
    // Host builds the picker with `buildModelCatalog`, which drops every
    // provider group whose `models` array is empty -- so hiding the catalogue
    // until a key is stored removes the route from the picker entirely and
    // leaves the user with nowhere to enter the key. A request without one
    // fails with MISSING_CREDENTIAL at send time instead.
    const stored = storedModels(settings);
    if (stored !== undefined) {
      return Promise.resolve(
        stored
          .filter((row) => row.chat !== false && isChatModelId(row.id) && !disabled.has(row.id))
          .map((row) => ({
            provider,
            id: row.id,
            name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.id,
            // A catalogue id answers from the catalogue (plus the provider's own
            // vision read), so a list saved before a correction cannot keep the
            // picker on the old modality. A discovered row keeps what its own
            // read recorded.
            inputModalities:
              catalogueIdOf(row.id) === undefined
                ? Array.isArray(row.inputModalities) && row.inputModalities.length > 0
                  ? row.inputModalities
                  : ["text"]
                : modalitiesFor(catalogueEntry(row.id), this.ctx),
          })),
      );
    }
    return Promise.resolve(
      MODEL_CATALOGUE.filter((entry) => !disabled.has(entry.id)).map((entry) => ({
        provider,
        id: entry.id,
        name: entry.name,
        inputModalities: modalitiesFor(entry, this.ctx),
      })),
    );
  }

  resolveModel(provider, model) {
    // The stored list carries what the last discovery read saw: the provider's
    // own vision answer for a catalogue id, and the metadata of a model this
    // bundle does not ship. Adopting it here is what lets a restart resolve the
    // same model instead of falling back to the build-time snapshot.
    storedModels(this.settings());
    const entry = catalogueEntry(model);
    const info = {
      provider,
      // The registry requires the exact id it asked for; a retired alias keeps
      // its own id and borrows the dated entry's metadata.
      id: model,
      name: entry.name,
      inputModalities: modalitiesFor(entry, this.ctx),
      context: { contextWindow: modelContextWindow(entry) },
      defaultMaxTokens: modelMaxTokens(entry),
    };
    const reasoning = reasoningMetadata(entry);
    if (reasoning !== undefined) info.reasoning = reasoning;
    return Promise.resolve(info);
  }

  prepareCall(provider, model) {
    // Same reason as resolveModel: a stored row outlives the process.
    storedModels(this.settings());
    const entry = catalogueEntry(model);
    const info = {
      provider,
      // Same rule as resolveModel: the registry checks id === requested model.
      id: model,
      name: entry.name,
      inputModalities: modalitiesFor(entry, this.ctx),
      context: { contextWindow: modelContextWindow(entry) },
      defaultMaxTokens: modelMaxTokens(entry),
    };
    const reasoning = reasoningMetadata(entry);
    if (reasoning !== undefined) info.reasoning = reasoning;
    return Promise.resolve({
      model: info,
      stream: (options) => this.stream(options),
    });
  }

  async *stream(options) {
    const settings = this.settings();
    const entry = catalogueEntry(options.model);

    if (options.stop !== undefined) {
      throw mistralFailure("Mistral Vibe does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
    }

    const apiKey = await this.apiKey();
    preflight();

    const timeout = AbortSignal.timeout(600000);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

    const body = {
      model: options.model,
      stream: true,
      messages: sanitizeMessages(
        await toMistralMessages(
          options,
          attachmentsOf(this.ctx),
          signal,
          Array.isArray(entry.levels) && entry.levels.length > 0,
        ),
      ),
    };
    if (typeof options.temperature === "number") body.temperature = options.temperature;
    if (typeof options.maxTokens === "number" && Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0) {
      body.max_tokens = Math.min(options.maxTokens, entry.maxTokens);
    }
    const tools = toMistralTools(options.tools);
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
      // Mistral declares this flag; Vibe sends it with every tool set.
      body.parallel_tool_calls = true;
    }
    const level = options.reasoningEffort;
    if (typeof level === "string" && entry.wire !== undefined) {
      const wire = entry.wire[level];
      if (typeof wire === "string" && wire.length > 0) body.reasoning_effort = wire;
    }

    const url = `${settings.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const headers = {
      "user-agent": ATTRIBUTION_UA,
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      // bili (billion-context) injects reasoning_content into any assistant
      // turn with tool calls when the model id matches /deepseek/i, and Mistral
      // rejects that field outright (422 extra_forbidden). This asks bili to
      // relay this route byte-for-byte; Mistral itself ignores the header.
      ...(settings.bypassRewrite !== false ? { "x-bili-passthrough": "1" } : {}),
    };

    const payload = stripWireFields(JSON.stringify(body));

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw mistralFailure("Mistral Vibe: the request was aborted", "ABORTED");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw mistralFailure(`Mistral Vibe could not reach ${url}: ${message}`, "TRANSPORT");
    }

    captureLimits(response.headers, "chat");

    if (!response.ok) {
      let text = "";
      try {
        text = await response.text();
      } catch {
        text = "";
      }
      if (options.signal?.aborted) {
        throw mistralFailure("Mistral Vibe: the request was aborted", "ABORTED");
      }
      if (response.status === 422) {
        // A rejecting body is only fixable when the failure names what was
        // actually sent. Log the shape, not the text: keys per message, which
        // indexes carry an undeclared field, and a digest of the payload.
        try {
          const sent = JSON.parse(payload);
          const messages = Array.isArray(sent?.messages) ? sent.messages : [];
          const offenders = messages
            .map((message, index) => (message?.reasoning_content === undefined ? -1 : index))
            .filter((index) => index >= 0);
          this.ctx?.logger?.("dsh-mistral-vibe")?.warn?.("rejected request", {
            model: sent?.model,
            messages: messages.length,
            offenders,
            index8: messages[8] === undefined ? null : Object.keys(messages[8]),
            bytes: payload.length,
            digest: payloadDigest(payload),
            fetchKind: FETCH_KIND,
          });
        } catch {
          // Diagnostics must never be the reason a turn dies.
        }
      }
      throw classifyStatus(response.status, text);
    }
    if (response.body === null) {
      throw mistralFailure("Mistral Vibe received an empty response body", "TRANSPORT");
    }

    let blockIndex = 0;
    let open = null;
    const toolCalls = new Map();
    // A provider may omit `index`, or reuse one for a second call in the same
    // delta. Merging two calls would concatenate their names and arguments, so
    // every distinct call gets its own slot.
    const takenSlots = new Set();
    const nextFreeSlot = () => {
      let slot = 0;
      while (takenSlots.has(slot)) slot += 1;
      takenSlots.add(slot);
      return slot;
    };
    // Ids must be unique for the whole turn: two calls in one message sharing an
    // id make the session log refuse to load.
    const usedCallIds = new Set();
    const streamCallId = (original, slot) => {
      // The serial is bumped for every call and never reused, so an id cannot
      // repeat across turns even when the provider numbers its calls per response.
      this.callSerial += 1;
      const serial = this.callSerial;
      let attempt = slot;
      let candidate = shortToolId(original, attempt, serial);
      while (usedCallIds.has(candidate)) {
        attempt += 1;
        candidate = shortToolId(original, attempt, serial);
      }
      usedCallIds.add(candidate);
      return candidate;
    };
    let sawBlock = false;
    let usage;
    let finishReason;

    /**
     * Close the block that is still open.
     *
     * Inside `consumeEvent` the protocol is `{kind, chunk}`; the outer generator
     * unwraps it before yielding. The end-of-stream drain must unwrap too —
     * yielding the wrapper leaked it into AssistantStreamAccumulator, which
     * reports "unreachable variant in AssistantStreamAccumulator.push".
     */
    const closeOpen = function* closeOpenBlock() {
      if (open === null) return;
      const closing = open;
      open = null;
      if (closing.kind === "text") {
        yield {
          kind: "block",
          chunk: { type: "block-end", index: closing.index, block: { type: "text", text: closing.buffer } },
        };
        return;
      }
      yield {
        kind: "block",
        chunk: {
          type: "block-end",
          index: closing.index,
          block: { type: "reasoning", text: closing.buffer },
        },
      };
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });

        let boundary = pending.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const rawEvent = pending.slice(0, boundary);
          const separator = pending.slice(boundary).match(/^\r?\n\r?\n/);
          pending = pending.slice(boundary + (separator === null ? 2 : separator[0].length));

          const dataLines = [];
          for (const line of rawEvent.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length > 0) {
            for (const parsed of consumeEvent(dataLines.join("\n"))) {
              if (parsed.kind === "error") throw parsed.error;
              if (parsed.kind === "block") {
                sawBlock = true;
                yield parsed.chunk;
              }
              if (parsed.kind === "usage") usage = parsed.usage;
              if (parsed.kind === "finish") finishReason = parsed.finishReason;
            }
          }

          boundary = pending.search(/\r?\n\r?\n/);
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream is already settled; nothing to release.
      }
    }

    // Drain the last open block, unwrapping the internal `{kind, chunk}` form:
    // this generator is what the harness consumes, and it only accepts stream
    // chunks.
    for (const part of closeOpen()) {
      if (part.kind === "block") yield part.chunk;
    }

    for (const call of toolCalls.values()) {
      sawBlock = true;
      yield {
        type: "block-end",
        index: call.index,
        block: {
          type: "tool-call",
          id: call.id,
          name: call.name.length > 0 ? call.name : "tool",
          arguments: call.arguments.length > 0 ? call.arguments : "{}",
        },
      };
    }

    if (!sawBlock && (finishReason === undefined || finishReason === "stop")) {
      throw mistralFailure("Mistral Vibe returned an empty assistant message", "EMPTY_RESPONSE");
    }

    if (usage !== undefined) yield { type: "usage", usage };

    const kind =
      toolCalls.size > 0
        ? "tool-calls"
        : finishReason === "length"
          ? "max-tokens"
          : "stop";
    yield { type: "finish", reason: { kind } };

    /**
     * Decode one SSE payload into stream chunks. Kept as a closure so the
     * block/tool-call cursors stay local to this response.
     */
    function* consumeEvent(payload) {
      if (payload.length === 0 || payload === "[DONE]") return;
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      if (event === null || typeof event !== "object") return;

      if (event.error !== undefined && event.error !== null) {
        const message =
          typeof event.error === "string"
            ? event.error
            : typeof event.error.message === "string"
              ? event.error.message
              : JSON.stringify(event.error);
        yield { kind: "error", error: mistralFailure(`Mistral reported an error: ${message}`, "SERVER") };
        return;
      }

      if (event.usage !== undefined && event.usage !== null) {
        const promptTokens = Number(event.usage.prompt_tokens ?? 0);
        const completionTokens = Number(event.usage.completion_tokens ?? 0);
        const cached = Number(
          event.usage.prompt_tokens_details?.cached_tokens ??
            event.usage.promptTokensDetails?.cachedTokens ??
            0,
        );
        const total = Number(event.usage.total_tokens ?? promptTokens + completionTokens);
        const usage = {
          inputTokens: Math.max(0, promptTokens - (Number.isFinite(cached) ? cached : 0)),
          outputTokens: completionTokens,
          totalTokens: Number.isFinite(total) && total > 0 ? total : promptTokens + completionTokens,
          ...Number.isFinite(cached) && cached > 0 ? { cacheReadTokens: cached } : {},
        };
        yield { kind: "usage", usage };
      }

      const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
      if (choice === undefined || choice === null) return;

      const delta = choice.delta ?? {};

      for (const part of deltaParts(delta.content)) {
        if (part.kind === "text" && part.text.length > 0) {
          if (open !== null && open.kind !== "text") {
            yield* closeOpen();
          }
          if (open === null) {
            open = { kind: "text", index: blockIndex, buffer: "" };
            blockIndex += 1;
            yield { kind: "block", chunk: { type: "block-start", index: open.index, blockType: "text" } };
          }
          open.buffer += part.text;
          yield { kind: "block", chunk: { type: "text-delta", index: open.index, text: part.text } };
          continue;
        }
        if (part.kind === "thinking" && part.text.length > 0) {
          if (open !== null && open.kind !== "reasoning") {
            yield* closeOpen();
          }
          if (open === null) {
            open = { kind: "reasoning", index: blockIndex, buffer: "" };
            blockIndex += 1;
            yield { kind: "block", chunk: { type: "block-start", index: open.index, blockType: "reasoning" } };
          }
          open.buffer += part.text;
          yield { kind: "block", chunk: { type: "reasoning-delta", index: open.index, text: part.text } };
        }
      }

      for (const raw of delta.tool_calls ?? []) {
        if (raw === null || typeof raw !== "object") continue;
        if (open !== null) {
          yield* closeOpen();
        }
        const declared = Number.isInteger(raw.index) ? raw.index : undefined;
        const incomingId = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : undefined;
        const slot =
          declared === undefined
            ? nextFreeSlot()
            : toolCalls.has(declared) &&
                incomingId !== undefined &&
                toolCalls.get(declared).originalId !== undefined &&
                toolCalls.get(declared).originalId !== incomingId
              ? nextFreeSlot()
              : declared;
        takenSlots.add(slot);
        let call = toolCalls.get(slot);
        if (call === undefined) {
          call = {
            id: streamCallId(incomingId ?? `tool-${slot}`, slot),
            originalId: incomingId,
            name: "",
            arguments: "",
            index: blockIndex,
          };
          blockIndex += 1;
          toolCalls.set(slot, call);
          yield {
            kind: "block",
            chunk: {
              type: "block-start",
              index: call.index,
              blockType: "tool-call",
            },
          };
        } else if (call.originalId === undefined && incomingId !== undefined) {
          call.originalId = incomingId;
        }
        const fn = raw.function ?? {};
        const namePart = typeof fn.name === "string" ? fn.name : "";
        let argsPart = "";
        if (typeof fn.arguments === "string") argsPart = fn.arguments;
        else if (fn.arguments !== undefined && fn.arguments !== null) {
          try {
            argsPart = JSON.stringify(fn.arguments);
          } catch {
            argsPart = "";
          }
        }
        if (namePart.length > 0) call.name += namePart;
        if (argsPart.length > 0) call.arguments += argsPart;
        if (namePart.length > 0 || argsPart.length > 0) {
          yield {
            kind: "block",
            chunk: {
              type: "tool-call-delta",
              index: call.index,
              id: call.id,
              ...namePart.length > 0 ? { name: namePart } : {},
              argumentsDelta: argsPart,
            },
          };
        }
      }

      if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
        yield { kind: "finish", finishReason: choice.finish_reason };
      }
    }
  }
}

/** Split a `delta.content` payload into normalised parts. */
function deltaParts(content) {
  if (typeof content === "string") return content.length > 0 ? [{ kind: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item.length > 0) parts.push({ kind: "text", text: item });
      continue;
    }
    if (item === null || typeof item !== "object") continue;
    if (item.type === "thinking") {
      const thinking = Array.isArray(item.thinking) ? item.thinking : [];
      let text = "";
      for (const piece of thinking) {
        if (piece !== null && typeof piece === "object" && typeof piece.text === "string") text += piece.text;
      }
      if (text.length > 0) parts.push({ kind: "thinking", text });
      continue;
    }
    if (typeof item.text === "string" && item.text.length > 0) {
      parts.push({ kind: "text", text: item.text });
    }
  }
  return parts;
}

/**
 * Row config, projected into the Settings surface by the `settings` service.
 *
 * The field names double as the Models-page contract: the page reads
 * `apiKeyEnv` off this schema to label the credential slot for the route.
 */
export const Config = Schema.object({
  displayName: Schema.string()
    .default(DISPLAY_NAME)
    .description("Name shown for this provider route in the model picker.")
    .volatile(),
  apiKeyEnv: Schema.string()
    .default(DEFAULT_API_KEY_ENV)
    .description("Credential reference that holds the Mistral API key.")
    .volatile(),
  apiKey: Schema.string()
    .role("secret")
    .description("Vibe Code API key: the credential this route sends to /chat/completions.")
    .volatile(),
  studioApiKey: Schema.string()
    .role("secret")
    .description("Studio / API key for account reads (billing, model listing). Falls back to the Vibe Code key.")
    .volatile(),
  baseURL: Schema.string()
    .default(DEFAULT_BASE_URL)
    .description("Mistral API base URL, without the trailing slash.")
    .volatile(),
  disabledModels: Schema.array(Schema.string())
    .default([])
    .description("Model ids to hide from the picker.")
    .volatile(),
  bypassRewrite: Schema.boolean()
    .default(true)
    .description(
      "Send x-bili-passthrough: 1 so an in-process request rewriter relays the body verbatim. Mistral ignores the header; turn it off behind a gateway that rejects unknown headers.",
    )
    .volatile(),
  discoveredModels: Schema.array(Schema.string())
    .default([])
    .description(
      "Model ids a live /v1/models read reported; they are advertised ahead of the built-in catalogue.",
    )
    .volatile(),
  modelsJson: Schema.string()
    .default("")
    .description(
      "The whole model list a successful fetch stored, so the picker and this page show it without fetching again.",
    )
    .volatile(),
  discoveredInfo: Schema.string()
    .default("")
    .description(
      "JSON metadata (name, limits, modality, reasoning) for the discovered ids, so a restarted host still shows them correctly.",
    )
    .volatile(),
  allowRemote: Schema.boolean()
    .default(true)
    .description(
      "Answer the settings routes for a non-loopback request too, so the page works when the web UI is exposed over HTTP/S. An exposed request must be same-origin or carry the access token.",
    )
    .volatile(),
  accessToken: Schema.string()
    .role("secret")
    .default("")
    .description(
      "Token a non-loopback, non-same-origin request must present as `Authorization: Bearer …` or `x-mistral-vibe-token`. Falls back to MISTRAL_VIBE_ACCESS_TOKEN.",
    )
    .volatile(),
});

/**
 * The code actually running.
 *
 * A host keeps an applied plugin module in memory, so "the fix is on disk" and
 * "the fix is loaded" are different claims. This stamp is logged on mount and
 * returned by `GET /mistral-vibe/config`, which makes the difference visible.
 */
const BUILD = "1.1.1+1d36fb44";

export const name = "dsh-mistral-vibe";export const inject = ["llm"];

/* -------------------------------------------------------------------------- *
 * Host-owned HTTP surface for the settings page.
 *
 * The client half is a built browser bundle: it owns no Harness schema form and
 * cannot call Host services, so the page talks to these loopback routes. This is
 * the same split the MCP Servers settings page uses (its Host half registers
 * `/mcp-servers/config`, its client half `fetch`es it).
 * -------------------------------------------------------------------------- */

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Host part of the request's own origin, or undefined when it cannot be told.
 *
 * A `fetch()` POST always carries `Origin`; a same-origin GET normally carries
 * only `Referer` (and sometimes neither, under `no-referrer`). Both are read so
 * an exposed deployment is recognised without demanding a token from the page
 * that the same server just served.
 */
function originHost(request) {
  const headers = request?.headers ?? {};
  for (const header of [headers.origin, headers.referer]) {
    if (typeof header !== "string" || header.length === 0 || header === "null") continue;
    try {
      return new URL(header).host;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Chromium's own same-origin signal; the page is served by this same server. */
function sameOriginFetch(request) {
  const site = request?.headers?.["sec-fetch-site"];
  return site === "same-origin" || site === "same-site";
}

/** Constant-time compare, so a wrong token cannot be discovered byte by byte. */
export function sameToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

/** The token a request carries, from either header shape. */
function requestToken(request) {
  const direct = request?.headers?.["x-mistral-vibe-token"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const header = request?.headers?.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? undefined : match[1].trim();
}

/**
 * Decide whether a settings request may proceed.
 *
 * The page is served by the same web server as these routes, so an exposed
 * deployment is normally a same-origin request and needs no token. Loopback is
 * always trusted. Anything else — a different origin, a proxy that rewrote the
 * origin, curl from another host — must present the configured token, because
 * the POST surface can point `baseURL` somewhere else.
 *
 * @returns `{ok: true}` or a refusal body to send.
 */
export async function authorizeRequest(request, settings, configuredToken) {
  const host = String(request?.headers?.host ?? "");
  if (LOOPBACK_HOST.test(host)) return { ok: true };
  if (settings?.allowRemote === false) {
    return { ok: false, status: 403, body: { error: "loopback only", code: "loopback_only" } };
  }
  const origin = originHost(request);
  if (origin !== undefined && origin === host) return { ok: true };
  if (origin === undefined && sameOriginFetch(request)) return { ok: true };
  const configured = configuredToken;
  if (typeof configured !== "string" || configured.length === 0) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "this request is not same-origin, and no access token is configured",
        code: "access_token_required",
      },
    };
  }
  if (sameToken(requestToken(request), configured)) return { ok: true };
  return {
    ok: false,
    status: 401,
    body: { error: "access token does not match", code: "access_token_rejected" },
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/**
 * Read the settings service without touching the inject-gated property.
 *
 * `ctx.settings` is a Context property getter, and Cordis throws
 * `cannot get property "settings" without inject` from any fiber that did not
 * declare `inject: ["settings"]`. This bundle deliberately keeps
 * `inject = ["llm"]` so a missing settings service can never hold the entry in
 * `pending`; `ctx.get(name)` is the untyped lookup that needs no declaration.
 */
export function settingsServiceOf(ctx) {
  if (ctx === undefined || ctx === null) return undefined;
  if (typeof ctx.get === "function") {
    const found = ctx.get("settings");
    if (found !== undefined) return found;
  }
  // A host that only exposes the property form (or a test double). Reading it
  // can throw on an inject-less fiber, so it is always guarded.
  try {
    return ctx.settings;
  } catch {
    return undefined;
  }
}

/**
 * Collapse `/v1/models` rows that are the same weights under several ids.
 *
 * Mistral lists every alias as its own row (codestral-2508, codestral-latest,
 * mistral-code-latest, mistral-code-fim-latest are one model), and every row
 * carries the full `aliases` array. Union those ids so one class yields one
 * entry; `type` cannot help here, since every row reports `type: "base"`.
 */
function aliasGroups(rows) {
  const parent = new Map();
  const find = (id) => {
    let root = id;
    let next = parent.get(root);
    while (next !== undefined && next !== root) {
      root = next;
      next = parent.get(root);
    }
    return root;
  };
  const union = (left, right) => {
    if (!parent.has(left)) parent.set(left, left);
    if (!parent.has(right)) parent.set(right, right);
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a);
  };
  for (const row of rows) {
    if (typeof row?.id !== "string") continue;
    if (!parent.has(row.id)) parent.set(row.id, row.id);
    for (const alias of Array.isArray(row.aliases) ? row.aliases : []) {
      if (typeof alias === "string" && alias.length > 0) union(row.id, alias);
    }
  }
  return find;
}

/**
 * Ask the Mistral endpoint which models the credential can actually reach.
 *
 * This backs the "fetch models" action on the Models page, so it interrogates a
 * draft (an explicit key or base URL may differ from the saved row) instead of
 * reading stored state.
 */
async function curatedDiscovery(adapter) {
  const settings = adapter.settings();
  const disabled = new Set(settings.disabledModels);
  const stored = storedModels(settings);
  if (stored !== undefined) {
    const rows = stored
      .filter((row) => row.chat !== false && isChatModelId(row.id))
      .map((row) => ({
        ...row,
        // Same rule as listModels: for a catalogue id the catalogue (plus the
        // provider's own read) outranks a list saved before the correction.
        ...(catalogueIdOf(row.id) === undefined
          ? {}
          : { inputModalities: modalitiesFor(catalogueEntry(row.id), adapter.ctx) }),
        disabled: disabled.has(row.id),
      }));
    if (rows.some((row) => row.reasoning === true && row.levels === undefined)) {
      // The stored list already went through the authoritative pass; this one
      // only fills a ladder models.dev has since learned.
      await enrichFromModelsDev(rows, AbortSignal.timeout(2500), { modalities: false });
    }
    return rows;
  }
  const extras = discoveredEntries(settings).map((entry) => ({
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    inputModalities: entry.vision === true ? ["text", "image"] : ["text"],
    reasoning: entry.reasoning === true || (Array.isArray(entry.levels) && entry.levels.length > 0),
    ...(Array.isArray(entry.levels) && entry.levels.length > 0 ? { levels: entry.levels } : {}),
    discovered: true,
    disabled: disabled.has(entry.id),
  }));
  if (extras.some((row) => row.levels === undefined)) {
    // A page read must not wait on the internet: the ladder is a nicety, and an
    // offline host simply keeps the row marked "levels unknown".
    await enrichFromModelsDev(extras, AbortSignal.timeout(2500));
  }
  const chatExtras = extras.filter((row) => row.chat !== false);
  const curated = MODEL_CATALOGUE.map((entry) => ({
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    inputModalities: modalitiesFor(entry, adapter.ctx),
    reasoning: Array.isArray(entry.levels) && entry.levels.length > 0,
    ...(Array.isArray(entry.levels) && entry.levels.length > 0 ? { levels: entry.levels } : {}),
    discovered: false,
    disabled: disabled.has(entry.id),
  }));
  return [...chatExtras, ...curated];
}

export async function discoverModels(adapter, request, signal) {
  const settings = adapter.settings();
  const baseURL =
    typeof request?.baseURL === "string" && request.baseURL.length > 0
      ? request.baseURL
      : settings.baseURL;

  let key;
  try {
    key =
      typeof request?.apiKey === "string" && request.apiKey.length > 0
        ? normaliseKey(request.apiKey, "apiKey")
        : await adapter.apiKey();
  } catch (error) {
    // No credential yet: the settings card still needs the declared catalogue,
    // otherwise the user cannot hide or unhide anything before pasting a key.
    const code = error !== null && typeof error === "object" ? error.code : undefined;
    if (code === "MISSING_CREDENTIAL") return await curatedDiscovery(adapter);
    throw error;
  }

  const response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
    method: "GET",
    headers: {
      "user-agent": ATTRIBUTION_UA,
      accept: "application/json",
      ...(settings.bypassRewrite !== false ? { "x-bili-passthrough": "1" } : {}),
      authorization: `Bearer ${key}`,
    },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    // classifyStatus already returns the failure; wrapping it again would put an
    // Error object into `error.code`, which normalizeLlmFailure cannot trust.
    const detail = await response.text().catch(() => "");
    throw classifyStatus(response.status, detail);
  }

  captureLimits(response.headers, "models");

  const payload = await response.json();
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  // The provider's own answer for the ids this bundle ships: it outranks the
  // build-time snapshot, and it is the only thing that can correct it without a
  // new release.
  rememberApiVision(entries);
  const disabled = new Set(settings.disabledModels);
  const seen = new Set();
  const extras = [];

  // One entry per model, not per id: `/v1/models` lists every alias as a row,
  // and a class whose canonical id the bundle already ships is already served.
  // Embedding, OCR, moderation, transcription and speech rows cannot answer a
  // chat turn, so they never reach the picker.
  const findAliasRoot = aliasGroups(entries);
  const covered = new Set();
  for (const entry of entries) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) continue;
    const members = [entry.id, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    if (members.some((member) => isCatalogueId(member))) covered.add(findAliasRoot(entry.id));
  }

  // `completion_chat` is the authority when the endpoint declares it; a host
  // that omits capabilities altogether (any OpenAI-compatible server) falls back
  // to the id families that cannot chat.
  const canChat = (entry) => {
    const flag = entry?.capabilities?.completion_chat;
    // An explicit `false` is final. An absent flag is not a "no": Mistral has
    // added rows that omit the field, and dropping them hid brand-new models.
    // Such a row falls back to the id heuristic here and to models.dev's `type`
    // in enrichFromModelsDev(), which is the authoritative answer.
    if (flag === false) return false;
    if (flag === true) return true;
    return isChatModelId(entry.id);
  };

  // API rows first: a model Mistral released after this bundle was built shows
  // up at the top of the list instead of hiding under the shipped catalogue.
  for (const entry of entries) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) continue;
    const root = findAliasRoot(entry.id);
    if (covered.has(root) || seen.has(root)) continue;
    seen.add(root);
    if (!canChat(entry)) continue;
    if (isCatalogueId(entry.id)) continue;
    extras.push({
      id: entry.id,
      name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
      ...(Number.isSafeInteger(entry.max_context_length) && entry.max_context_length > 0
        ? { contextWindow: entry.max_context_length }
        : {}),
      inputModalities: entry?.capabilities?.vision === true ? ["text", "image"] : ["text"],
      reasoning: entry?.capabilities?.reasoning === true,
      discovered: true,
      disabled: disabled.has(entry.id),
    });
  }

  await enrichFromModelsDev(extras, signal);
  const chatExtras = extras.filter((row) => row.chat !== false);
  rememberDiscovered(chatExtras);

  // What this route already advertises: the stored list when a previous fetch
  // left one, otherwise the shipped catalogue. Merging (rather than appending a
  // delta) is what makes one fetch enough: the answer is the whole list.
  const known = storedModels(settings) ?? [...discoveredEntries(settings).map(entryToRow), ...catalogueRows(adapter)];
  const byId = new Map();
  for (const row of [...chatExtras, ...known]) {
    if (typeof row?.id !== "string" || byId.has(row.id)) continue;
    byId.set(row.id, { ...row, disabled: disabled.has(row.id) });
  }
  const merged = [...byId.values()];
  // A fetch is the moment the provider answers for itself: refresh the catalogue
  // rows from that answer instead of echoing the snapshot a previous fetch
  // saved, so a list written while models.dev was stale cannot keep a working
  // vision flag hidden.
  for (const row of merged) {
    const id = catalogueIdOf(row.id);
    if (id === undefined || !API_VISION.has(id)) continue;
    const vision = API_VISION.get(id);
    row.inputModalities = modalitiesFor(CATALOGUE_BY_ID.get(id), adapter.ctx);
    row.visionFromApi = vision;
  }
  if (merged.some((row) => row.reasoning === true && row.levels === undefined)) {
    // This pass exists to fill a missing ladder, not to re-litigate modality:
    // the rows it walks may carry a newer answer than models.dev's record.
    await enrichFromModelsDev(merged, signal, { modalities: false });
  }
  return merged;
}

/**
 * Mount the Mistral Vibe provider route.
 * @param ctx - host plugin context.
 * @param config - optional row config: `baseURL`, `apiKeyEnv`, `apiKey`,
 * `displayName`, `disabledModels`.
 */
export function apply(ctx, config) {
  const adapter = new MistralVibeAdapter(() => config);
  Object.defineProperty(adapter, "ctx", { value: ctx, enumerable: false });

  // One line per mount: it tells a stale in-memory module apart from a stale
  // file, which is the difference between "reload the plugin" and "restart".
  try {
    ctx.logger?.("dsh-mistral-vibe")?.info?.(`loaded build ${BUILD}`);
  } catch {
    // A missing logger is not worth failing the mount over.
  }

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);

  // Tie the route to this plugin's lifetime so a disable or reload releases it.
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      registration?.dispose?.();
    });
  }

  // The Settings surface resolves namespaces by exact entry id, so a mismatch
  // would silently drop both the config card and model discovery.
  const settingsNs = ctx.fiber?.entry?.options?.id ?? ENTRY_ID;
  const releases = [];

  try {
    if (typeof ctx.llm.registerConfigurableProviders === "function") {
      releases.push(
        ctx.llm.registerConfigurableProviders([
          {
            provider: PROVIDER,
            displayName: adapter.settings().displayName,
            settingsNs,
            settingsPath: [],
            declared: false,
          },
        ]),
      );
    }
    if (typeof ctx.llm.registerModelDiscovery === "function") {
      releases.push(
        ctx.llm.registerModelDiscovery(settingsNs, (request, signal) =>
          discoverModels(adapter, request, signal),
        ),
      );
    }
  } catch (error) {
    // A duplicate means another bundle already owns this surface; tolerate it so
    // the route still works. Anything else is a real defect and must surface:
    // a silently degraded settings surface is worse than a failed mount.
    const code = error !== null && typeof error === "object" ? error.code : undefined;
    if (code !== "DUPLICATE_DIRECTORY" && code !== "DUPLICATE_DISCOVERY") throw error;
    const message = error instanceof Error ? error.message : String(error);
    try {
      ctx.logger?.("dsh-mistral-vibe")?.warn?.(`settings surface unavailable: ${message}`);
    } catch {
      // A missing logger is not worth failing the mount over.
    }
  }

  if (releases.length > 0 && typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      for (const release of releases) {
        try {
          release?.();
        } catch {
          // A single failed release must not keep the rest registered.
        }
      }
    });
  }

  /* --- the settings page's data plane ------------------------------------- */

  const settingsService = () => settingsServiceOf(ctx);

  /** Persist a patch against this row. Paths outside the volatile schema refuse. */
  const savePatch = async (patch) => {
    const settings = settingsService();
    if (settings === undefined || typeof settings.update !== "function") {
      throw new Error("the settings service is unavailable, so the row cannot persist a change");
    }
    const ns = ctx.fiber?.entry?.options?.id ?? ENTRY_ID;
    await settings.update(ns, patch);
  };

  /**
   * Store a secret where secrets live.
   *
   * The settings service persists a volatile field into the row's entry, which
   * means a key typed into the page would be written to cordis.patch.yml in
   * plain text. The credential record is the right home: the row keeps only the
   * reference, the value stays in the provider-managed store, and the adapter
   * resolves it per operation. When no credential service is mounted the value
   * falls back to the row so a command-line profile still works.
   */
  const storeSecret = async (ref, value) => {
    const credentials = typeof ctx.get === "function" ? ctx.get("credentials") : undefined;
    if (credentials === undefined || typeof credentials.set !== "function") return false;
    try {
      if (value.length === 0) await credentials.unset(ref);
      else await credentials.set(ref, value);
      return true;
    } catch {
      return false;
    }
  };

  const credentialConfigured = async (ref) => {
    const credentials = typeof ctx.get === "function" ? ctx.get("credentials") : undefined;
    if (credentials === undefined || typeof credentials.describe !== "function") return false;
    try {
      const info = await credentials.describe(ref);
      return info?.configured === true;
    } catch {
      return false;
    }
  };

  const configReply = async () => {
    const settings = adapter.settings();
    const hasKey =
      settings.apiKey !== undefined ||
      (await credentialConfigured(settings.apiKeyEnv)) ||
      (await credentialConfigured(DEFAULT_API_KEY_ENV));
    const hasStudioKey =
      settings.studioApiKey !== undefined || (await credentialConfigured(STUDIO_KEY_ENV));
    return {
      displayName: settings.displayName,
      apiKeyEnv: settings.apiKeyEnv,
      baseURL: settings.baseURL,
      // The keys themselves never cross the wire; the page only needs presence.
      // `build` names the code this host actually loaded.
      build: BUILD,
      hasKey,
      hasStudioKey,
      allowRemote: settings.allowRemote !== false,
      hasToken:
        settings.accessToken !== undefined || (await credentialConfigured(ACCESS_TOKEN_ENV)),
      disabledModels: settings.disabledModels,
      models: await curatedDiscovery(adapter),
    };
  };

  /** The access token an exposed request must present: row, then record, then env. */
  const accessTokenOf = async () => {
    const token = adapter.settings().accessToken;
    if (token !== undefined) return token;
    return lookupSecret(ctx, ACCESS_TOKEN_ENV);
  };

  const handleConfig = async (request, response) => {
    const access = await authorizeRequest(request, adapter.settings(), await accessTokenOf());
    if (!access.ok) {
      sendJson(response, access.status, access.body);
      return;
    }
    if (request.method === "GET") {
      sendJson(response, 200, await configReply());
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    const body = await readJsonBody(request);
    const patch = {};
    if ("apiKey" in body) {
      if (typeof body.apiKey !== "string") {
        sendJson(response, 400, { error: "apiKey must be a string" });
        return;
      }
      if (body.apiKey.length > 0 && !LEGAL_KEY.test(body.apiKey)) {
        sendJson(response, 400, { error: "the API key contains a space or a non-printable character" });
        return;
      }
      // Prefer the credential record; the row keeps an empty value so the
      // profile file never holds the secret.
      const stored = await storeSecret(adapter.settings().apiKeyEnv || DEFAULT_API_KEY_ENV, body.apiKey);
      patch.apiKey = stored ? "" : body.apiKey;
    }
    if ("studioApiKey" in body) {
      if (typeof body.studioApiKey !== "string") {
        sendJson(response, 400, { error: "studioApiKey must be a string" });
        return;
      }
      if (body.studioApiKey.length > 0 && !LEGAL_KEY.test(body.studioApiKey)) {
        sendJson(response, 400, { error: "the Studio key contains a space or a non-printable character" });
        return;
      }
      const storedStudio = await storeSecret(STUDIO_KEY_ENV, body.studioApiKey);
      patch.studioApiKey = storedStudio ? "" : body.studioApiKey;
    }
    if ("baseURL" in body) {
      if (typeof body.baseURL !== "string") {
        sendJson(response, 400, { error: "baseURL must be a string" });
        return;
      }
      patch.baseURL = body.baseURL;
    }
    if ("displayName" in body) {
      if (typeof body.displayName !== "string" || body.displayName.trim().length === 0) {
        sendJson(response, 400, { error: "displayName must be a non-empty string" });
        return;
      }
      patch.displayName = body.displayName;
    }
    if ("disabledModels" in body) {
      const list = body.disabledModels;
      if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
        sendJson(response, 400, { error: "disabledModels must be an array of model ids" });
        return;
      }
      patch.disabledModels = list;
    }
    if ("allowRemote" in body) {
      if (typeof body.allowRemote !== "boolean") {
        sendJson(response, 400, { error: "allowRemote must be a boolean" });
        return;
      }
      patch.allowRemote = body.allowRemote;
    }
    if ("accessToken" in body) {
      if (typeof body.accessToken !== "string") {
        sendJson(response, 400, { error: "accessToken must be a string" });
        return;
      }
      if (body.accessToken.length > 0 && !LEGAL_KEY.test(body.accessToken)) {
        sendJson(response, 400, { error: "the access token contains a space or a non-printable character" });
        return;
      }
      // Same rule as the API keys: the credential record holds it, the row does not.
      const storedToken = await storeSecret(ACCESS_TOKEN_ENV, body.accessToken);
      patch.accessToken = storedToken ? "" : body.accessToken;
    }
    if (Object.keys(patch).length === 0) {
      sendJson(response, 400, { error: "empty update" });
      return;
    }
    await savePatch(patch);
    sendJson(response, 200, { ok: true, config: configReply() });
  };

  const handleDiscover = async (request, response) => {
    const access = await authorizeRequest(request, adapter.settings(), await accessTokenOf());
    if (!access.ok) {
      sendJson(response, access.status, access.body);
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    const body = await readJsonBody(request);
    const draft = {};
    if (typeof body.apiKey === "string" && body.apiKey.length > 0) draft.apiKey = body.apiKey;
    if (typeof body.baseURL === "string" && body.baseURL.length > 0) draft.baseURL = body.baseURL;

    // Ask whether a live read is even possible, so the page can tell "Mistral
    // reported nothing new" apart from "no key is stored yet".
    let hasCredential = typeof draft.apiKey === "string";
    if (!hasCredential) {
      try {
        await adapter.apiKey();
        hasCredential = true;
      } catch (error) {
        const code = error !== null && typeof error === "object" ? error.code : undefined;
        if (code !== "MISSING_CREDENTIAL") throw error;
      }
    }

    // Snapshot what the row already advertises, so "new" means new to this
    // route rather than "reported by Mistral again". The stored list is the
    // source of truth once a fetch has run.
    const storedIds = storedModels(adapter.settings())?.map((row) => row.id);
    const known = new Set(
      storedIds ?? (Array.isArray(adapter.settings().discoveredModels) ? adapter.settings().discoveredModels : []),
    );
    const disabledSet = new Set(adapter.settings().disabledModels ?? []);
    const models = await discoverModels(adapter, draft);
    const added = models
      .filter((row) => row.discovered === true && !known.has(row.id))
      .map((row) => row.id);

    // Persist the whole list, not a delta: the next page load, restart or
    // reload reads this one store, so a fetched model stays without another
    // fetch. The shipped catalogue is only the bootstrap for a row that has
    // never fetched.
    let persisted = false;
    let persistError;
    if (hasCredential && models.length > 0) {
      const payload = models.map((row) => ({
        id: row.id,
        name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.id,
        contextWindow: row.contextWindow,
        maxTokens: row.maxTokens,
        inputModalities: Array.isArray(row.inputModalities) ? row.inputModalities : ["text"],
        reasoning: row.reasoning === true,
        ...(Array.isArray(row.levels) && row.levels.length > 0 ? { levels: row.levels } : {}),
        // The provider's own vision answer, kept beside the snapshot it corrects
        // so a restart does not fall back to the build-time flag.
        ...(typeof row.visionFromApi === "boolean" ? { visionFromApi: row.visionFromApi } : {}),
        discovered: row.discovered === true,
      }));
      try {
        await savePatch({ modelsJson: JSON.stringify(payload) });
        for (const row of payload) rememberStoredRow(row);
        persisted = true;
      } catch (error) {
        // A read-only profile still gets the rows for this session; the page is
        // told the list did not stick instead of quietly re-fetching forever.
        persistError = error instanceof Error ? error.message : String(error);
      }
    }

    sendJson(response, 200, {
      ok: true,
      source: hasCredential ? "live" : "catalogue",
      added,
      models: models.map((row) => ({ ...row, disabled: disabledSet.has(row.id) })),
      persisted,
      ...(persistError === undefined ? {} : { persistError }),
      notice: hasCredential
        ? added.length === 0
          ? `Mistral reported no models beyond this list.${persisted ? " The list is saved." : ""}`
          : `${added.length} new model${added.length === 1 ? "" : "s"} found and saved to the list.`
        : "No key stored yet, so this is the built-in catalogue. Save a key, then fetch again.",
    });
  };

  const route = (handler) => async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      sendJson(response, 500, { error: shortError(error) });
    }
  };

  if (typeof ctx.inject === "function") {
    try {
      // The page replaces the schema-driven form, so the row opts out of it:
      // two editors for one config would fight over the same document.
      ctx.inject(["settings"], (child) => {
        try {
          child.effect(
            () => child.settings.configure({ auto: false }, ctx.fiber),
            "dsh-mistral-vibe: own settings page",
          );
        } catch {
          // Older settings services have no `configure`; the form simply stays.
        }
      });
    } catch {
      // No injection support: the route and the adapter still work.
    }

    try {
      ctx.inject(["webServer"], (hostCtx) => {
        const webServer = hostCtx.webServer;
        if (webServer === undefined || typeof webServer.register !== "function") return;
        hostCtx.effect(() => {
          const disposers = [
            webServer.register({ kind: "exact", path: "/mistral-vibe/config", handler: route(handleConfig) }),
            webServer.register({ kind: "exact", path: "/mistral-vibe/discover", handler: route(handleDiscover) }),
          ];
          return () => {
            for (const dispose of disposers) {
              try {
                dispose?.();
              } catch {
                // One dead route must not strand the other.
              }
            }
          };
        }, "dsh-mistral-vibe: http routes");
      });
    } catch {
      // Command-line profiles have no webServer; the page simply never mounts.
    }
  }
}
