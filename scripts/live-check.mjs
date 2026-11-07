/**
 * Live probe against the real API: proves the adapter survives a long, forked
 * history whose assistant turns carry the DeepSeek replay field.
 *
 * The key is taken from the environment first, then from the row config of an
 * installed profile. Nothing about a particular user or machine is baked in:
 * the profile directory comes from `DSH_HOME` (or `~/.dsh`), the profile name
 * from `DSH_PROFILE` (or `web`), and the row id from the bundle itself.
 *
 *   MISTRAL_API_KEY=… node scripts/live-check.mjs
 *   DSH_PROFILE=default node scripts/live-check.mjs
 */
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MistralVibeAdapter } from "../lib/index.js";

const PROFILE_NAME = process.env.DSH_PROFILE ?? "web";
const ROW_ID = "llm-mistral-vibe";
const PATCH_PATH = join(
  process.env.DSH_HOME ?? join(homedir(), ".dsh"),
  "profiles",
  PROFILE_NAME,
  "cordis.patch.yml",
);

/** Read the row's `apiKey` from an installed profile, if there is one. */
function keyFromPatchFile() {
  let patch;
  try {
    patch = fs.readFileSync(PATCH_PATH, "utf8");
  } catch {
    return undefined;
  }
  const match = patch.match(
    new RegExp(`- id: ${ROW_ID}[\\s\\S]*?apiKey:\\s*["']?([A-Za-z0-9=_\\-\\.]{8,})`),
  );
  return match?.[1];
}

const fromEnv = (process.env.MISTRAL_API_KEY ?? "").trim();
const fromPatch = fromEnv.length > 0 ? undefined : keyFromPatchFile();
const key = fromEnv.length > 0 ? fromEnv : fromPatch;
if (key === undefined) {
  console.log("no key: set MISTRAL_API_KEY (a row in " + PATCH_PATH + " was not found either)");
  process.exit(1);
}
console.log("key source:", fromPatch === undefined ? "environment" : PATCH_PATH, "length", key.length);

// A long, forked-looking history: every assistant turn replayed with the
// DeepSeek field and an internal reasoning block.
const messages = [{ role: "user", content: [{ type: "text", text: "Say OK." }] }];
for (let i = 0; i < 14; i += 1) {
  messages.push({
    role: "assistant",
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: `answer ${i}` },
    ],
    reasoning_content: "",
  });
  messages.push({ role: "user", content: [{ type: "text", text: `next ${i}` }] });
}
messages.push({ role: "assistant", content: [{ type: "text", text: "last" }], reasoning_content: "" });
messages.push({ role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] });

const adapter = new MistralVibeAdapter(() => ({ apiKey: key, baseURL: "https://api.mistral.ai/v1" }));
const options = {
  provider: "mistral-vibe",
  model: "mistral-small-latest",
  system: "Be terse.",
  messages,
  maxTokens: 16,
};

let text = "";
let usage;
let finish;
for await (const chunk of adapter.stream(options)) {
  if (chunk.type === "text-delta") text += chunk.text;
  if (chunk.type === "usage") usage = chunk.usage;
  if (chunk.type === "finish") finish = chunk.reason;
}
console.log("adapter path:", JSON.stringify({ text: text.slice(0, 40), usage, finish }));

// Control: the same turns without the projection, straight to the wire.
const raw = {
  model: "mistral-small-latest",
  stream: false,
  max_tokens: 8,
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "answer", reasoning_content: "" },
    { role: "user", content: "again" },
  ],
};
const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify(raw),
});
const body = await res.text();
console.log("control (raw reasoning_content):", res.status, body.slice(0, 160).replace(/\s+/g, " "));
