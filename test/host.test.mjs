/**
 * Offline self-test for the Mistral Vibe adapter.
 *
 * Runs the real adapter against a local SSE server that mimics Mistral's
 * `/v1/chat/completions` stream, so the wire encoding, block emission, tool-call
 * accumulation, usage mapping and failure classification can all be checked
 * without an API key.
 */
import { createServer } from "node:http";
import assert from "node:assert/strict";
import {
  Config,
  MODEL_CATALOGUE,
  MistralVibeAdapter,
  captureLimits,
  discoverModels,
  isChatModelId,
  modelsDevFacts,
  limitSnapshot,
  sanitizeMessages,
  stripWireFields,
  settingsServiceOf,
} from "../lib/index.js";

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

const THINKING_EVENT = {
  id: "cmpl-1",
  choices: [
    {
      index: 0,
      delta: {
        role: "assistant",
        content: [{ type: "thinking", thinking: [{ type: "text", text: "Let me think. " }] }],
      },
      finish_reason: null,
    },
  ],
};

const THINKING_EVENT_2 = {
  choices: [
    {
      index: 0,
      delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "Still thinking." }] }] },
      finish_reason: null,
    },
  ],
};

const TEXT_EVENT = {
  choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }],
};

const TEXT_EVENT_2 = {
  choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }],
};

const TOOL_EVENT = {
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          { index: 0, id: "abcDEF123456789", function: { name: "read_file", arguments: '{"pa' } },
        ],
      },
      finish_reason: null,
    },
  ],
};

const TOOL_EVENT_2 = {
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] },
      finish_reason: null,
    },
  ],
};

const FINAL_EVENT = {
  id: "cmpl-1",
  choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 20 },
  },
};

const captured = { requests: [] };

// models.dev is the only place a thinking ladder can come from: /v1/models
// never publishes an effort list. The suite points the reader at a local copy.
const MODELS_DEV_STUB = {
  mistral: {
    models: {
      "mistral-large-5": {
        status: "deprecated",
        reasoning: true,
        limit: { context: 524288, output: 65536 },
        reasoning_options: [{ type: "effort", values: ["none", "high"] }],
      },
      "mistral-large-4": {
        reasoning: true,
        limit: { context: 1048576 },
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      },
      "mistral-large-9": {
        name: "Mistral Large 9",
        reasoning: true,
        modalities: { input: ["text", "image", "pdf"] },
        limit: { context: 999424, output: 131072 },
        reasoning_options: [{ type: "effort", values: ["none", "high", "max"] }],
      },
      "voxtral-mini-tts-99": {
        type: "speech",
        name: "Voxtral Mini TTS",
        modalities: { input: ["text"], output: ["audio"] },
        limit: { context: 0, output: 0 },
      },
      "mistral-audio-only-99": {
        name: "Audio Only",
        attachment: true,
        modalities: { input: ["text", "audio", "pdf"] },
        limit: { context: 32768, output: 32000 },
      },
    },
  },
};

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (piece) => {
    body += piece;
  });
  request.on("end", () => {
    // A GET (model discovery) sends no body at all.
    const parsed = body.length === 0 ? undefined : JSON.parse(body);
    captured.requests.push({ url: request.url, headers: request.headers, body: parsed });
    if (new URL(request.url, "http://localhost").pathname === "/modelsdev.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(MODELS_DEV_STUB));
      return;
    }
    if (new URL(request.url, "http://localhost").pathname.startsWith("/v1/unauthorized")) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }
    if (new URL(request.url, "http://localhost").pathname.startsWith("/v1/plain")) {
      // A reply that never opens a second block: the only text block is still
      // open when the stream ends, which is exactly the shape that leaked
      // `{kind, chunk}` wrappers into AssistantStreamAccumulator.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sse([
          { choices: [{ index: 0, delta: { content: "Hi! 👋 I'm here." }, finish_reason: null }] },
          {
            id: "cmpl-2",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          },
        ]),
      );
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      sse([
        THINKING_EVENT,
        THINKING_EVENT_2,
        TEXT_EVENT,
        TEXT_EVENT_2,
        TOOL_EVENT,
        TOOL_EVENT_2,
        FINAL_EVENT,
      ]),
    );
    response.end();
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseURL = `http://127.0.0.1:${port}/v1`;

// Discovery reads the ladder from models.dev; point that read at the stub so the
// suite stays offline and the expected levels are deterministic.
process.env.MISTRAL_MODELS_DEV_URL = `http://127.0.0.1:${port}/modelsdev.json`;

const results = [];

