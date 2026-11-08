/**
 * Client-half harness: evaluates lib/client.js the way the shell does — through
 * `window.__ModuleLoader__.load` — with a React stub and a fetch recorder.
 *
 * What it proves is the wiring the shell depends on: the registration lands in
 * `settings.section`, the page reaches the Host half over its own loopback
 * routes, and nothing tries to drive the schema form or a slot the shell does
 * not declare. Rendering itself is exercised by the running app.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

/* ------------------------------------------------------------------ React */

// Hooks are inert here, so a component that reads state can only be exercised
// with a seed: the index of each useState call is fixed by the component's own
// declaration order (0 = config payload, 9 = quota). Seeding is what lets the
// render reach the quota card at all — a TDZ bug in it stays invisible while
// every hook returns null.
const hookSeeds = { values: {} };
function seedHooks(values) {
  hookSeeds.values = { ...values };
  hookSeeds.cursor = 0;
}

const reactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  useState: (initial) => {
    const index = hookSeeds.cursor ?? 0;
    hookSeeds.cursor = index + 1;
    if (index in hookSeeds.values) return [hookSeeds.values[index], () => {}];
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  memo: (fn) => fn,
  Component: class {
    constructor(props) {
      this.props = props;
      this.state = { error: null };
    }
  },
  Fragment: "fragment",
};

/* ------------------------------------------------------------------ fetch */

const calls = [];
const responses = new Map();
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
  const payload = responses.get(String(url)) ?? { ok: true };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
};

/* ------------------------------------------------------------ module table */

let registration;
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => {
      registration = value;
    },
  },
};

const module_ = await import(pathToFileURL(join(root, "lib", "client.js")).href);
const exported = module_.default ?? registration?.factory?.((specifier) => {
  if (specifier === "react") return reactStub;
  throw new Error(`unexpected require("${specifier}")`);
});

assert.equal(registration?.id, "dsh-mistral-vibe", "the bundle registers under the package id");
assert.equal(typeof exported, "object", "the factory returns the module exports");

/* ------------------------------------------------------------ registration */

const registrations = [];
const slotsService = {
  inject(name, callback) {
    assert.ok(
      name === "settings.section" || name === "settings.section.icon",
      `unexpected slot request: ${name}`,
    );
    callback();
  },
  register(meta, component) {
    registrations.push({ meta, component });
    return () => {};
  },
};

assert.equal(exported.name, "dsh-mistral-vibe");
assert.deepEqual(exported.inject, ["slots"], "waiting only on slots can never wedge the boot");
assert.equal(typeof exported.apply, "function");
assert.equal(exported.apply({ slots: slotsService }), undefined, "apply returns undefined; disposal is the loader's");

assert.equal(registrations.length, 2, "the page and its nav glyph are both registered");
const cell = registrations.find((entry) => entry.meta.name === "settings.section");
const glyph = registrations.find((entry) => entry.meta.name === "settings.section.icon");
assert.ok(cell !== undefined, "the settings section is registered");
assert.ok(glyph !== undefined, "the nav glyph is registered under the same id");
assert.equal(cell.meta.id, "mistral-vibe", "a fresh cell id, so no shipped section is replaced");
assert.equal(typeof cell.meta.order, "number", "order is numeric");
assert.equal(typeof cell.meta.label, "function", "the label is a thunk so it follows the locale");
assert.equal(cell.meta.label(), "Mistral Vibe");
assert.equal(typeof cell.component, "function", "the cell renders a component");
assert.equal(glyph.meta.id, "mistral-vibe", "the glyph id must equal the section id or it never renders");
const mark = glyph.component({ size: 20, active: true });
assert.equal(mark.type, "svg", "the glyph is inline SVG so it can follow currentColor");
assert.equal(mark.props.width, 20, "the glyph follows the size the shell passes");
assert.equal(glyph.component({ size: 16, active: false }).props.style.opacity, 0.72, "an inactive section dims its glyph");

