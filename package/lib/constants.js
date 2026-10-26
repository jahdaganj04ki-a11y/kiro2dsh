/**
 * Kiro wire facts: endpoints, headers, limits and the account-binding rules the
 * upstream enforces.
 *
 * Every value here was read out of a working Kiro IDE request (see
 * `docs/protocol-notes.md` for the provenance of each rule). Kiro's data plane
 * is unforgiving: an unknown model id, a `User-Agent` it cannot parse, a
 * top-level `systemPrompt`, or a conversation whose turns do not alternate each
 * answer with a bare 400 — which is why other agents and harnesses report
 * "format of value … is invalid" or "Improperly formed request" instead of
 * working. The plugin keeps those constraints in one place so the translators
 * cannot drift.
 *
 * @module lib/constants
 */

/** Region shape accepted in interpolated upstream URLs; anything else is refused (SSRF guard). */
// GovCloud partitions are real Kiro targets, so the shape allows `us-gov-east-1`
// while still refusing anything that could escape the URL template.
export const AWS_REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d{1,2}$/u

/** Validate one AWS region before it reaches a URL template. */
export function assertValidAwsRegion(region) {
  if (typeof region !== 'string' || !AWS_REGION_PATTERN.test(region)) {
    throw new Error(`invalid AWS region ${JSON.stringify(region)}`)
  }
  return region
}

/** Default region: the shared Kiro gateways only exist in us-east-1. */
export const DEFAULT_REGION = 'us-east-1'

/**
 * Data-plane surfaces for `GenerateAssistantResponse`.
 *
 * Order matters and is derived from live behaviour, not from documentation:
 * - `q.*` accepts every auth method and is the only surface that answers an
 *   API-key (headless) credential with a valid payload.
 * - `codewhisperer.*` authenticates OAuth tokens but answers the same payload
 *   with 400 `REQUEST_BODY_INVALID` for API keys, and needs the legacy
 *   `X-Amz-Target` header.
 * - `runtime.*.kiro.dev` is the deprecated path gateway: since IDE 1.0.228 it
 *   answers modern payloads with 400 `REQUEST_BODY_INVALID`. It stays last
 *   because a 400 is terminal for the fallback walk, so it must never be first.
 */
export const KIRO_SURFACES = Object.freeze({
  q: 'https://q.{region}.amazonaws.com/generateAssistantResponse',
  codewhisperer: 'https://codewhisperer.{region}.amazonaws.com/generateAssistantResponse',
  kiroRuntime: 'https://runtime.us-east-1.kiro.dev/generateAssistantResponse',
})

/** Fallback order for OAuth accounts (builder-id, social, external IdP, IDC). */
export const OAUTH_SURFACE_ORDER = Object.freeze(['q', 'codewhisperer', 'kiroRuntime'])

/** Fallback order for API-key accounts: the CodeWhisperer surface rejects their payloads. */
export const API_KEY_SURFACE_ORDER = Object.freeze(['q'])

/**
 * HTTP statuses that mean "this surface does not accept this credential", so
 * the next surface is worth a try. A 400 is deliberately absent: a malformed
 * payload is not repaired by another host.
 */
/** Statuses where the *host* may be at fault, so the next surface is worth a try. */
export const ENDPOINT_FALLBACK_STATUSES = Object.freeze(new Set([401, 403, 404]))

/** `X-Amz-Target` for the legacy CodeWhisperer surface only. */
export const CODEWHISPERER_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse'

/** JSON-RPC style target used by the catalog/quota calls on `q.` / `codewhisperer.`. */
export const CODEWHISPERER_LIST_PROFILES_TARGET = 'AmazonCodeWhispererService.ListAvailableProfiles'
export const CODEWHISPERER_LIST_MODELS_TARGET = 'AmazonCodeWhispererService.ListAvailableModels'
export const CODEWHISPERER_USAGE_PATH = '/getUsageLimits'

/** Control-plane hosts. */
export const KIRO_AUTH_HOST = 'https://prod.us-east-1.auth.desktop.kiro.dev'
export const KIRO_OIDC_HOST = 'https://oidc.{region}.amazonaws.com'
export const KIRO_START_URL = 'https://view.awsapps.com/start'
export const KIRO_SSO_ISSUER = 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6'

/**
 * AWS SSO OIDC client registration payload. `clientType: public` + the device
 * grant is what the Kiro IDE itself registers, and `issuerUrl` binds the
 * registration to the Kiro builder-id SSO instance.
 */