async function test(name, run) {
  try {
    await run();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const adapter = new MistralVibeAdapter(() => ({ apiKey: "test-key", baseURL }));

const conversation = {
  provider: "mistral-vibe",
  model: "mistral-large-4",
  system: "You are a careful assistant.",
  reasoningEffort: "high",
  temperature: 0.2,
  maxTokens: 4096,
  messages: [
    { role: "system", content: [{ type: "text", text: "Extra system note." }] },
    { role: "user", content: [{ type: "text", text: "Read a.txt" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "previous thinking" },
        { type: "text", text: "Sure." },
        { type: "tool-call", id: "call_abcdefghijklmnop", name: "read_file", arguments: '{"path":"b.txt"}' },
      ],
    },
    { role: "tool", toolCallId: "call_abcdefghijklmnop", content: [{ type: "text", text: "contents" }] },
  ],
  tools: [
    { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  ],
};

await test("resolveModel exposes Vibe thinking ladder", async () => {
  const info = await adapter.resolveModel("mistral-vibe", "mistral-large-4");
  assert.equal(info.name, "Mistral Large 4");
  assert.equal(info.context.contextWindow, 1048576);
  assert.deepEqual(
    info.reasoning.efforts.map((effort) => effort.id),
    ["low", "medium", "high"],
  );
  assert.equal(info.reasoning.defaultEffort, "low");
  const medium = await adapter.resolveModel("mistral-vibe", "mistral-medium-latest");
  assert.deepEqual(medium.reasoning.efforts.map((effort) => effort.id), ["off", "high"]);
  assert.equal(medium.reasoning.defaultEffort, "off");
  const plain = await adapter.resolveModel("mistral-vibe", "mistral-large-latest");
  assert.equal(plain.reasoning, undefined);
});

await test("listModels returns the curated catalogue", async () => {
  const models = await adapter.listModels("mistral-vibe");
  assert.ok(models.length >= 12);
  assert.ok(models.every((model) => model.provider === "mistral-vibe"));
  assert.deepEqual(models[0].inputModalities, ["text"]);
  assert.ok(models.some((model) => model.id === "mistral-large-4" && model.name === "Mistral Large 4"));
  // One row per model: an alias id must not appear beside the entry it aliases.
  const ids = models.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length, "no id is listed twice");
  assert.equal(ids.some((id) => id.endsWith("-latest")), false, "aliases ship as one dated row");
});

await test("stream maps thinking, text, tool calls, usage and finish", async () => {
  const prepared = await adapter.prepareCall("mistral-vibe", "mistral-large-4");
  const chunks = [];
  for await (const chunk of prepared.stream(conversation)) chunks.push(chunk);

  const starts = chunks.filter((chunk) => chunk.type === "block-start");
  assert.deepEqual(
    starts.map((chunk) => `${chunk.blockType}:${chunk.index}`),
    ["reasoning:0", "text:1", "tool-call:2"],
  );

  const reasoning = chunks
    .filter((chunk) => chunk.type === "reasoning-delta")
    .map((chunk) => chunk.text)
    .join("");
  assert.equal(reasoning, "Let me think. Still thinking.");

  const text = chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.text)
    .join("");
  assert.equal(text, "Hello world");

  const ends = chunks.filter((chunk) => chunk.type === "block-end");
  assert.deepEqual(ends[0].block, { type: "reasoning", text: "Let me think. Still thinking." });
  assert.deepEqual(ends[1].block, { type: "text", text: "Hello world" });
  assert.equal(ends[2].block.type, "tool-call");
  assert.equal(ends[2].block.name, "read_file");
  assert.equal(ends[2].block.arguments, '{"path":"a.txt"}');
  assert.match(ends[2].block.id, /^[A-Za-z0-9]{9}$/);

  const usage = chunks.find((chunk) => chunk.type === "usage");
  assert.deepEqual(usage.usage, {
    inputTokens: 100,
    outputTokens: 30,
    totalTokens: 150,
    cacheReadTokens: 20,
  });

  const finish = chunks.at(-1);
  assert.equal(finish.type, "finish");
  assert.equal(finish.reason.kind, "tool-calls");
});

await test("wire request carries reasoning_effort, tools and attribution", async () => {
  const request = captured.requests.at(-1);
  assert.equal(request.url, "/v1/chat/completions");
  assert.match(request.headers["user-agent"], /deepseek-harness/);
  assert.equal(request.headers.authorization, "Bearer test-key");
  assert.equal(request.body.model, "mistral-large-4");
  assert.equal(request.body.reasoning_effort, "high");
  assert.equal(request.body.max_tokens, 4096);
  assert.equal(request.body.temperature, 0.2);
  assert.equal(request.body.tools[0].function.name, "read_file");
  assert.equal(request.body.messages[0].role, "system");
  assert.equal(
    request.body.messages[0].content,
    "You are a careful assistant.\n\nExtra system note.",
  );
  assert.equal(request.body.parallel_tool_calls, true, "Vibe sends this with every tool set");
  const assistant = request.body.messages.find((message) => message.role === "assistant");
  assert.deepEqual(
    assistant.content,
    [
      { type: "thinking", thinking: [{ type: "text", text: "previous thinking" }] },
      { type: "text", text: "Sure." },
    ],
    "reasoning replays as thinking chunks inside content, like Vibe",
  );
  assert.equal(assistant.tool_calls[0].function.name, "read_file");
  const toolMessage = request.body.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.tool_call_id, assistant.tool_calls[0].id);
  assert.equal(toolMessage.content, "contents");
});

await test("off level is sent as reasoning_effort none", async () => {
  const prepared = await adapter.prepareCall("mistral-vibe", "mistral-medium-latest");
  for await (const _chunk of prepared.stream({ ...conversation, model: "mistral-medium-latest", reasoningEffort: "off" })) {
    // drain
  }
  assert.equal(captured.requests.at(-1).body.reasoning_effort, "none");
});

await test("non-reasoning model never receives reasoning_effort", async () => {
  const prepared = await adapter.prepareCall("mistral-vibe", "devstral-2512");
  for await (const _chunk of prepared.stream({ ...conversation, model: "mistral-large-latest", reasoningEffort: undefined })) {
    // drain
  }
  assert.equal(captured.requests.at(-1).body.reasoning_effort, undefined);
});

