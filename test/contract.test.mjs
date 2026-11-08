/**
 * Contract test against the real harness assembler.
 *
 * The host test file proves this route's own behaviour. This one proves that what
 * the route emits survives the code that actually stores a session: the harness's
 * `AssistantStreamAccumulator` rejects an unknown chunk type, a non-integer index
 * and a non-string `argumentsDelta`; its `BlockAssembler` folds deltas into the
 * assistant message; and the session log refuses a repeated tool-call id or a
 * `tool/call` whose name/arguments differ from the advertised block.
 *
 * The harness lives in the DeepSeek Harness install, so this file reports SKIP
 * rather than failing when that install is not present.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { MistralVibeAdapter } from "../lib/index.js";

const HARNESS = process.env.DSH_LLM_PATH ??
  "C:\\Users\\Win\\AppData\\Local\\Programs\\DSH NEXT\\resources\\app\\node_modules\\@deepseek-ai\\dsh-llm\\lib\\index.js";

if (!existsSync(HARNESS)) {
  console.log(`SKIP harness contract test — ${HARNESS} not found`);
  process.exit(0);
}

const { AssistantStreamAccumulator, assembleAssistantStream } = await import(
  pathToFileURL(HARNESS).href
);

/* -------------------------------------------------------------------------- *
 * A Mistral-shaped SSE server. Each `?case=` selects one scripted response.
 * -------------------------------------------------------------------------- */

const sse = (events) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

const usageEvent = {
  id: "cmpl-contract",
  usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  choices: [],
};

const twoCalls = [
  // Both ids share the harness's long prefix: the exact shape that used to collapse
  // to one id and make the log unrepeatable.
  { index: 0, id: "chatcmpltoolcall00contractAAA", function: { name: "get_", arguments: '{"pa' } },
  { index: 0, id: "chatcmpltoolcall00contractAAA", function: { name: "weather", arguments: 'th":"/tmp"}' } },
  { index: 1, id: "chatcmpltoolcall00contractBBB", function: { name: "read_file", arguments: '{"pa' } },
  { index: 1, id: "chatcmpltoolcall00contractBBB", function: { name: "", arguments: 'th":"/etc/hosts"}' } },
  { index: 0, function: { name: "", arguments: "" } },
  { index: 1, function: { name: "", arguments: "" } },
];

const scripts = {
  "/v1/calls": [
    { choices: [{ index: 0, delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "think first" }] }] } }] },
    { choices: [{ index: 0, delta: { content: [{ type: "text", text: "I will call two tools." }] } }] },
    ...twoCalls.map((call) => ({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })),
    usageEvent,
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ],
  // Two calls in one event, neither carrying an index.
  "/v1/noindex": [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { id: "chatcmpltoolcall00noindexAAAA", function: { name: "first_tool", arguments: '{"a":1}' } },
              { id: "chatcmpltoolcall00noindexBBBB", function: { name: "second_tool", arguments: '{"b":2}' } },
            ],
          },
        },
      ],
    },
    usageEvent,
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ],
};

const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const pathname = new URL(request.url, "http://localhost").pathname.replace(/\/chat\/completions$/, "");
    const events = scripts[pathname];
    if (events === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "no script" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse(events));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const adapterAt = (path) =>
  new MistralVibeAdapter(() => ({
    apiKey: "sk-contract",
    baseURL: `http://127.0.0.1:${port}${path}`,
    disabledModels: [],
    discoveredModels: [],
  }));

const collect = async (adapter, model = "mistral-large-4") => {
  const prepared = await adapter.prepareCall("mistral-vibe", model);
  const chunks = [];
  for await (const chunk of prepared.stream({ model, messages: [{ role: "user", content: "go" }] })) {
    chunks.push(chunk);
  }
  return chunks;
};

/** Run the harness accumulator + assembler, exactly as a live turn does. */
const assemble = (chunks) => {
  const accumulator = new AssistantStreamAccumulator();
  let time = 1;
  for (const chunk of chunks) accumulator.push({ time: (time += 1), chunk });
  return assembleAssistantStream(accumulator.snapshot()).assembled();
};