export const KIRO_OIDC_CLIENT = Object.freeze({
  clientName: 'kiro-oauth-client',
  clientType: 'public',
  scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
  grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
  issuerUrl: KIRO_SSO_ISSUER,
})

/** Social (Google / GitHub) login surfaces, which are Cognito-backed. */
export const KIRO_SOCIAL = Object.freeze({
  loginUrl: `${KIRO_AUTH_HOST}/login`,
  tokenUrl: `${KIRO_AUTH_HOST}/oauth/token`,
  refreshUrl: `${KIRO_AUTH_HOST}/refreshToken`,
  // AWS Cognito only whitelists the custom protocol; a localhost redirect is refused.
  redirectUri: 'kiro://kiro.kiroAgent/authenticate-success',
})

/**
 * Shared default profile ARNs, keyed by auth method.
 *
 * These belong to the public Kiro accounts and are only valid for the OAuth
 * methods that were issued against them. An API-key, IDC or external-IdP
 * credential carries its own account-bound profile: sending the placeholder
 * with those tokens answers 403 "bearer token invalid", so those methods must
 * resolve their own ARN or send none.
 */
export const DEFAULT_PROFILE_ARNS = Object.freeze({
  'builder-id': 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX',
  social: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK',
})

/** Resolve the shared placeholder ARN for one auth method (empty for account-bound methods). */
export function defaultProfileArn(authMethod) {
  if (authMethod === 'google' || authMethod === 'github') return DEFAULT_PROFILE_ARNS.social
  if (authMethod === 'builder-id' || !authMethod) return DEFAULT_PROFILE_ARNS['builder-id']
  return ''
}

/** Auth methods whose profile ARN is owned by the account, never shared. */
export const ACCOUNT_BOUND_AUTH = Object.freeze(['api_key', 'idc', 'external_idp'])

/** The runtime gateway requires us-east-1 inside the ARN even for IDC regions. */
export function normalizeProfileArnRegion(profileArn, region = DEFAULT_REGION) {
  if (typeof profileArn !== 'string' || !profileArn) return ''
  return profileArn.replace(/^(arn:aws:codewhisperer:)[^:]+(:)/u, `$1${region}$2`)
}

/**
 * User-Agent anatomy the upstream parser accepts.
 *
 * A partial or reshaped value is answered with 400 `format of value 'os/win/10
 * lang/js …' is invalid`, so the keyed tokens below keep their exact spelling,
 * including the `os/<name>#<build>` form and the trailing `m/N,E` modifiers.
 */
export const KIRO_UA = Object.freeze({
  sdkVersion: '3.0.0',
  runtimeSdkVersion: '1.0.0',
  os: 'windows',
  osVersion: '10.0.26200',
  language: 'js',
  nodeVersion: '22.21.1',
  api: 'codewhispererruntime',
  kiroVersion: '0.10.32',
})

/** `Accept` for the streaming data plane; the reply is AWS EventStream binary frames. */
export const EVENTSTREAM_ACCEPT = 'application/vnd.amazon.eventstream'

/** Fixed request headers every Kiro call sends, including the agent-mode markers. */
export const KIRO_FIXED_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  Accept: EVENTSTREAM_ACCEPT,
  'x-amzn-kiro-agent-mode': 'vibe',
  'x-amzn-codewhisperer-optout': 'true',
  'amz-sdk-request': 'attempt=1; max=1',
})

/** Catalog/quota calls answer JSON, not EventStream. */
export const JSON_ACCEPT = 'application/json'

/** Tool-name, tool-id and tool-description bounds enforced by the Kiro schema. */
export const TOOL_NAME_MAX_LENGTH = 64
export const TOOL_ID_MAX_LENGTH = 64
export const TOOL_DESCRIPTION_MAX_LENGTH = 10237

/** Tool ids must be `[a-zA-Z0-9_-]+`; anything else is rewritten before it is sent. */
export const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
export const TOOL_NAME_SANITIZE = /[^a-zA-Z0-9_-]/g

/** Reasoning defaults. */
export const THINKING_BUDGET_DEFAULT = 16000
export const THINKING_BUDGET_MIN = 1
export const THINKING_BUDGET_MAX = 32000

/**
 * `inferenceConfig.maxTokens` ceiling observed on the Kiro data plane. Sending
 * more is answered with a 400, so every request is clamped to it even when the
 * model's own catalog entry advertises a larger output window.
 */
export const MAX_OUTPUT_CAP = 32000

/** Context window assumed for a model the live catalog does not size. */
export const DEFAULT_CONTEXT_WINDOW = 200000