await test("a replayed assistant message never carries reasoning_content", async () => {
  // Mistral's chat schema forbids extra fields on an assistant message
  // (422 extra_forbidden, loc body.messages.N.assistant.reasoning_content).
  // Thinking blocks are dropped on replay: the visible text and the tool calls
  // are the only things a turn may resend.
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"id":"x","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
        );
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const adapter = new MistralVibeAdapter(() => ({ apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" }));
    const options = {
      provider: "mistral-vibe",
      model: "deepseek-v4-1-flash-1017",
      system: "s",
      messages: [
        { role: "user", content: [{ type: "text", text: "one" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "internal" },
            { type: "text", text: "answer" },
          ],
          source: { kind: "model", providerThinkingLevel: "high" },
        },
        { role: "user", content: [{ type: "text", text: "two" }] },
      ],
      reasoningEffort: "high",
      maxTokens: 32,
    };
    for await (const chunk of adapter.stream(options)) void chunk;

    const body = captured[0];
    assert.equal(JSON.stringify(body).includes("reasoning_content"), false, "no reasoning_content on the wire");
    const assistant = body.messages.filter((message) => message.role === "assistant");
    assert.equal(assistant.length, 1);
    assert.deepEqual(Object.keys(assistant[0]).sort(), ["content", "role"], "only role and content");
    assert.deepEqual(
      assistant[0].content,
      [
        { type: "thinking", thinking: [{ type: "text", text: "internal" }] },
        { type: "text", text: "answer" },
      ],
      "the thinking chunk is the only place reasoning may travel",
    );
  } finally {
    globalThis.fetch = original;
  }
});

await test("a model without an effort ladder receives no thinking chunks", async () => {
  // Vibe gates the replay on the route taking reasoning input. Codestral has no
  // ladder here, so a thinking block in the history is dropped rather than sent
  // to a model that never declared the chunk type.
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"id":"x","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
        );
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const adapter = new MistralVibeAdapter(() => ({ apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" }));
    const options = {
      provider: "mistral-vibe",
      model: "codestral-2508",
      system: "s",
      messages: [
        { role: "user", content: [{ type: "text", text: "one" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "internal" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "two" }] },
      ],
      maxTokens: 32,
    };
    for await (const chunk of adapter.stream(options)) void chunk;
    const assistant = captured[0].messages.filter((message) => message.role === "assistant");
    assert.equal(assistant[0].content, "answer", "no ladder, no thinking chunks");
    assert.equal(JSON.stringify(captured[0]).includes("thinking"), false);
  } finally {
    globalThis.fetch = original;
  }
});

await test("account reads prefer the Studio key and fall back to the Vibe Code key", async () => {
  // Mistral issues Studio/API keys and Vibe Code keys separately, and a single-key
  // setup must keep working: the account reader prefers the Studio key, then the
  // route key, and refuses anything that is not printable ASCII.
  const split = new MistralVibeAdapter(() => ({ apiKey: "vibe-key-123", studioApiKey: "studio-key-456" }));
  assert.equal(await split.studioKey(), "studio-key-456", "the Studio key wins when both exist");

  const onlyVibe = new MistralVibeAdapter(() => ({ apiKey: "vibe-key-123" }));
  assert.equal(await onlyVibe.studioKey(), "vibe-key-123", "a single-key setup still reads the account");

  const neither = new MistralVibeAdapter(() => ({}));
  await assert.rejects(
    () => neither.studioKey(),
    (error) => error.code === "MISSING_CREDENTIAL",
    "no key at all must be refused",
  );

  const illegal = new MistralVibeAdapter(() => ({ apiKey: "vibe-key-123", studioApiKey: "line break" }));
  await assert.rejects(
    () => illegal.studioKey(),
    (error) => error.code === "INVALID_REQUEST",
    "a Studio key with whitespace must be refused",
  );
});

await test("an unconfigured route still advertises its catalogue but fails with MISSING_CREDENTIAL", async () => {
  // Root cause of the invisible provider: buildModelCatalog drops every group
  // whose models array is empty, so a route that hides its catalogue before a
  // credential exists disappears from the picker instead of asking for a key.
  const bare = new MistralVibeAdapter(() => ({ apiKeyEnv: "DSH_TEST_ABSENT_KEY", baseURL }));
  const models = await bare.listModels("mistral-vibe");
  assert.equal(models.length, MODEL_CATALOGUE.length);
  assert.deepEqual(
    models.map((model) => model.id),
    MODEL_CATALOGUE.map((entry) => entry.id),
  );
  const prepared = await bare.prepareCall("mistral-vibe", "mistral-large-4");
  let failure;
  try {
    for await (const _chunk of prepared.stream(conversation)) {
      // drain
    }
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== undefined, "expected a thrown failure");
  assert.equal(failure.code, "MISSING_CREDENTIAL");
  assert.equal(failure.failure.code, "MISSING_CREDENTIAL");
});

await test("401 classifies as AUTH with the trusted failure snapshot", async () => {
  const denied = new MistralVibeAdapter(() => ({ apiKey: "nope", baseURL: `http://127.0.0.1:${port}/v1/unauthorized` }));
  const prepared = await denied.prepareCall("mistral-vibe", "mistral-large-4");
  let failure;
  try {
    for await (const _chunk of prepared.stream(conversation)) {
      // drain
    }
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== undefined, "expected a thrown failure");
  assert.equal(failure.code, "AUTH");
  assert.equal(failure.failure.code, "AUTH");
  assert.equal(failure.failure.status, 401);
});

await test("a rejected discovery read reports AUTH instead of crashing", async () => {
  // The discovery path calls classifyStatus(status) with no body at all. That
  // used to throw "Cannot read properties of undefined (reading 'length')" and
  // hide the real cause: a key Mistral refuses.
  const stub = {
    settings: () => ({ baseURL: `http://127.0.0.1:${port}/v1/unauthorized`, disabledModels: [], discoveredModels: [] }),
    apiKey: async () => "nope",
    ctx: {},
  };
  let failure;
  try {
    await discoverModels(stub, {});
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== undefined, "expected a thrown failure");
  assert.notEqual(failure.name, "TypeError", "the error path must not crash on a missing body");
  assert.equal(failure.code, "AUTH");
  assert.equal(failure.failure.status, 401);
});

await test("every settings field is declared volatile so the Settings page lists the route", async () => {
  // dsh-settings describe() drops an entry outright when volatileForm(schema)
  // returns undefined (no field carries meta.volatile). Without a settings
  // namespace the Models page renders neither a card nor an add-provider row,
  // so the route is unusable even after the model picker lists it.
  const fields = Config.dict ?? {};
  for (const key of [
    "displayName",
    "apiKeyEnv",
    "apiKey",
    "baseURL",
    "disabledModels",
    "discoveredModels",
    "studioApiKey",
    "modelsJson",
  ]) {
    assert.ok(fields[key] !== undefined, `missing settings field ${key}`);
    assert.equal(fields[key].meta?.volatile, true, `${key} must be declared volatile`);
  }
});

await test("settings() unwraps volatile config references", async () => {
  const write = Symbol.for("cosmokit.volatile.write");
  const wrap = (value) => ({ get: () => value, [write]: () => {} });
  const adapter = new MistralVibeAdapter(() => ({
    displayName: wrap("Mistral Vibe Test"),
    baseURL: wrap("https://example.test/v1"),
    apiKeyEnv: wrap("MY_MISTRAL_KEY"),
    apiKey: wrap("sk-test-123"),
    disabledModels: wrap(["mistral-nemo"]),
  }));
  const settings = adapter.settings();
  assert.equal(settings.displayName, "Mistral Vibe Test");
  assert.equal(settings.baseURL, "https://example.test/v1");
  assert.equal(settings.apiKeyEnv, "MY_MISTRAL_KEY");
  assert.equal(settings.apiKey, "sk-test-123");
  assert.deepEqual(settings.disabledModels, ["mistral-nemo"]);
});

await test("dsh-settings volatileForm() accepts this schema instead of dropping the entry", async () => {
  // Mirror of dsh-settings' own predicate: describe() returns [] when
  // volatileForm(schema) is undefined, which is what hid the provider from the
  // Settings page. Keep this in lockstep with lib/index.js.
  const volatileForm = (schema) => {
    if (schema.meta?.volatile) return { leaf: true };
    if (schema.type !== "object") return undefined;
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child);
        return field === undefined ? [] : [[key, field]];
      }),
    );
    return Object.keys(dict).length === 0 ? undefined : dict;
  };
  const form = volatileForm(Config);
  assert.ok(form !== undefined, "volatileForm must not return undefined");
  assert.deepEqual(Object.keys(form).sort(), [
    "apiKey",
    "apiKeyEnv",
    "baseURL",
    "disabledModels",
    "discoveredInfo",
    "discoveredModels",
    "displayName",
    "modelsJson",
    "studioApiKey",
  ]);
});