const results = [];
async function test(name, run) {
  try {
    await run();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const ALLOWED = new Set([
  "block-start",
  "block-end",
  "text-delta",
  "reasoning-delta",
  "tool-call-delta",
  "usage",
  "finish",
]);

await test("every chunk this route emits is a chunk the harness accepts", async () => {
  const chunks = await collect(adapterAt("/v1/calls"));
  for (const chunk of chunks) {
    assert.ok(ALLOWED.has(chunk.type), `unexpected chunk type ${chunk.type}`);
    if (chunk.index !== undefined) {
      assert.ok(Number.isSafeInteger(chunk.index) && chunk.index >= 0, `bad index on ${chunk.type}`);
    }
    if (chunk.type === "tool-call-delta") {
      assert.equal(typeof chunk.id, "string");
      assert.ok(chunk.id.length > 0, "a tool-call-delta id must not be empty");
      assert.equal(typeof chunk.argumentsDelta, "string", "argumentsDelta must be a string");
      if ("name" in chunk) assert.ok(chunk.name.length > 0, "name must be absent rather than empty");
    }
  }
  // Nothing may follow the finish chunk.
  const finishAt = chunks.findIndex((chunk) => chunk.type === "finish");
  assert.ok(finishAt >= 0, "the stream must finish");
  assert.equal(finishAt, chunks.length - 1, "nothing may follow finish");
  const usageAt = chunks.findIndex((chunk) => chunk.type === "usage");
  assert.ok(usageAt >= 0 && usageAt < finishAt, "usage must precede finish");
});

await test("the harness assembler turns the stream into one coherent message", async () => {
  const chunks = await collect(adapterAt("/v1/calls"));
  const { blocks } = assemble(chunks);
  assert.deepEqual(blocks.map((block) => block.type), ["reasoning", "text", "tool-call", "tool-call"]);
  assert.equal(blocks[0].text, "think first");
  assert.equal(blocks[1].text, "I will call two tools.");
  assert.equal(blocks[2].name, "get_weather", "a fragmented name is joined, not truncated");
  assert.equal(blocks[2].arguments, '{"path":"/tmp"}');
  assert.equal(blocks[3].name, "read_file");
  assert.equal(blocks[3].arguments, '{"path":"/etc/hosts"}');
  // The session log keys tools by id, so a repeat anywhere is fatal.
  const ids = blocks.filter((block) => block.type === "tool-call").map((block) => block.id);
  assert.equal(new Set(ids).size, ids.length, "advertised tool-call ids must be distinct");
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{9}$/);
});

await test("the advertised arguments parse, so a tool/call can echo them byte for byte", async () => {
  const chunks = await collect(adapterAt("/v1/calls"));
  const { blocks } = assemble(chunks);
  const expected = { get_weather: { path: "/tmp" }, read_file: { path: "/etc/hosts" } };
  for (const block of blocks.filter((value) => value.type === "tool-call")) {
    assert.deepEqual(JSON.parse(block.arguments), expected[block.name], `${block.name} arguments`);
  }
});

await test("a second turn never repeats an id from the first turn", async () => {
  // The provider numbers its calls per response (`call_1`, `call_2`), so the same
  // two ids arrive in both turns. The session log rejects the repeat, so the ids
  // this route advertises must differ between turns.
  const adapter = adapterAt("/v1/calls");
  const first = assemble(await collect(adapter)).blocks.filter((block) => block.type === "tool-call");
  const second = assemble(await collect(adapter)).blocks.filter((block) => block.type === "tool-call");
  const ids = [...first, ...second].map((block) => block.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique across turns, not just within one");
});

await test("two calls in one event without an index stay two calls", async () => {
  const chunks = await collect(adapterAt("/v1/noindex"));
  const { blocks } = assemble(chunks);
  const calls = blocks.filter((block) => block.type === "tool-call");
  assert.equal(calls.length, 2, "each call keeps its own block");
  assert.deepEqual(calls.map((call) => call.name), ["first_tool", "second_tool"]);
  assert.deepEqual(calls.map((call) => call.arguments), ['{"a":1}', '{"b":2}']);
  assert.equal(new Set(calls.map((call) => call.id)).size, 2);
});

server.close();
console.log(results.join("\n"));