/** Output window assumed for a model the live catalog does not size. */
export const DEFAULT_MAX_OUTPUT = 32000

/** `origin` tag Kiro uses to classify the calling surface. */
export const KIRO_ORIGIN = 'AI_EDITOR'

/** Refresh this long before the access token actually expires. */
export const REFRESH_LEAD_MS = 5 * 60 * 1000

/** Catalog cache lifetime per account. */
export const CATALOG_TTL_MS = 5 * 60 * 1000

/** Timeouts. Connect covers response headers; idle covers gaps between frames. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000
export const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 120_000
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000
export const CATALOG_FETCH_TIMEOUT_MS = 30_000

/** AWS EventStream frame bounds; a frame outside them is treated as corrupt input. */
export const EVENTSTREAM_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
export const EVENTSTREAM_MAX_HEADERS_BYTES = 64 * 1024

/** Synthetic model-id suffixes, kept from the Kiro-IDE-side convention so a
 *  caller can ask for reasoning or the agentic chunked-write prompt per model. */
export const AGENTIC_SUFFIX = '-agentic'
export const THINKING_SUFFIX = '-thinking'

/** The chunked-write instruction Kiro's agentic mode expects for file tools. */
export const AGENTIC_SYSTEM_PROMPT = `# CRITICAL: CHUNKED WRITE PROTOCOL (MANDATORY)

You MUST follow these rules for ALL file operations. Violation causes server timeouts and task failure.

## ABSOLUTE LIMITS
- **MAXIMUM 350 LINES** per single write/edit operation - NO EXCEPTIONS
- **RECOMMENDED 300 LINES** or less for optimal performance
- **NEVER** write entire files in one operation if >300 lines

## MANDATORY CHUNKED WRITE STRATEGY

### For NEW FILES (>300 lines total):
1. FIRST: Write initial chunk (first 250-300 lines) using write_to_file/fsWrite
2. THEN: Append remaining content in 250-300 line chunks using file append operations
3. REPEAT: Continue appending until complete

### For EDITING EXISTING FILES:
1. Use surgical edits (apply_diff/targeted edits) - change ONLY what's needed
2. NEVER rewrite entire files - use incremental modifications
3. Split large refactors into multiple small, focused edits

### For LARGE CODE GENERATION:
1. Generate in logical sections (imports, types, functions separately)
2. Write each section as a separate operation
3. Use append operations for subsequent sections

## WHY THIS MATTERS
- Server has 2-3 minute timeout for operations
- Large writes exceed timeout and FAIL completely
- Chunked writes are FASTER and more RELIABLE
- Failed writes waste time and require retry

REMEMBER: When in doubt, write LESS per operation. Multiple small operations > one large operation.`

/** System prompt Kiro rejects: the field must never appear in the body. */
export const FORBIDDEN_BODY_FIELDS = Object.freeze(['systemPrompt'])

/** Placeholder content for a user turn that carries nothing else. */
export const TOOL_RESULTS_PLACEHOLDER = 'Tool results provided.'
export const EMPTY_USER_PLACEHOLDER = 'continue'

/** Every auth method the plugin can drive, in preference order for the UI. */
export const AUTH_METHODS = Object.freeze([
  'builder-id',
  'idc',
  'google',
  'github',
  'external_idp',
  'api_key',
  'import',
  'auto-import',
])

/**
 * Name spaces a caller may hang in front of a Kiro model id, all of them tolerated.
 *
 * `kiro/…` is the spelling CLI configurations reach for when several providers share
 * one endpoint; `aws/kiro/…` is what an AWS-prefixed preset uses. Both are stripped
 * before the id is looked up, so an unlisted model still arrives at Kiro as its own
 * name instead of a namespaced 400.
 */
export const KIRO_MODEL_PREFIXES = Object.freeze(['aws/kiro/', 'kiro/', 'kiro-auto/'])

/** Human labels for each auth method; the client renders them through locale. */
export const AUTH_METHOD_LABELS = Object.freeze({
  'builder-id': 'AWS Builder ID (device code)',
  idc: 'AWS IAM Identity Center (organization)',
  google: 'Google (Kiro social login)',
  github: 'GitHub (Kiro social login)',
  external_idp: 'Enterprise IdP / Microsoft Entra (external_idp)',
  api_key: 'Kiro API key (headless)',
  import: 'Paste a Kiro refresh token',
  'auto-import': 'Import from the local Kiro IDE / AWS SSO cache',
})