await test("the settings service is read without the inject-gated property", async () => {
  // Cordis throws `cannot get property "settings" without inject` from any fiber
  // that did not declare it. This bundle keeps inject = ["llm"], so the data
  // plane must reach the service through ctx.get(), never ctx.settings.
  const service = { update: async () => {} };

  const viaGet = {
    get: (name) => (name === "settings" ? service : undefined),
    get settings() {
      throw new Error('cannot get property "settings" without inject');
    },
  };
  assert.equal(settingsServiceOf(viaGet), service, "ctx.get must resolve the service");

  const propertyOnly = { settings: service };
  assert.equal(settingsServiceOf(propertyOnly), service, "a property-only host still resolves");

  const gateClosed = {
    get: () => undefined,
    get settings() {
      throw new Error('cannot get property "settings" without inject');
    },
  };
  assert.equal(settingsServiceOf(gateClosed), undefined, "a refused property getter is swallowed");
  assert.equal(settingsServiceOf(undefined), undefined);
});

await test("model discovery answers from the curated catalogue without a key", async () => {
  const hidden = MODEL_CATALOGUE[MODEL_CATALOGUE.length - 1].id;
  const visible = MODEL_CATALOGUE[0].id;
  const adapter = {
    settings: () => ({
      displayName: "Mistral Vibe",
      apiKeyEnv: "MISTRAL_API_KEY",
      baseURL: "https://api.mistral.ai/v1",
      disabledModels: [hidden],
    }),
    apiKey: async () => {
      const error = new Error("no credential");
      error.code = "MISSING_CREDENTIAL";
      throw error;
    },
  };

  const rows = await discoverModels(adapter, {});
  assert.equal(rows.filter((row) => row.discovered !== true).length, MODEL_CATALOGUE.length);
  assert.deepEqual(
    rows.map((row) => row.id),
    MODEL_CATALOGUE.map((entry) => entry.id),
  );
  assert.equal(rows[0].name, MODEL_CATALOGUE[0].name);
  assert.equal(rows.find((row) => row.id === hidden).disabled, true);
  assert.equal(rows.find((row) => row.id === visible).disabled, false);
});

await test("the generated catalogue matches models.dev for the ids it ships", async () => {
  // Guards the other half of the "outdated list" bug: a model Mistral serves has
  // to be in the catalogue with its real limits, vision flag and effort ladder.
  const byId = new Map(MODEL_CATALOGUE.map((entry) => [entry.id, entry]));
  for (const id of ["deepseek-v4-1-flash-1017", "mistral-large-4", "mistral-medium-2604", "zai-glm-5-3"]) {
    assert.ok(byId.has(id), `catalogue is missing ${id}`);
  }
  assert.deepEqual(byId.get("mistral-large-4").levels, ["low", "medium", "high"]);
  assert.equal(byId.get("mistral-large-4").image, true);
  assert.deepEqual(byId.get("deepseek-v4-1-flash-1017").levels, ["off", "low", "high", "max"]);
  assert.equal(byId.get("deepseek-v4-1-flash-1017").wire.off, "none");
  assert.equal(byId.get("deepseek-v4-1-flash-1017").contextWindow, 1048576);
  // Deprecated ids must not linger: they are the reason the list looked stale.
  assert.equal(byId.has("devstral-2512"), false, "a deprecated id must be dropped");
  assert.equal(byId.has("mistral-embed"), false, "an embedding endpoint is not a chat model");
  // An alias id is not its own row: it redirects to the dated model it names.
  assert.equal(byId.has("mistral-medium-latest"), false, "an alias must not get its own row");
});

await test("a stored alias id upgrades to the dated model it names", async () => {
  // models.dev lists mistral-medium-latest beside mistral-medium-2604. The
  // catalogue ships one row (the dated one), so a session that selected the
  // alias must still resolve, with the dated id and its real limits.
  const prepared = await adapter.prepareCall("mistral-vibe", "mistral-medium-latest");
  assert.equal(prepared.model.id, "mistral-medium-2604", "the alias redirects to the dated id");
  assert.equal(prepared.model.name, "Mistral Medium 3.5");
  assert.equal(prepared.model.context.contextWindow, 262144);
  const resolved = await adapter.resolveModel("mistral-vibe", "codestral-latest");
  assert.equal(resolved.id, "codestral-2508");
  assert.deepEqual(resolved.reasoning, undefined, "codestral is not a reasoning model");
});

