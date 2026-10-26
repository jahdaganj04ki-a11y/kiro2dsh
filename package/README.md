# Kiro models for DSH Desktop

A DSH Desktop plugin that makes the models behind the [Kiro IDE](https://kiro.dev)
work as a first-class DSH provider route — and, optionally, as an
OpenAI/Anthropic-compatible HTTP endpoint for the other agents on this machine.

It exists because Kiro's models are not "an endpoint with a key". They are reachable
only through the AWS CodeWhisperer conversation API: a signed-in builder identity, a
per-account profile ARN, a binary `application/vnd.amazon.eventstream` frame
protocol, a `modelId` that is refused when a capability is missing, and an output cap
that is refused when it is too high. Getting any of that wrong is what makes other
harnesses print a generic error. This plugin gets it right **per model, not per
provider**: every entry in [the catalog](#models) carries its own endpoint surface,
context window, output cap, thinking mechanism, image support and tool support.

- **Package:** `dsh-desktop-kiro` — one plugin, one adapter route (`kiro` by default)
- **Requires:** DSH Desktop 0.12.x or newer; Node.js 22+ only if you install from a checkout
- **License:** MIT · **Not affiliated with AWS or Kiro** — you use your own Kiro account under its terms

## Install

The short version, from a terminal on Windows (inside the `package` directory):

```powershell
.\install.ps1                      # pack, then install into the "web" profile
.\install.ps1 -Profile desktop     # another profile
.\install.ps1 -Link                # install this directory instead of a tarball
.\install.ps1 -Uninstall
```

macOS and Linux, or when you would rather see what runs:

```bash
node scripts/install.mjs --profile web
```

DSH Desktop's own plugin UI and `dsh plugin add <tarball>` do the same thing.
[docs/install.md](docs/install.md) covers all three, explains how to *verify* an
install (being configured and being loaded are different facts), and what to do when
a DSH upgrade makes the peer ranges refuse the package.

Afterwards: restart DSH Desktop, open **Settings → Plugins → Kiro models**, sign in.
[docs/auth.md](docs/auth.md) explains the eight methods, what each one asks you to
paste, and where the tokens end up.

## Sign in

| Method | You provide | What the plugin does |
| --- | --- | --- |
| `builder-id` | nothing but a browser | OIDC device-code authorisation against `view.awsapps.com/start` |
| `idc` | a start URL (optional) | AWS IAM Identity Center device flow, region-scoped |
| `google` / `github` | one pasted callback | Kiro's social-login PKCE round-trip with its `kiro://` redirect |
| `external_idp` | the JSON from Kiro's own config, or five fields by hand | Entra ID / any OIDC endpoint Kiro trusts |
| `api_key` | a Kiro API key | validated through `ListAvailableModels`; no refresh dance |
| `import` | an `aor…` refresh token, optionally the IDE's client id/secret | refreshes exactly the way the IDE does |
| `auto-import` | nothing, if the Kiro IDE runs on this machine | reads `~/.aws/sso/cache/kiro-auth-token.json` and the IDE's `profile.json` |

`auto-import` runs at startup when `auth.autoImport` is on (the default), so the
usual case is: install, restart, and the Kiro IDE's session is already there. The
plugin never writes to the IDE's files.

Accounts live in one credential record with a pool inside it. Tokens rotate on their own
with a leading refresh before expiry; a `401`/`403` refreshes once and, if that fails,
moves the turn to the next account, and a `429` moves immediately. A refresh that
cannot recover is reported as `KIRO_REFRESH_EXPIRED` — "sign in again", not a stack
trace. A `400` moves to nobody: a body Kiro rejected is rejected for every account.

## Models

The seed table is what ships; `GET /v1/models` and the Models page read the same
structure. **Refresh from Kiro** (in the panel) pulls the live `ListAvailableModels` listing and folds
it in, so a model Kiro adds later works without a plugin update — and a model your
account cannot buy disappears from the picker instead of failing a turn.

`Wire max` is what goes out as `inferenceConfig.maxTokens`. Kiro caps a conversation
turn at 32 000 output tokens; sending a model's larger advertised maximum is refused,
so the plugin clamps and reports `finish: max-tokens` when a turn really hits it.
| Model | Name | Context | Max out | Wire max | Thinking | Efforts | Images | Tools | Rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-opus-5.5` | Claude Opus 5.5 | 1,000,000 | 128,000 | 32,000 | output_config | low / medium / high / xhigh / max | yes | yes | 2 |
| `claude-opus-5` | Claude Opus 5 | 1,000,000 | 128,000 | 32,000 | output_config | low / medium / high / xhigh / max | yes | yes | 1.5 |
| `claude-opus-4.8` | Claude Opus 4.8 | 200,000 | 64,000 | 32,000 | output_config | low / medium / high / xhigh / max | yes | yes | 1.5 |
| `claude-opus-4.7` | Claude Opus 4.7 | 200,000 | 64,000 | 32,000 | output_config | low / medium / high / xhigh / max | yes | yes | 1.5 |
| `claude-opus-4.5` | Claude Opus 4.5 | 200,000 | 32,000 | 32,000 | tag | minimal / low / medium / high | yes | yes | 1.3 |
| `claude-sonnet-5` | Claude Sonnet 5 | 200,000 | 64,000 | 32,000 | output_config | low / medium / high / xhigh / max | yes | yes | 1 |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 | 200,000 | 32,000 | 32,000 | output_config | low / medium / high / max | yes | yes | 1 |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 | 200,000 | 32,000 | 32,000 | tag | minimal / low / medium / high | yes | yes | 1 |
| `claude-haiku-4.5` | Claude Haiku 4.5 | 200,000 | 32,000 | 32,000 | tag | minimal / low / medium / high | yes | yes | 0.4 |
| `gpt-5.6-sol` | GPT 5.6 Sol | 272,000 | 128,000 | 32,000 | reasoning | low / medium / high / xhigh | yes | yes | 2.4 |
| `gpt-5.6-terra` | GPT 5.6 Terra | 272,000 | 128,000 | 32,000 | reasoning | low / medium / high / xhigh | yes | yes | 1.2 |
| `gpt-5.6-luna` | GPT 5.6 Luna | 272,000 | 128,000 | 32,000 | reasoning | low / medium / high / xhigh | yes | yes | 0.6 |
| `deepseek-3.2` | DeepSeek 3.2 | 128,000 | 32,000 | 32,000 | tag | minimal / low / medium / high | no | yes | 0.3 |
| `qwen3-coder-next` | Qwen3 Coder Next | 256,000 | 32,000 | 32,000 | tag | minimal / low / medium / high | no | yes | 0.3 |
| `glm-5` | GLM 5 | 200,000 | 32,000 | 32,000 | tag | minimal / low / medium / high | no | yes | 0.3 |
| `minimax-m2.5` | MiniMax M2.5 | 200,000 | 32,000 | 32,000 | tag | minimal / low / medium | no | yes | 0.3 |
| `minimax-m2.1` | MiniMax M2.1 | 200,000 | 32,000 | 32,000 | tag | minimal / low / medium / high | no | yes | 0.2 |
| `kimi-k3` | Kimi K3 | 256,000 | 32,000 | 32,000 | tag | minimal / low / medium / high | no | yes | 0.4 |
| `auto` | Kiro Auto | 200,000 | 32,000 | 32,000 | none | — | no | yes | 1 |

Each base model also gets `-thinking`, `-agentic` and `-thinking-agentic` variants in
the picker, so a harness with no way to say "think harder" can still reach it. What
the `Thinking` column means on the wire:

| Carrier | How thinking is asked for | Notes |
| --- | --- | --- |
| `tag` | a sentence in the system prompt, with a token budget per tier (`minimal` 1 024 … `high` 24 000) | the model has no reasoning parameter; the answer comes back inline as `<thinking>…</thinking>` and is split into reasoning blocks |
| `reasoning` | `reasoning.effort` on the request | `max` is not a Kiro tier here, so it is sent as `xhigh` |
| `output_config` | `output_config.effort` | the newer Claude families; `max` exists and is forwarded as-is |
| `none` | not at all | `auto` picks for you; an effort on such a model is rejected, not ignored |

`Images` is capability, not preference: on a `no` model an incoming image becomes a
one-line text citation, because Kiro answers those models with `invalid modelId`
when an image block is present. `Rate` is Kiro's own credit multiplier, and
`GET /v1/models` repeats all of it so a client can build its own UI.

## Settings

Everything lives under **Settings → Plugins → Kiro models**. The keys, with what
they actually change:

| Key | Default | Meaning |
| --- | --- | --- |
| `providers.kiro.displayName` | `Kiro` | label in the Models page |
| `providers.kiro.region` | `us-east-1` | region of the OIDC and CodeWhisperer endpoints |
| `providers.kiro.profileArn` | — | pin a profile ARN instead of letting `ListAvailableProfiles` choose |
| `providers.kiro.baseUrl` | `https://runtime.us-east-1.kiro.dev` | override `generateAssistantResponse`'s host |
| `providers.kiro.surfaces` | `q`, `codewhisperer` | which endpoint families to walk, in order |
| `providers.kiro.apiKeyEnv` | — | credential ref holding a Kiro API key for this route |
| `providers.kiro.headers` | — | extra headers on every request to this route |
| `providers.kiro.models` | — | declare the route's models by hand; replaces the seed table |
| `providers.kiro.modelOverrides` | — | correct one model's `contextWindow`, `maxTokens`, `vision`, `reasoning`, … |
| `providers.kiro.defaultContextWindow` | 200 000 | what a hand-declared model inherits for its context |
| `providers.kiro.defaultMaxTokens` | 32 000 | and for its output default |
| `providers.kiro.connectTimeoutMs` | 15 000 | time to first byte |
| `providers.kiro.firstChunkTimeoutMs` | 60 000 | time to the first eventstream frame |
| `providers.kiro.streamIdleTimeoutMs` | 120 000 | how long a silent stream may stay open |
| `providers.kiro.rateLimitRetries` | 1 | in-request retries on `429` (0 disables them) |
| `providers.kiro.accountFailover` | 2 | how many accounts one turn may walk |
| `providers.kiro.repairToolCalls` | true | drop/relabel tool calls Kiro would reject |
| `bridge.enable` | false | serve `/v1/*` on loopback |
| `bridge.host` / `bridge.port` | `127.0.0.1` / `0` (ephemeral) | where it listens; a non-loopback host **requires** a token |
| `bridge.tokenRef` | — | credential ref holding the bridge token |
| `auth.autoImport` | true | adopt the local Kiro IDE session at startup |
| `auth.refreshLeadingMs` | 60 000 | how early a token is refreshed |
| `auth.preferredAccountId` | — | which account starts a turn first |
| `auth.homeDir` | the user home | where `auto-import` looks for the IDE's files |

Two rules are worth knowing. A `modelOverrides` entry patches the seed row, so you
can correct a size without re-declaring the model; `models` replaces the list, so
nothing you left out is offered. And `contextWindow`/`maxTokens` and
`context`/`maxOutput` are accepted spellings of the same two fields.

The settings panel follows DSH's language setting (English, German and Chinese are
translated); everything below is written for the English UI.

## The HTTP bridge

With `bridge.enable: true` the same models answer OpenAI and Anthropic traffic on
loopback, using the account pool and the per-model rules above:

```bash
curl -s http://127.0.0.1:52469/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}],"tools":[…]}'
```

| Endpoint | Notes |
| --- | --- |
| `POST /v1/chat/completions` | `stream: true` gives OpenAI SSE with `data: [DONE]`; tool calls, images and `reasoning_effort` map onto the model's real capability |
| `POST /v1/messages` | Anthropic SSE, including `message_start`/`content_block_*`/`message_delta`, `input_json_delta` for tools and `content_block_start` exactly once per index |
| `POST /v1/messages/count_tokens` | a cheap estimate (`ceil(length / 4)`), enough for a client's budgeting loop |
| `GET /v1/models` | OpenAI-shaped; `?format=anthropic` gives the Anthropic shape with `capabilities` |
| `GET /v1/kiro/status` | accounts (label, method, expiry, token *tails* only), quota, catalog size, effective bridge settings |
| `GET /health` | `{ ok: true, models: n }` |
| `POST /v1/completions` | `400` on purpose: Kiro serves chat models only |

`openaiUsage.total_tokens` follows this format's definition (`prompt + completion`),
so a client that bills from either spelling gets the same number. Cancellation works
in both directions: hanging up the socket aborts the Kiro request, and an upstream
failure arrives as an SSE error frame followed by `[DONE]` rather than a truncated body.

If `bridge.tokenRef` is set, every request must carry it as `Authorization: Bearer …`
**or** `x-api-key: …`; an unset token means "any process on this machine", which is
the right default for a loopback port and the wrong one for anything else — so a
non-loopback bind without a token is refused at startup.

## Troubleshooting

| Symptom | What it means |
| --- | --- |
| `KIRO_NOT_CONFIGURED` | no account in the pool; sign in, or turn on `auth.autoImport` with the IDE logged in |
| `KIRO_REFRESH_EXPIRED` | the refresh token is dead (revoked, or a `aod…` device token replayed); sign in again |
| `INVALID_CREDENTIAL` | a pasted token was truncated or has whitespace in it |
| `KIRO_MODEL_UNAVAILABLE` | this listing does not offer that model to your account — pick another, or refresh the catalog |
| `KIRO_REQUEST_REJECTED` | Kiro refused the body; the message names the field, which is usually an image on a text-only model or an effort a model does not take |
| `KIRO_ENDPOINT_UNREACHABLE` | network or proxy; the message names the surface that failed (`q` or `codewhisperer`), the log has every attempt |
| `RATE_LIMIT` / `QUOTA` | 429 back-off vs. a spent credit balance; the quota line comes from `getUsageLimits` |
| a model is missing from the picker | it is in the unavailable set from the last refresh — **Refresh from Kiro** re-reads the listing |
| `AWS EventStream frame is truncated` | a proxy is buffering the response; the stream must not be batched |
| bridge answers `401` | a token is configured and the request did not carry it |

`node scripts/install.mjs --uninstall` removes the package again. The credential
record and the settings namespace are left alone — delete an account from the panel's
account list (**Remove**) if you want the tokens gone.

## Development

```bash
cd package
npm test                 # the whole suite: no network, no DSH install needed
npm run check            # import-graph guard: the harness is only touched in index.js and lib/adapter.js
npm run pack-plugin      # dist/dsh-desktop-kiro-<version>.tgz
```

`prepack` runs both checks, so a tarball that installs was a tarball that tested.
`npm pack --ignore-scripts` skips them if you are in a hurry and know why. The suite
and the import guard live in a checkout: neither `test/` nor `scripts/check-imports.mjs`
is part of the installed package, which is also why nothing in `lib/` needs the
harness to be present.

The library under `lib/` is dependency-free and unit-testable: `lib/kiro/*` speaks
the wire, `lib/auth/*` the eight sign-in methods, `lib/catalog.js` the model table,
`lib/bridge/*` the two HTTP formats. `index.js` is the only place that knows DSH
exists, which is what keeps all of it testable without a desktop install.

| Path | What is in it |
| --- | --- |
| `index.js` | plugin definition: settings, adapter registration, panel routes, bridge lifecycle |
| `client.js` | the settings panel (sign-in rounds, account pool, catalog refresh) |
| `lib/kiro/` | request/response builders, eventstream codec, transport with failover |
| `lib/auth/` | credential store, token refresh, sign-in coordinator, external IdP import |
| `lib/bridge/` | request parsing, rendering, router, loopback server |
| `lib/catalog.js` | the seed table, variants, effort clamping |
| `lib/turn.js` | one turn: account choice, payload, chunk protocol |
| `docs/` | [install](docs/install.md) and [auth](docs/auth.md) |
