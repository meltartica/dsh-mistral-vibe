# dsh-mistral-vibe

Mistral Vibe in DeepSeek Harness: a provider route for [Mistral La Plateforme](https://docs.mistral.ai/)
that ships the current Vibe model catalogue, maps each model's thinking levels onto
`reasoning_effort`, streams reasoning back as a thinking block, and gives the route a
real settings page.

Self-contained by design: no imports from `@deepseek-ai/*` or `pi-ai`, no install-time
dependencies. The two schema helpers it needs are vendored under `vendor/`.

## Features

- **One provider route, `mistral-vibe`** — chat and streaming through
  `POST /v1/chat/completions`, with tool calls, usage, and `providerRetryPolicy`.
- **Thinking levels per model**, taken from what the catalogue actually publishes:
  `off` → `reasoning_effort: "none"`, `low`/`medium`/`high`/`max` sent verbatim. A model
  with no ladder gets no level control and never receives an unsupported effort.
- **Reasoning streamed as a block**, not as text: `delta.content` arrays of
  `{type: "thinking"}` become `reasoning-delta`, so the harness renders them as thinking.
- **A model list that is data, not code.** One fetch writes the whole list
  (shipped rows + everything the API reported) into the row's `modelsJson`; the chat
  picker, the settings page and id resolution all read that store, so nothing has to be
  fetched twice.
- **One row per model.** `/v1/models` lists every alias as its own row (64 rows for 13
  models, `type: "base"` on all of them); discovery unions each row with its `aliases`
  array and emits one entry per model.
- **`models.dev` supplies the ladder**, read field by field rather than guessed from
  ids: `type` for chattability, `modalities.input` for vision (`attachment: true` is
  also set on pdf/audio-only models), `limit.*` for the windows, `reasoning_options` for
  the levels.
- **A settings page** at Settings → **Mistral Vibe**: both credentials with an eye toggle,
  the endpoint, and the model list with its ladder, modality and window on every row.
- **Secrets stay out of the row file.** A saved key goes to the credential store; the
  YAML keeps only the reference.
- **No quota fiction.** Mistral exposes no readable allowance (`/v1/billing/subscription`
  returns a plan name and nothing else), so the page shows no meter. The route still
  captures rate-limit headers and refuses a call locally when a header already reported
  `remaining: 0`.

## Install

Requires DeepSeek Harness with the `dsh` CLI.

```sh
# from a directory containing this repo (or publish it, then use the bare name);
# <name> is the profile you boot, e.g. `web`
dsh plugin --profile <name> add ./dsh-mistral-vibe
dsh --profile <name>
```

Then open Settings → **Models**, pick **Mistral Vibe**, and paste a Vibe Code API key.

### Other install methods

From a packed tarball (`npm run pack` produces `dsh-mistral-vibe-<version>.tgz`):

```sh
dsh plugin --profile <name> add ./dsh-mistral-vibe-<version>.tgz
```

This package is not built: `lib/` is the shipped source, so a profile loads exactly what
is in the repo.

## Configuration

Settings → **Mistral Vibe** owns every field. The same row is editable in
`cordis.patch.yml` if you prefer text.

| field | default | meaning |
| --- | --- | --- |
| `displayName` | `Mistral Vibe` | the label the picker shows for this route |
| `baseURL` | `https://api.mistral.ai/v1` | chat and model-list endpoint |
| `apiKey` | — | Vibe Code key, sent as `Authorization: Bearer` |
| `studioApiKey` | — | Studio/API key for account reads; falls back to the Vibe Code key |
| `apiKeyEnv` | `MISTRAL_API_KEY` | credential-store name consulted when the row is empty |
| `disabledModels` | `[]` | ids hidden from the picker, still listed on the page |
| `modelsJson` | `""` | the stored model list, written by **Fetch available models** |

Both keys are `role("secret")` and `volatile()`. The page never receives either value —
it gets `hasKey` / `hasStudioKey` booleans.

### Fetching the model list

**Fetch available models** calls `GET /v1/models` with the draft key, merges the answer
into the stored list, and saves it. What lands in the store:

- rows the shipped catalogue already serves, with their real limits and ladder;
- rows Mistral serves that the bundle does not ship, marked **new**;
- nothing that models.dev calls an `embedding`, `speech` or `transcription` record.

If the row cannot be written (read-only profile), the page says so instead of silently
dropping the result.

### Thinking levels

A level is sent only when the model publishes one:

| model | levels | wire |
| --- | --- | --- |
| `deepseek-v4-1-flash-1017` | off, low, high, max | `none`, `low`, `high`, `max` |
| `mistral-large-4` | low, medium, high | verbatim |
| `mistral-medium-2604` | off, high | `none`, `high` |
| `codestral-2508`, `ministral-*`, `voxtral-*` | none | no `reasoning_effort` |

## Development

```sh
npm test                 # host + client suites, offline
npm run test:host        # adapter, discovery, settings, wire encoding
npm run test:client      # the browser half, rendered against a React stub
npm run check            # node --check both halves, then the suites
npm run sync:models      # rewrite MODEL_CATALOGUE from models.dev
npm run probe            # live /v1/models read with the stored key
npm run stamp            # rewrite the BUILD stamp in lib/index.js
```

Layout:

```
lib/index.js       host half: adapter, catalogue, discovery, HTTP surface
lib/client.js      browser half: the settings page and its nav glyph
vendor/            schemastery + cosmokit, vendored as ESM
locale/            en/zh titles for the settings entry
scripts/           sync-models, live-check, client-half-toggle
test/              host.test.mjs, client.test.mjs
```

The suites need no network and no key: the host suite runs the real adapter against a
local SSE server, and the models.dev read is pointed at a local stub through
`MISTRAL_MODELS_DEV_URL`.

### Which build is running

A host keeps an applied plugin module in memory: re-applying the entry writes
`applied` to the operation log but does **not** re-import the file, so a fix can
be on disk and still not run. `BUILD` makes that observable — it is the hash of
`lib/index.js` without the stamp line, logged on mount, returned by
`GET /mistral-vibe/config`, and printed under the model list on the settings
page. "host build unknown" means the host is still serving a module loaded
before this field existed; restart DeepSeek Harness to pick the file up.

### Route surface

| route | effect |
| --- | --- |
| `GET /mistral-vibe/config` | the row as the page needs it, plus `build` — no key values |
| `POST /mistral-vibe/config` | save `apiKey`, `studioApiKey`, `baseURL`, `displayName`, `disabledModels` |
| `POST /mistral-vibe/discover` | merge `GET /v1/models` into the stored list; answers `{source, added, models, persisted}` |

All three are loopback-only and answer `403 {error: "loopback only"}` to anything else.

## Notes / limitations

- **No quota reading.** `/v1/billing/subscription` returns
  `{"plan_name": …}` and no money fields; roughly three dozen other candidates
  (`/v1/billing/usage`, `/v1/credits`, `/v1/vibe-code/usage`, …) answer
  `404 no Route matched`. The console's API and Vibe Code allowances are not readable
  through the API, so this plugin does not pretend to show them.
- **A discovered model's ladder depends on models.dev.** An id models.dev does not know
  keeps "levels unknown": no level control, and no `reasoning_effort` on the wire.
- **Replay is sanitised.** Every request is rebuilt from the fields Mistral declares:
  `role`, `content`, and `tool_calls` with `id`/`type`/`function`. Reasoning replays the
  way Vibe replays it — as `{"type":"thinking","thinking":[{"type":"text",…}]}` chunks
  inside `content`, gated on the model declaring an effort ladder — never as a sibling
  `reasoning_content` field, which Mistral answers with a body-wide `422 extra_forbidden`.
- **An in-process request rewriter is asked to stay out of the way.** billion-context
  ("bili") injects a blank `reasoning_content` into any assistant turn carrying
  `tool_calls` when the model id matches `/deepseek/i` — which is every
  `deepseek-v4-1-flash-1017` turn that used a tool — and Mistral rejects the field.
  Every request here therefore carries `x-bili-passthrough: 1`, bili's own verbatim-relay
  marker; Mistral ignores unknown headers. Set `bypassRewrite: false` to stop sending it
  behind a gateway that rejects unknown headers. The trade-off is that bili does no
  folding on this route while the header is on.
- **Alias ids still resolve.** `mistral-medium-latest` is not a row of its own; a session
  that selected it resolves to `mistral-medium-2604` with that entry's limits.

## License

MIT © Meltartica — see [LICENSE](LICENSE).
