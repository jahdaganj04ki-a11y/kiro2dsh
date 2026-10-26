# Signing in: the eight methods

Kiro's models are gated by AWS Builder Identity, not by an API key you can mint for
yourself. "Other harnesses get an error" is almost always this problem: the runtime
endpoint accepts a request only when it carries a token that a Kiro client obtained,
for a profile the caller is allowed to use, with the conversation scopes attached.

This plugin obtains such a token the same way the Kiro IDE does. Every method below
ends in the same record — an access token, a refresh token, an expiry, a region and a
profile ARN — so the turn code never branches on how you signed in.

| Method | Needs a browser? | Needs the IDE installed? | Token lifetime | Refreshes itself |
| --- | --- | --- | --- | --- |
| `builder-id` | yes, once | no | ~1 h | yes |
| `idc` | yes, once | no | ~1 h | yes |
| `google` | yes, once | no | ~1 h | yes |
| `github` | yes, once | no | ~1 h | yes |
| `external_idp` | yes, once | no | as configured | yes |
| `api_key` | no | no | until you revoke it | n/a |
| `import` | no | yes, to get the token | ~1 h | yes |
| `auto-import` | no | yes | ~1 h | yes |

## `builder-id` — the plain Kiro account

1. The plugin registers a throwaway OIDC client (`POST /client/register`) and starts a
   device authorisation (`POST /device_authorization`) against
   `https://oidc.<region>.amazonaws.com`.
2. You get a code and a link (`https://view.awsapps.com/start`); you approve in the
   browser, the plugin polls `/token` with the interval the service asked for
   (`slow_down` lengthens it, `expired_token` ends the round).
3. The token is stored, the profile ARN is read from `ListAvailableProfiles`.

Scopes: `codewhisperer:completions`, `codewhisperer:analysis`,
`codewhisperer:conversations`. Without the third the conversation endpoint answers
`403`, which is the error most non-Kiro clients hit.

## `idc` — AWS IAM Identity Center

Same flow, but you supply your organisation's start URL (the one the IdP portal gives
you). The region is taken from it and must match `^[a-z]{2}(-gov)?-[a-z]+-\d$`; a
malformed region is rejected before any request leaves, because Amazon answers a bad
`oidc.<region>` host with a DNS error that looks like an outage.

If your organisation requires SSO through a specific portal, Kiro's own
`profile.json` already knows the ARNs — `auto-import` picks them up.

## `google` / `github` — social login

Kiro performs social sign-in itself and hands the result to the IDE through its
`kiro://` callback, so no local browser server is needed:

1. the plugin builds the authorise URL with PKCE and opens it;
2. you finish in the browser, and the OS then complains about `kiro://` (nothing is
   registered, or the IDE opens and ignores it);
3. you copy the final URL — or just the `code` and `state` — into the panel;
4. the plugin exchanges it at `prod.us-east-1.auth.desktop.kiro.dev` and stores the
   tokens.

An optional prompt: if the exchange needs a client id the plugin does not know, it
asks. A wrong `state` is refused with `INVALID_CREDENTIAL` rather than retried.

## `external_idp` — Entra ID and friends

Two ways in. Paste the JSON blob Kiro writes for an external IdP and the plugin reads
`authJson` from it; or answer the five prompts: `tokenEndpoint`, `clientId`, `scopes`,
`profileArn`, and then the tokens.

The token endpoint is checked against an allowlist (`login.microsoftonline.com`,
`login.windows.net`) before anything is sent to it, so a typo cannot turn your refresh
token into a request to an unknown host. A malformed blob is reported as
`INVALID_CREDENTIAL` and no request leaves the process.

## `api_key` — Kiro API keys

Paste the key. It is validated with `GET https://q.<region>.amazonaws.com/ListAvailableModels?origin=AI_EDITOR`,
`TokenType: API_KEY`, and needs a non-empty `models` array — a key that answers with
an empty list is refused at once instead of failing every later turn. The record gets a
year of nominal validity and never refreshes; the plugin will not call
`ListAvailableProfiles` for an API key, because that endpoint is not for them.