await test("a model Mistral added after this bundle is discovered, stays listed and resolves", async () => {
  // The bug: the page reloads /mistral-vibe/config right after a fetch, and that
  // repaint used to answer only from MODEL_CATALOGUE, so every discovered row
  // vanished. A released model has to survive the repaint and be usable.
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            {
              id: "mistral-large-5",
              name: "Mistral Large 5",
              max_context_length: 524288,
              capabilities: { vision: true, reasoning: true },
            },
            { id: "mistral-large-4", name: "Mistral Large 4", max_context_length: 1048576 },
          ],
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const config = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test", disabledModels: [] };
  const adapter = new MistralVibeAdapter(() => config);

  try {
    const rows = await discoverModels(adapter, {});
    assert.equal(rows[0].id, "mistral-large-5", "a newly released model sorts ahead of the catalogue");
    assert.equal(rows[0].discovered, true);
    assert.equal(rows[0].contextWindow, 524288);
    assert.equal(rows[0].reasoning, true);
    // The ladder is models.dev's, not invented: `none` becomes `off`.
    assert.deepEqual(rows[0].levels, ["off", "high"], "models.dev supplies the effort ladder");

    // Spread copies own fields only; the adapter methods live on the prototype.
    const withOverrides = (overrides) =>
      Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, overrides);

    // The repaint path: no credential, so only the catalogue plus what the route
    // remembered can answer.
    const noKey = async () => {
      const error = new Error("no credential");
      error.code = "MISSING_CREDENTIAL";
      throw error;
    };
    // Persisted metadata: a row saved by an earlier fetch, unknown to this
    // process, must still render with its name, limits and modality.
    const fromRow = {
      ...adapter.settings(),
      apiKey: undefined,
      discoveredModels: ["mistral-large-9"],
      discoveredInfo: JSON.stringify({
        "mistral-large-9": {
          name: "Mistral Large 9",
          contextWindow: 999424,
          maxTokens: 8192,
          vision: true,
          reasoning: true,
        },
      }),
    };
    const restored = await discoverModels(withOverrides({ apiKey: noKey, settings: () => fromRow }), {});
    const saved = restored.find((row) => row.id === "mistral-large-9");
    assert.equal(saved.name, "Mistral Large 9", "the saved display name survives a restart");
    assert.equal(saved.contextWindow, 999424, "the saved window survives a restart");
    assert.deepEqual(saved.inputModalities, ["text", "image"], "the saved modality survives a restart");
    assert.equal(saved.reasoning, true);

    const repainted = await discoverModels(withOverrides({ apiKey: noKey }), {});
    assert.equal(repainted[0].id, "mistral-large-5", "the discovered row survives the repaint");
    assert.equal(repainted[0].discovered, true);

    const persisted = withOverrides({
      settings: () => ({ ...adapter.settings(), discoveredModels: ["mistral-large-5"] }),
    });
    const resolved = await persisted.resolveModel("mistral-vibe", "mistral-large-5");
    assert.equal(resolved.id, "mistral-large-5");
    assert.equal(resolved.context.contextWindow, 524288);
    // models.dev knows this id, so the row carries a real ladder and the chat
    // picker offers exactly those levels.
    assert.deepEqual(
      resolved.reasoning.efforts.map((effort) => effort.id),
      ["off", "high"],
      "the persisted ladder survives a restart",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test("images are advertised only when the route can read attachment bytes", async () => {
  const bare = await adapter.resolveModel("mistral-vibe", "mistral-large-4");
  assert.equal(bare.name, "Mistral Large 4");
  assert.deepEqual(
    bare.inputModalities,
    ["text"],
    "without an attachments service the route stays text only",
  );

  const withService = Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, {
    ctx: {
      get: (name) => (name === "attachments" ? { readImageRequest: async () => ({}) } : undefined),
    },
  });
  const capable = await withService.resolveModel("mistral-vibe", "mistral-large-4");
  assert.deepEqual(capable.inputModalities, ["text", "image"]);

  // A model that cannot take attachments never gains the modality.
  // zai-glm-5-3 is one of the few live ids models.dev reports without attachment support.
  const textOnly = await withService.resolveModel("mistral-vibe", "zai-glm-5-3");
  assert.deepEqual(textOnly.inputModalities, ["text"]);
});

await test("an image block becomes an image_url part", async () => {
  const reading = Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, {
    ctx: {
      get: (name) =>
        name === "attachments"
          ? {
              readImageRequest: async (ref) => ({
                data: Uint8Array.from([1, 2, 3]),
                mediaType: "image/png",
              }),
            }
          : undefined,
    },
  });
  const prepared = await reading.prepareCall("mistral-vibe", "mistral-large-4");
  for await (const _chunk of prepared.stream({
    ...conversation,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", attachment: { attachmentId: "a1", mediaType: "image/png", bytes: 3, width: 8, height: 8 } },
        ],
      },
    ],
  })) {
    // drain
  }
  const sent = captured.requests.at(-1).body.messages;
  // A system message is unshifted first, so the user turn is the last one.
  assert.deepEqual(sent.at(-1).content, [
    { type: "text", text: "look" },
    { type: "image_url", image_url: "data:image/png;base64,AQID" },
  ]);

  // An unreadable image degrades to a placeholder instead of failing the turn.
  const broken = Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, {
    ctx: {
      get: (name) =>
        name === "attachments"
          ? { readImageRequest: async () => { throw new Error("scope denied"); } }
          : undefined,
    },
  });
  const preparedBroken = await broken.prepareCall("mistral-vibe", "mistral-large-4");
  for await (const _chunk of preparedBroken.stream({
    ...conversation,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", attachment: { attachmentId: "a1", mediaType: "image/png", bytes: 3, width: 8, height: 8 } },
        ],
      },
    ],
  })) {
    // drain
  }
  const degraded = captured.requests.at(-1).body.messages.at(-1).content;
  assert.equal(typeof degraded, "string", "a text-only message stays a plain string");
  assert.match(degraded, /image could not be read: scope denied/);
});