// The mark is the package artwork, path for path. Comparing the two files is
// the only check that survives someone "tidying" the path data later.
const iconSource = readFileSync(new URL("../icon.svg", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const iconPaths = [...iconSource.matchAll(/ d="(M[^"]+)"/g)].map((match) => match[1]);
const iconStops = [...iconSource.matchAll(/stop-color="(#[0-9A-Fa-f]{6})"/g)].map((match) => match[1]);
assert.equal(iconPaths.length, 3, "icon.svg carries three glyph paths");
assert.equal(iconStops.length, 3, "icon.svg carries a three-stop gradient");
for (const path of iconPaths) {
  assert.ok(clientSource.includes(`d: "${path}"`), `the mark draws icon.svg path ${path}`);
}
for (const stop of iconStops) {
  assert.ok(clientSource.includes(`stopColor: "${stop}"`), `the mark keeps the icon stop ${stop}`);
}
assert.match(clientSource, /viewBox: "0 0 64 64"/, "the mark uses the icon's viewBox");
assert.match(clientSource, /x: 2, y: 2, width: 60, height: 60, rx: 14/, "the icon's rounded tile");
assert.match(clientSource, /strokeWidth: 4/, "the icon's stroke weight");
assert.doesNotMatch(clientSource, /wind bands/, "the improvised mark is gone");
assert.equal(mark.props.viewBox, "0 0 64 64", "the rendered glyph is in icon space");

/* -------------------------------------------------------------- rendering */

// A stub render: hooks are inert, so this is the pre-fetch state, which must be
// a real node rather than a crash. The boundary wraps the page, so render the
// page element it carries.
const boundary = cell.component();
assert.ok(boundary !== null && typeof boundary === "object", "the cell renders a boundary element");
const inner = boundary.children[0];
assert.equal(typeof inner.type, "function", "the boundary carries the page component");
const tree = inner.type(inner.props);
const flatten = (node, out = []) => {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node !== "object") {
    out.push(String(node));
    return out;
  }
  // A function element is rendered by React, not by this walk: call it so the
  // text inside `ModelCell` / `SecretField` is part of the transcript too.
  if (typeof node.type === "function" && node.type.prototype?.isReactComponent !== true) {
    flatten(node.type(node.props), out);
  }
  flatten(node.children, out);
  return out;
};
assert.match(flatten(tree).join(" "), /Loading the Mistral Vibe route/, "the first paint is a loading state");

// A populated render. Every hook is seeded, so the body actually executes —
// the shape that crashed the page with "Cannot access 'vibeAllowance' before
// initialization" while the loading-only stub kept reporting PASS.
seedHooks({
  0: {
    displayName: "Mistral Vibe",
    route: "mistral-vibe",
    baseURL: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    build: "1.0.0+abc12345",
    hasKey: true,
    hasStudioKey: false,
    monthlyCapUSD: 150,
    apiAllowanceUSD: 15,
    disabledModels: ["ministral-8b-2512"],
    models: [
      {
        id: "mistral-large-4",
        name: "Mistral Large 4",
        contextWindow: 1048576,
        maxTokens: 262144,
        inputModalities: ["text", "image"],
        reasoning: true,
        levels: ["low", "medium", "high"],
      },
      {
        id: "glm-5-2",
        name: "glm-5-2",
        contextWindow: 262144,
        inputModalities: ["text"],
        reasoning: true,
        discovered: true,
      },
      { id: "codestral-2508", name: "Codestral 25.08", contextWindow: 256000, inputModalities: ["text"] },
    ],
  },
});
const populated = flatten(exported.MistralVibeSection()).join(" ");
seedHooks({});
assert.match(populated, /API keys/, "the credentials card renders");
assert.match(populated, /Save key/, "the chat key control renders");
assert.match(populated, /Save Studio key/, "the account key control renders");
assert.match(populated, /Vibe Code API key/, "the chat key is labelled with the Vibe Code name");
assert.match(populated, /Studio API key/, "the account key is labelled with the Studio name");
// No destructive control on a secret: an empty field and Save is the only unset,
// so a mis-click cannot wipe a working credential.
assert.doesNotMatch(populated, /\bClear\b/, "no clear control on either key");
assert.match(populated, /(^|\s)Models(\s|$)/, "the model card renders under the bare heading");
assert.match(populated, /Mistral Large 4/, "the model list renders from the Host payload");
assert.doesNotMatch(populated, /Usage & limits/, "the removed usage card stays gone");

// The page states no prose the controls already imply: no scoping paragraph,
// no key-issuance paragraph, no route/model tally, no stored/fallback badges.
assert.doesNotMatch(populated, /scoped to the mistral-vibe route/, "the model-card explainer is gone");
assert.doesNotMatch(populated, /Mistral issues a Vibe Code key/, "the key-card explainer is gone");
assert.doesNotMatch(populated, /Mistral API catalogue/, "the catalogue subtitle is replaced by a button");
assert.doesNotMatch(populated, /·\s*\d+\s+models/, "the route tally line is gone");
assert.doesNotMatch(populated, /\b(hidden|not stored)\b/, "status badges are gone");
assert.doesNotMatch(populated, /\b(Reveal|Hide)\b/, "no separate reveal button: the eye lives inside the field");
assert.match(populated, /Fetch available models/, "the fetch control sits on the Models card");
// The page can also answer a web UI exposed over HTTP/S: that needs a token, and
// the copy this browser holds is what the request carries.
assert.match(populated, /Remote access/, "the exposed-deployment card renders");
assert.match(populated, /Answer this page when the web UI is exposed/, "the toggle explains itself");
assert.match(populated, /Access token/, "the token field renders");
assert.match(populated, /Save token/, "the token can be stored");
assert.match(populated, /no token set/, "the card reports that no token exists yet");
// The page names the host build it is talking to, so "applied" can be checked
// against "loaded": a module cached in the host process answers without a build.
assert.match(populated, /host build 1\.0\.0\+/, "the loaded host build is on the page");

// Every row names the model and states what it can do: the ladder, the
// modality, the context window. A discovered row whose effort list the API does
// not publish says so instead of looking like a non-reasoning model.
assert.match(populated, /Mistral Large 4/, "the catalogue row still carries its display name");
assert.match(populated, /low · medium · high/, "the thinking ladder is on the row");
assert.match(populated, /text \+ image/, "the modality is on the row");
assert.match(populated, /1024K ctx/, "the context window is on the row");
assert.match(populated, /thinking \(levels unknown\)/, "a discovered reasoning model admits its unknown ladder");
assert.match(populated, /no thinking/, "a non-reasoning model says so");
assert.match(populated, /Codestral 25\.08/, "a row without reasoning still shows its name");

// The eye control is a real button with an accessible name and a pressed state,
// and the input keeps room for the glyph so the two never overlap.
const elements = (node, out = []) => {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if (typeof node !== "object") return out;
  out.push(node);
  // A function-typed element is rendered by React, not by this walk: call it so
  // the leaf controls inside `Field` / `SecretField` are reachable.
  if (typeof node.type === "function" && node.type.prototype?.isReactComponent !== true) {
    elements(node.type(node.props), out);
  }
  elements(node.children, out);
  return out;
};
seedHooks({
  0: {
    displayName: "Mistral Vibe",
    route: "mistral-vibe",
    baseURL: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    hasKey: true,
    hasStudioKey: true,
    disabledModels: [],
    models: [{ id: "mistral-large-4", name: "Mistral Large 4", contextWindow: 1024, inputModalities: ["text"] }],
  },
});
const nodes = elements(exported.MistralVibeSection());
seedHooks({});
const eye = nodes.filter((node) => node.type === "button" && /key$/.test(node.props?.["aria-label"] ?? ""));
assert.equal(eye.length, 3, "each secret field owns exactly one eye toggle");
assert.equal(typeof eye[0].props.onClick, "function", "the eye toggles its field");
assert.equal(eye[0].props["aria-pressed"], false, "a masked field reports the un-pressed state");
const passwordFields = nodes.filter((node) => node.type === "input" && node.props?.type === "password");
assert.equal(passwordFields.length, 3, "every secret starts masked");
assert.equal(passwordFields[0].props.style.paddingRight, 34, "the input reserves room for the eye glyph");

// Type sizes: the field, the card headings and the buttons all render at 13px,
// so a text input is never smaller than the heading above it.
assert.match(source, /fontSize: 13,\n\t\t\tlineHeight: "20px"/, "the field style pins the 13px body size");
assert.ok((source.match(/fontSize: 13/g) ?? []).length >= 3, "headings, buttons and fields share one size step");


// Both credentials must be on the page: Mistral issues a Vibe Code key and a
// Studio key separately, and only the Studio key can read the account.
for (const needle of [
  "Vibe Code API key",
  "Studio API key",
  "Save key",
  "Save Studio key",
]) {
  assert.ok(source.includes(needle), `the page must mention "${needle}"`);
}
assert.ok(!/apiKeyEnv\b[^\n]*input/.test(source), "the page must not expose the env-var name as an input");

// A shell with no slots service must not throw.
assert.equal(exported.apply({}), undefined, "a service-less context is a no-op, not a crash");
assert.equal(exported.apply({ get: () => undefined }), undefined, "ctx.get fallback is also a no-op");

/* ------------------------------------------------------------- data plane */

assert.match(source, /\/mistral-vibe\/config/, "the page reads and writes through the Host route");
assert.match(source, /\/mistral-vibe\/discover/, "model discovery is a Host route, not a browser call to Mistral");
assert.match(source, /cache: "no-store"/, "the page never reads a stale config");

// The two rejected shapes must not come back.
assert.doesNotMatch(source, /plugins\.row\.config/, "the row-config slot is not the settings page");
assert.doesNotMatch(source, /form\.mutate/, "the page owns no schema form");
assert.doesNotMatch(source, /configForms/, "the page does not depend on configForms");
assert.doesNotMatch(source, /require\("@deepseek-ai/, "no harness UI package is required at runtime");

assert.doesNotMatch(source, /mistral-vibe\/limits/, "no limits route is read: the card was removed");
assert.doesNotMatch(source, /Usage & limits/, "the usage card is gone");
assert.doesNotMatch(source, /billing\/subscription|readSubscription/, "no billing read remains");
assert.doesNotMatch(source, /quotaCard|planFields/, "its renderers are gone too");

console.log("PASS client half registers the settings.section page Mistral Vibe");
console.log("PASS the nav glyph is registered under the same id (settings.section.icon)");
console.log("PASS the page talks to /mistral-vibe/config and /mistral-vibe/discover");
console.log("PASS no schema form, no plugins.row.config, no harness UI imports");
console.log("PASS a populated render shows both key cards and the model list");
console.log(`PASS apply() is inert without services (${calls.length} fetch calls at import)`);
