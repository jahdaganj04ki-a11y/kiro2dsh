# kiro2dsh

Kiro IDE models for DSH Desktop — and an OpenAI/Anthropic bridge for everything else
on the machine.

The plugin itself, its documentation and its installer live in
[`package/`](package):

| Read this | For |
| --- | --- |
| [`package/README.md`](package/README.md) | what the plugin does, the per-model catalog, every setting, the bridge, troubleshooting |
| [`package/docs/install.md`](package/docs/install.md) | installing on Windows (or anywhere), verifying, uninstalling |
| [`package/docs/auth.md`](package/docs/auth.md) | the eight sign-in methods: builder id, IAM Identity Center, Google, GitHub, external IdP, API key, token import, local IDE import |

## Layout

```text
package/            the npm package DSH installs
  index.js          plugin definition: settings, adapter registration, panel routes, bridge
  client.js         the settings panel (sign-in rounds, account pool, catalog refresh)
  install.ps1       Windows entry point
  scripts/          install.mjs (pack + install), check-imports.mjs (import-graph guard)
  lib/kiro/         the wire: request/response builders, eventstream codec, transport
  lib/auth/         credential store, token refresh, sign-in coordinator, external IdP
  lib/bridge/       OpenAI + Anthropic parsing, rendering, router, loopback server
  lib/catalog.js    the model table, variants, effort clamping
  lib/turn.js       one turn, shared by the adapter and the bridge
  test/             the suite: no network, no DSH install needed
```

`lib/` deliberately imports nothing from the harness; `scripts/check-imports.mjs`
enforces that, which is what keeps the whole thing testable without a desktop.

## Build and check

```bash
cd package
npm test              # node --test, no dependencies to install
npm run check         # harness imports confined to index.js and lib/adapter.js
npm run pack-plugin   # dist/dsh-desktop-kiro-<version>.tgz
.\install.ps1         # Windows: pack and install into the "web" profile
```

## Where the Kiro facts come from

Every wire detail in `lib/` — endpoints, headers, `X-Amz-Target` values, token
endpoints, refresh branching, per-model `contextLength`/`maxTokens`, the 32 000 output
cap, the model ids each family accepts — was taken from a working Kiro client and
recorded in code comments next to the constant it belongs to, so a future change can
be checked against a source rather than guessed. Kiro is not a public API: expect to
re-verify these after a Kiro or DSH update, and file an issue with the response you got.