await test("a reply whose last block never closes still yields bare stream chunks", async () => {
  const plain = new MistralVibeAdapter(() => ({ apiKey: "test-key", baseURL: `${baseURL}/plain` }));
  const prepared = await plain.prepareCall("mistral-vibe", "mistral-large-4");
  const chunks = [];
  for await (const chunk of prepared.stream({ ...conversation, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })) {
    chunks.push(chunk);
  }

  const allowed = new Set([
    "block-start",
    "text-delta",
    "reasoning-delta",
    "tool-call-delta",
    "block-end",
    "usage",
    "finish",
  ]);
  for (const chunk of chunks) {
    assert.ok(
      chunk !== null && typeof chunk === "object" && allowed.has(chunk.type),
      `every yielded chunk is a stream chunk, got ${JSON.stringify(chunk)}`,
    );
  }

  const textEnd = chunks.filter((chunk) => chunk.type === "block-end" && chunk.block.type === "text");
  assert.equal(textEnd.length, 1, "the trailing text block is closed exactly once");
  assert.equal(textEnd[0].block.text, "Hi! 👋 I'm here.");
  assert.equal(chunks.at(-1).type, "finish");
  assert.equal(chunks.at(-1).reason.kind, "stop");
  const usageChunk = chunks.find((chunk) => chunk.type === "usage");
  assert.deepEqual(usageChunk.usage, { inputTokens: 5, outputTokens: 4, totalTokens: 9 });
});

await test("rate-limit headers are captured and an exhausted budget refuses early", async () => {
  const headers = new Map([
    ["ratelimit-limit", "100"],
    ["ratelimit-remaining", "0"],
    ["ratelimit-reset", "30"],
    ["x-ratelimit-limit-tokens", "500000"],
    ["x-ratelimit-remaining-tokens", "1234"],
    ["x-ratelimit-reset-tokens", "12"],
    ["retry-after", "7"],
  ]);
  const reading = captureLimits(headers, "chat");
  assert.equal(reading.rpm.limit, 100);
  assert.equal(reading.rpm.remaining, 0);
  assert.equal(reading.tpm.remaining, 1234);
  assert.equal(reading.retryAfterSeconds, 7);
  assert.equal(reading.source, "chat");
  assert.equal(typeof reading.at, "string", "the reading carries a timestamp");

  const snapshot = limitSnapshot();
  assert.equal(snapshot.rpm.remaining, 0);
  assert.equal(snapshot.tpm.limit, 500000);

  // The budget says "wait", so a call must fail before any request is sent.
  const adapter = new MistralVibeAdapter(() => ({ apiKey: "test-key", baseURL }));
  await assert.rejects(
    async () => {
      for await (const chunk of adapter.stream({ ...conversation, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })) {
        void chunk;
      }
    },
    (error) => {
      assert.equal(error.code, "RATE_LIMIT");
      assert.ok(
        typeof error.failure.retryAfterSeconds === "number" && error.failure.retryAfterSeconds >= 7,
        "the refusal carries the wait Mistral asked for",
      );
      return true;
    },
  );

  // A refilled budget must not block anything.
  captureLimits(new Map([["ratelimit-limit", "100"], ["ratelimit-remaining", "99"], ["ratelimit-reset", "30"]]), "models");
  const plain = new MistralVibeAdapter(() => ({ apiKey: "test-key", baseURL: `${baseURL}/plain` }));
  const prepared = await plain.prepareCall("mistral-vibe", "mistral-large-4");
  let seen = 0;
  for await (const chunk of prepared.stream({ ...conversation, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })) {
    if (chunk.type === "finish") seen += 1;
  }
  assert.equal(seen, 1, "a healthy budget still streams");
});

await test("the wire sanitiser drops every field Mistral does not declare", async () => {
  // Mistral validates message shapes strictly: an undeclared key is a 422 with
  // extra_forbidden. This is the last gate before JSON.stringify, so it must
  // hold even when a projection upstream widens a turn.
  const toolCalls = [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }];
  const out = sanitizeMessages([
    { role: "system", content: "s", cache_control: { type: "ephemeral" } },
    { role: "user", content: "u", name: "someone" },
    { role: "assistant", content: "answer", reasoning_content: "", extra: 1 },
    { role: "assistant", content: "", reasoning_content: "" },
    { role: "assistant", content: "", tool_calls: toolCalls, reasoning_content: "" },
    { role: "tool", tool_call_id: "c1", content: "ok", reasoning_content: "" },
    null,
  ]);
  assert.deepEqual(out, [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "answer" },
    { role: "assistant", content: "", tool_calls: toolCalls },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ]);
  assert.equal(JSON.stringify(out).includes("reasoning_content"), false, "no reasoning_content survives");
});

await test("a body leaves without a field Mistral does not declare", async () => {
  // The message projection already rebuilds every entry, so this guards the
  // serialised body: a history composed elsewhere (a fork, an import, another
  // provider's cache) must not be able to cost the whole turn with a 422.
  const body = JSON.stringify({
    model: "mistral-large-4",
    messages: [
      // The shape that slipped through a comma-anchored pattern: the field is
      // the *first* key of the object, so no preceding comma exists to match.
      { reasoning_content: "", role: "assistant", content: "" },
      { role: "assistant", content: "a", reasoning_content: "" },
      { role: "assistant", content: "b", reasoning_content: "quoted \"x\" and \\ slashes" },
      { role: "assistant", content: "c", cache_control: { type: "ephemeral" } },
      { role: "assistant", content: "d", reasoning: ["low"], reasoning_content: null },
      { role: "tool", tool_call_id: "abc", content: "ok" },
    ],
  });
  const clean = stripWireFields(body);
  for (const field of ["reasoning_content", "cache_control", '"reasoning"']) {
    assert.equal(clean.includes(field), false, `${field} must not survive serialisation`);
  }
  const parsed = JSON.parse(clean);
  assert.deepEqual(
    parsed.messages.map((message) => Object.keys(message).sort()),
    [
      ["content", "role"],
      ["content", "role"],
      ["content", "role"],
      ["content", "role"],
      ["content", "role"],
      ["content", "role", "tool_call_id"],
    ],
    "only declared keys remain",
  );
  assert.equal(parsed.messages[2].content, "b", "a neighbouring value is untouched");
});

