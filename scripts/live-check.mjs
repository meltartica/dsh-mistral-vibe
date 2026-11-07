import fs from "node:fs";
import { MistralVibeAdapter, sanitizeMessages } from "../lib/index.js";

const patch = fs.readFileSync("C:/Users/Win/.dsh/profiles/web/cordis.patch.yml", "utf8");
const m = patch.match(/- id: llm-mistral-vibe[\s\S]*?apiKey:\s*"?'?([A-Za-z0-9=_\-\.]{8,})/);
const key = m?.[1] ?? process.env.MISTRAL_API_KEY;
if (!key) { console.log("no key available in the row or env"); process.exit(1); }
console.log("key source:", m ? "row config" : "env", "length", key.length);

// A long, forked-looking history: every assistant turn replayed with the
// DeepSeek field and an internal reasoning block.
const messages = [{ role: "user", content: [{ type: "text", text: "Say OK." }] }];
for (let i = 0; i < 14; i += 1) {
  messages.push({ role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: `answer ${i}` }], reasoning_content: "" });
  messages.push({ role: "user", content: [{ type: "text", text: `next ${i}` }] });
}
messages.push({ role: "assistant", content: [{ type: "text", text: "last" }], reasoning_content: "" });
messages.push({ role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] });

const adapter = new MistralVibeAdapter(() => ({ apiKey: key, baseURL: "https://api.mistral.ai/v1" }));
const options = { provider: "mistral-vibe", model: "mistral-small-latest", system: "Be terse.", messages, maxTokens: 16 };

let text = "";
let usage;
let finish;
for await (const chunk of adapter.stream(options)) {
  if (chunk.type === "text-delta") text += chunk.text;
  if (chunk.type === "usage") usage = chunk.usage;
  if (chunk.type === "finish") finish = chunk.reason;
}
console.log("adapter path:", JSON.stringify({ text: text.slice(0, 40), usage, finish }));

// Control: the same turns without the sanitiser, straight to the wire.
const raw = { model: "mistral-small-latest", stream: false, max_tokens: 8,
  messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "answer", reasoning_content: "" }, { role: "user", content: "again" }] };
const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(raw) });
const body = await res.text();
console.log("control (raw reasoning_content):", res.status, body.slice(0, 160).replace(/\s+/g, " "));