## `import` — a refresh token you already have

For a headless machine, CI, or a container where no browser can reach the callback.

You paste a refresh token. If it starts with `aor` it is an OIDC *refresh* grant, and
the plugin also asks for the IDE's `clientId` (and optionally `clientSecret`) so it can
call the OIDC `/token` endpoint exactly like the IDE does. A token that does not start
with `aor` is treated as a Kiro-internal (`aod`) grant and is exchanged at
`prod.us-east-1.auth.desktop.kiro.dev/refreshToken` with the `kiro-cli` user agent —
no client id needed, and asking for one would only break the call.

Where to find it: on Windows
`%USERPROFILE%\.aws\sso\cache\kiro-auth-token.json` (`refreshToken`), or in the IDE's
devtools storage. Keep it out of your shell history: the panel's paste field, not a
`.env` file, is the intended place.

## `auto-import` — the IDE is already signed in

The default, and the one that makes the plugin feel like nothing was installed. At
startup (and when you press the button in the panel) the plugin reads:

```text
~/.aws/sso/cache/kiro-auth-token.json          ← the OIDC tokens
~/.aws/sso/cache/<clientIdHash>.json           ← the client id/secret pair
~/…/Kiro/User/globalStorage/kiro.kiroagent/profile.json   ← region + profile ARN
```

The home directory is the DSH user home, or `auth.homeDir`/`settings.homeDir` when you
set it, so a profile that lives somewhere else is a settings change rather than a
symlink. A successful import is labelled
**Kiro IDE (local)** and becomes `idc` if the client is registered, `import`
otherwise — the distinction only matters for which host refreshes it.

Nothing is ever written back: the IDE's files stay exactly as they were, and a lock or
permission error on that directory surfaces as `Searched: <paths>` so you can see what
was checked rather than being told "not configured".

## What is stored, where

One credential record — `dsh-desktop-kiro/account` — holds a pool:

```json
{
  "version": 1,
  "activeId": "kiro-3f2b…",
  "accounts": [{
    "id": "kiro-3f2b…", "label": "Kiro IDE (local)", "authMethod": "idc",
    "region": "us-east-1", "profileArn": "arn:aws:codewhisperer:…",
    "accessToken": "…", "refreshToken": "…", "clientId": "…", "clientSecret": "…",
    "expiresAt": 1793000000000, "enabled": true, "lastFailure": null
  }]
}
```

- The account **id** is derived from a hash of the credential, so the same token
  imported twice is one account, and two different accounts never collide.
- **No token ever leaves the process** in a log line, a panel response or an error
  message. `describeAccount` exposes booleans plus the last four characters, which is
  enough to tell two accounts apart.
- `lastFailure` keeps a code and a redacted message (300 characters, secrets masked)
  so the panel can explain why an account is disabled.
- An account whose token is missing entirely is skipped by `candidates()` rather than
  attempted, and a transient refresh failure keeps the old token instead of clearing it.

## Refresh, failover and what "sign in again" means

Before every turn the pool is checked: `expiresAt - refreshLeadingMs` (default: one
minute) is when a token is refreshed. A refresh that answers `400 invalid_grant` marks
that account with `KIRO_REFRESH_EXPIRED`. A turn walks at most `accountFailover`
accounts (2 by default): an auth, quota, rate-limit or unreachable-endpoint failure
moves to the next one — after `401`/`403` has already tried one token refresh — while a
`400` moves to nobody, because a body Kiro rejected is rejected for every account.

When the last account is out of reach the harness sees `AUTH` (a re-auth prompt in the
UI) or `MISSING_CREDENTIAL`, and the panel's status line says which account failed and
why. That is the point of the code: a refresh-token replay is a sign-in problem, while
a proxy resetting a socket is not, and only one of them should ask you for credentials.