await test("a forked session's stray reasoning_content and string content reach the wire clean", async () => {
  // A long or forked conversation can hand the adapter assistant turns that
  // still carry a reasoning_content key and, from older sessions, a plain
  // string content. Neither may be resent as-is.
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"id":"x","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
        );
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const adapter = new MistralVibeAdapter(() => ({ apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" }));
    const options = {
      provider: "mistral-vibe",
      model: "deepseek-v4-1-flash-1017",
      system: "s",
      messages: [
        { role: "user", content: [{ type: "text", text: "one" }] },
        { role: "assistant", content: "plain string answer", reasoning_content: "" },
        { role: "user", content: [{ type: "text", text: "two" }] },
        { role: "assistant", content: [{ type: "text", text: "block answer" }], reasoning_content: "" },
        { role: "user", content: [{ type: "text", text: "three" }] },
      ],
      maxTokens: 32,
    };
    for await (const chunk of adapter.stream(options)) void chunk;

    const body = captured[0];
    assert.equal(JSON.stringify(body).includes("reasoning_content"), false, "no reasoning_content on the wire");
    const assistant = body.messages.filter((message) => message.role === "assistant");
    assert.equal(assistant.length, 2, "a string-content turn is replayed, not dropped");
    for (const turn of assistant) {
      assert.deepEqual(Object.keys(turn).sort(), ["content", "role"], "assistant turns carry only role and content");
    }
    assert.equal(assistant[0].content, "plain string answer");
    assert.equal(assistant[1].content, "block answer");
  } finally {
    globalThis.fetch = original;
  }
});

await test("discovery lists one row per model, not one per alias", async () => {
  // `/v1/models` returns 64 rows for a handful of models: every alias is its own
  // row (codestral-2508 / codestral-latest / mistral-code-latest /
  // mistral-code-fim-latest are one model), each carrying the whole `aliases`
  // array, and `type` is "base" for all of them. The picker listed the API rows
  // verbatim, so one model showed up four times.
  const row = (id, aliases, capabilities = {}) => ({
    id,
    name: id,
    aliases,
    max_context_length: 256000,
    capabilities: { completion_chat: true, vision: false, reasoning: false, ...capabilities },
  });
  const payload = {
    data: [
      row("codestral-2508", ["codestral-latest", "mistral-code-latest", "mistral-code-fim-latest"]),
      row("codestral-latest", ["codestral-2508", "mistral-code-latest", "mistral-code-fim-latest"]),
      row("mistral-code-latest", ["codestral-2508", "codestral-latest", "mistral-code-fim-latest"]),
      row("mistral-code-fim-latest", ["codestral-2508", "codestral-latest", "mistral-code-latest"]),
      // A model the bundle has never heard of: one entry, under the id the API
      // answered first.
      row("glm-5-2", ["zai-glm-5-2"], { reasoning: true, vision: true }),
      row("zai-glm-5-2", ["glm-5-2"], { reasoning: true, vision: true }),
      // Rows that cannot answer a chat turn.
      row("codestral-embed", ["codestral-embed-2505"], { completion_chat: false }),
      row("mistral-ocr-2512", ["mistral-ocr-3"], { completion_chat: false, ocr: true }),
      row("voxtral-mini-tts-3", [], { completion_chat: false, audio_speech: true }),
      // Already in the shipped catalogue: served by that row, so the alias is
      // not listed a second time.
      row("mistral-large-4-0", ["mistral-large-4"]),
    ],
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const adapter = {
      settings: () => ({ baseURL: "https://api.mistral.ai/v1", disabledModels: [] }),
      apiKey: async () => "test-key",
    };
    const rows = await discoverModels(adapter, {});
    const discovered = rows.filter((entry) => entry.discovered === true);
    // The merged list is cumulative: rows another test already remembered are
    // part of the answer, so only this payload's model is asserted here.
    assert.ok(
      discovered.some((entry) => entry.id === "glm-5-2"),
      "the unseen chat model is added",
    );
    const glm = discovered.find((entry) => entry.id === "glm-5-2");
    assert.equal(glm.reasoning, true, "the API's reasoning flag survives");
    assert.deepEqual(glm.inputModalities, ["text", "image"], "so does its vision flag");
    assert.equal(
      discovered.filter((entry) => entry.id === "glm-5-2").length,
      1,
      "a model is listed once even after several fetches",
    );
    assert.equal(
      rows.filter((entry) => /embed|ocr|tts|transcribe|moderation/.test(entry.id)).length,
      0,
      "non-chat rows never reach the picker",
    );
    const ids = rows.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, "no id is listed twice");
    const names = rows.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length, "no model is listed twice under one name");
  } finally {
    globalThis.fetch = original;
  }
});



await test("stored discovered ids are pruned of non-chat families on read", async () => {
  // The first fetch stored 64 raw API ids, embedding and OCR rows included, and
  // the page rendered every one of them. A read now drops the families that
  // cannot chat before the picker ever sees them.
  assert.equal(isChatModelId("mistral-large-4"), true);
  assert.equal(isChatModelId("codestral-embed"), false);
  assert.equal(isChatModelId("mistral-ocr-3"), false);
  assert.equal(isChatModelId("voxtral-mini-tts-3"), false);
  assert.equal(isChatModelId("mistral-moderation-2603"), false);

  const adapter = {
    settings: () => ({
      baseURL: "https://api.mistral.ai/v1",
      disabledModels: [],
      discoveredModels: ["glm-5-2", "codestral-embed", "mistral-ocr-3", "voxtral-mini-raw"],
    }),
    apiKey: async () => {
      const error = new Error("no credential");
      error.code = "MISSING_CREDENTIAL";
      throw error;
    },
  };
  const rows = await discoverModels(adapter, {});
  const ids = rows.map((row) => row.id);
  assert.ok(ids.includes("glm-5-2"), "a stored chat model still resolves without a key");
  assert.equal(ids.some((id) => /embed|ocr|tts|transcribe|moderation/.test(id)), false, "the junk is gone");
});

await test("models.dev records are read field by field, not by id guesses", async () => {
  // `type` is the only honest "this is not a chat model" signal, `modalities.input`
  // is the only honest vision signal (`attachment` is also true for pdf/audio),
  // and the ladder is whatever `reasoning_options` lists.
  const facts = modelsDevFacts({
    type: "embedding",
    modalities: { input: ["text"] },
    limit: { context: 8000, output: 3072 },
  });
  assert.equal(facts.chat, false, "an embedding record is not chattable");

  const audio = modelsDevFacts({
    name: "Audio Only",
    attachment: true,
    modalities: { input: ["text", "audio", "pdf"] },
    limit: { context: 32768, output: 32000 },
  });
  assert.equal(audio.chat, true);
  assert.equal(audio.vision, false, "attachment alone does not mean image input");

  const vision = modelsDevFacts({
    name: "Vision",
    modalities: { input: ["text", "image"] },
    limit: { context: 262144 },
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "high", "max"] }],
  });
  assert.equal(vision.vision, true);
  assert.deepEqual(vision.levels, ["off", "high", "max"], "none maps to off");

  const silent = modelsDevFacts({ reasoning: true });
  assert.equal(silent.levels, undefined, "no published ladder means no ladder");

  // And discovery honours it end to end.
  const local = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.url !== "/v1/models") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            { id: "mistral-large-9", name: "mistral-large-9", max_context_length: 999424, capabilities: { completion_chat: true, vision: true, reasoning: true } },
            { id: "voxtral-mini-tts-99", name: "Voxtral Mini TTS", capabilities: { completion_chat: true } },
            { id: "mistral-audio-only-99", name: "Audio Only", max_context_length: 32768, capabilities: { completion_chat: true, vision: true } },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  const { port: localPort } = local.address();
  const adapter = new MistralVibeAdapter(() => ({
    baseURL: `http://127.0.0.1:${localPort}/v1`,
    apiKey: "sk-test",
    disabledModels: [],
  }));

  try {
    const rows = await discoverModels(adapter, {});
    const ids = rows.map((row) => row.id);
    assert.equal(ids.includes("voxtral-mini-tts-99"), false, "a speech record never reaches the picker");
    const large = rows.find((row) => row.id === "mistral-large-9");
    assert.deepEqual(large.levels, ["off", "high", "max"], "the ladder comes from models.dev");
    assert.equal(large.contextWindow, 999424);
    assert.deepEqual(large.inputModalities, ["text", "image"]);
    const audio = rows.find((row) => row.id === "mistral-audio-only-99");
    assert.deepEqual(audio.inputModalities, ["text"], "the API claimed vision, the modality list denies it");
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

await test("one fetch is enough: the stored list serves the page and the picker", async () => {
  // The complaint this locks down: the page showed the hardcoded catalogue and
  // needed another fetch to see the models Mistral had already reported. One
  // stored list must answer for both the page and the chat picker, with no
  // network call, and a hidden id must stay hidden in both.
  const stored = [
    {
      id: "mistral-large-5",
      name: "Mistral Large 5",
      contextWindow: 524288,
      maxTokens: 65536,
      inputModalities: ["text"],
      reasoning: true,
      levels: ["off", "high"],
      discovered: true,
    },
    {
      id: "mistral-large-4",
      name: "Mistral Large 4",
      contextWindow: 1048576,
      maxTokens: 262144,
      inputModalities: ["text", "image"],
      reasoning: true,
      levels: ["low", "medium", "high"],
      discovered: false,
    },
  ];
  const settings = () => ({
    baseURL: "https://api.mistral.ai/v1",
    disabledModels: ["mistral-large-4"],
    modelsJson: JSON.stringify(stored),
  });
  const offline = new MistralVibeAdapter(settings);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("the suite must not reach the network here");
  };
  try {
    const picker = await offline.listModels("mistral-vibe");
    assert.deepEqual(
      picker.map((entry) => entry.id),
      ["mistral-large-5"],
      "the picker reads the store, minus the hidden id",
    );
    const page = await discoverModels({ settings, apiKey: async () => {
      const missing = new Error("no credential");
      missing.code = "MISSING_CREDENTIAL";
      throw missing;
    } }, {});
    // The page lists a hidden row too, ticked off, so it can be restored; the
    // picker is the surface that must not advertise it.
    assert.deepEqual(
      page.map((row) => row.id),
      ["mistral-large-5", "mistral-large-4"],
      "the page shows the stored list without fetching",
    );
    assert.equal(
      page.find((row) => row.id === "mistral-large-4").disabled,
      true,
      "a stored row keeps its hidden state",
    );
    assert.equal(page[0].name, "Mistral Large 5", "the stored name survives");
    assert.deepEqual(page[0].levels, ["off", "high"], "the stored ladder survives");
    assert.equal(calls, 0, "no request was made to serve the stored list");
    const resolved = await offline.resolveModel("mistral-vibe", "mistral-large-5");
    assert.equal(resolved.context.contextWindow, 524288, "the stored limits resolve a chat turn");
    assert.deepEqual(resolved.name, "Mistral Large 5");
  } finally {
    globalThis.fetch = original;
  }
});

server.close();
console.log(results.join("\n"));

