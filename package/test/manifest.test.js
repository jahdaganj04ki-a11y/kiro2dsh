/**
 * The package boundary: manifest, entry points, and the documentation that promises
 * what the code does.
 *
 * A plugin that loads but advertises the wrong settings is worse than one that fails
 * to install, and a README that drifts from the catalog is exactly how a user ends up
 * trusting a `contextWindow` that the wire rejects. These tests read the files as
 * shipped (`index.js` is not imported, because it belongs to the harness) and compare
 * them against the library's own data.
 *
 * @module test/manifest.test.js
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildCatalog } from '../lib/catalog.js'
import { AUTH_METHODS } from '../lib/constants.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => readFileSync(join(packageRoot, relative), 'utf8')
const manifest = JSON.parse(read('package.json'))

test('the manifest is the shape DSH installs', () => {
  assert.equal(manifest.name, 'dsh-desktop-kiro')
  assert.equal(manifest.type, 'module', 'DSH loads plugins as ESM')
  assert.equal(manifest.main, './index.js')
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js', 'the panel is a separate entry point')
  assert.equal(manifest.exports['./lib/*'], './lib/*', 'so a profile can import one piece without the whole plugin')
  assert.equal(manifest.license, 'MIT')
  // The floor has to be the version the test script and the runtime features need,
  // and both installers must say the same number.
  assert.equal(manifest.engines.node, '>=22')
  assert.ok(Number(manifest.engines.node.replace(/[^\d]/gu, '')) >= 22)
  assert.match(read('install.ps1'), /Node 22 or newer/u, 'the Windows installer states the same floor')
  assert.match(read('scripts/install.mjs'), /node/u)
  assert.deepEqual(manifest.os.sort(), ['darwin', 'linux', 'win32'])
  assert.match(manifest.keywords.join(' '), /dsh-plugin/u, 'the market finds plugins by keyword')
  assert.equal(manifest.dsh.client.platform, 'web')
})

test('every file the manifest promises is in the package', () => {
  for (const entry of manifest.files) {
    const globless = entry.includes('*') ? entry.slice(0, entry.indexOf('*')).replace(/\/$/u, '') : entry
    assert.ok(globless.length > 0, `files entry "${entry}" is not a path`)
    assert.ok(existsSync(join(packageRoot, globless)), `package.json promises "${entry}" but it is missing`)
  }
  for (const entry of ['./index.js', './client.js', './package.json', './README.md', './LICENSE', './install.ps1']) {
    assert.ok(existsSync(join(packageRoot, entry.slice(2))), `${entry} must ship`)
  }
  // A `files` list that no longer matches the scripts is how a tarball loses its docs.
  assert.ok(manifest.files.includes('docs') && manifest.files.includes('install.ps1'))
  assert.ok(manifest.files.includes('scripts/install.mjs'), 'only the installer scripts, not the test harness')
  assert.ok(!manifest.files.includes('test'), 'tests are not installed into a user profile')
})

test('the runtime dependency list stays as small as the surface it covers', () => {
  assert.deepEqual(Object.keys(manifest.dependencies), ['@deepseek-ai/schemastery'])
  // Peers must be real DSH packages: a typo here is a refusal at install time.
  const peers = Object.keys(manifest.peerDependencies)
  assert.ok(peers.includes('@deepseek-ai/dsh-llm'))
  assert.ok(peers.includes('@deepseek-ai/dsh-credentials'))
  for (const peer of peers) assert.match(peer, /^@deepseek-ai\/(dsh-|cordis)/u)
  // Everything the panel imports has to be declared, or the loader cannot resolve it -
  // a missing entry is a blank settings page with no error anywhere the user can see.
  const injects = new Set(manifest.dsh.client.inject)
  for (const injected of ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-settings-plugins']) {
    assert.ok(injects.has(injected), `${injected} must stay in dsh.client.inject`)
  }
  const client = read('client.js')
  for (const [, required] of client.matchAll(/require\('(@deepseek-ai\/[^']+)'\)/gu)) {
    assert.ok(injects.has(required), `client.js requires ${required}, which the manifest does not inject`)
  }
  assert.equal(injects.has('react'), false, 'react comes from the renderer, not from a plugin inject')
})

test('the entry point exports the plugin contract', () => {
  const source = read('index.js')
  assert.match(source, /export const name = 'dsh-desktop-kiro'/u)
  assert.match(source, /export async function apply\(ctx, config\)/u, 'DSH plugins export apply(ctx, config)')
  assert.match(source, /export const Config = z\.object/u)
  const injected = /export const inject = \[([^\]]*)\]/u.exec(source)
  assert.ok(injected, 'inject must be a literal array so the loader can read it without executing the plugin')
  const services = injected[1].split(',').map(entry => entry.trim().replace(/['"]/gu, '')).filter(Boolean)
  assert.deepEqual(services, ['llm', 'credentials', 'connection', 'settings', 'authorization'])
  assert.equal(new Set(services).size, services.length, 'a duplicated service is a typo, not a feature')
  for (const optional of ['connection', 'settings']) {
    assert.ok(Object.keys(manifest.peerDependenciesMeta || {}).some(name => name.includes(optional)), `${optional} is optional at runtime and must be declared so`)
  }
})

test('every settings key in the README is a key in the schema', () => {
  const source = read('index.js')
  const profilesBlock = source.slice(source.indexOf('const providerProfile = z.object('), source.indexOf('const bridgeConfig = z.object('))
  const bridgeBlock = source.slice(source.indexOf('const bridgeConfig = z.object('), source.indexOf('const authConfig = z.object('))
  const authBlock = source.slice(source.indexOf('const authConfig = z.object('), source.indexOf('/** The plugin\u0027s configuration document. */'))
  // A field is `key: z.string()` or `key: SomeSchema` - the harness' own schemas are
  // reused as often as schemastery's builders, and the README has to cover both.
  const fields = block => new Set([...block.matchAll(/^  ([a-zA-Z][a-zA-Z0-9]*): [^\n]*,$/gmu)].map(match => match[1]))
  const profileKeys = fields(profilesBlock)
  const bridgeKeys = fields(bridgeBlock)
  const authKeys = fields(authBlock)
  assert.ok(profileKeys.has('retryPolicy'), 'the reused harness schema counts as a declared field')

  // Only the settings section, but any cell in it: a row that documents two keys
  // side by side is still a promise about both of them.
  const section = read('README.md').split('## Settings')[1].split('\n## ')[0]
  const documented = new Map()
  for (const [, namespace, key] of section.matchAll(/`(providers\.kiro|bridge|auth)\.([a-zA-Z][a-zA-Z0-9]*)`/gmu)) {
    documented.set(`${namespace}.${key}`, namespace)
  }
  assert.ok(documented.size >= 20, `the README documents ${documented.size} settings keys; the table should be complete`)
  for (const [qualified, namespace] of documented) {
    const key = qualified.slice(namespace.length + 1)
    const bucket = namespace === 'providers.kiro' ? profileKeys : namespace === 'bridge' ? bridgeKeys : authKeys
    assert.ok(bucket.has(key), `README documents \`${qualified}\` but index.js does not declare it`)
  }
  // The other direction matters just as much: an undocumented setting is one a user
  // cannot discover, and a renamed one still works by accident.
  const missing = [
    ...[...profileKeys].map(key => `providers.kiro.${key}`),
    ...[...bridgeKeys].map(key => `bridge.${key}`),
    ...[...authKeys].map(key => `auth.${key}`),
  ].filter(qualified => !documented.has(qualified))
  assert.deepEqual(missing, [], 'every declared key is documented')
})

test('the model table in the README is the catalog, cell by cell', () => {
  const readme = read('README.md')
  const rows = [...readme.matchAll(/^\| `([a-z0-9.\-/]+)` \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/gmu)]
  const catalog = [...buildCatalog({}).values()].filter(model => !model.variantOf)
  assert.equal(rows.length, catalog.length, 'every base model is listed, and nothing else is')
  const number = value => Number(value.replace(/,/gu, ''))
  for (const [row, model] of rows.map((match, index) => [match, catalog[index]])) {
    const [, id, name, context, maxOutput, wireMax, reasoning, efforts, vision, tools, rate] = row.map(value => value.trim())
    assert.equal(id.replace(/`/gu, ''), model.id)
    assert.equal(name, model.name)
    assert.equal(number(context), model.context)
    assert.equal(number(maxOutput), model.maxOutput)
    assert.equal(number(wireMax), model.wireMaxTokens)
    assert.equal(reasoning, model.reasoning)
    assert.equal(efforts, (model.efforts || []).join(' / ') || '—')
    assert.equal(vision === 'yes', model.vision === true)
    assert.equal(tools === 'yes', model.tools === true)
    assert.equal(Number(rate), model.rateMultiplier ?? 1)
  }
  // The numbers that matter most: no model advertises more than the wire allows.
  for (const model of buildCatalog({}).values()) {
    assert.ok(model.wireMaxTokens <= 32_000, `${model.id} would be rejected for its maxTokens`)
    assert.ok(model.wireMaxTokens <= model.maxOutput)
    assert.ok(model.context > model.wireMaxTokens, `${model.id} leaves no room for the prompt`)
  }
})

test('all eight sign-in methods are implemented and documented', () => {
  assert.deepEqual(AUTH_METHODS, ['builder-id', 'idc', 'google', 'github', 'external_idp', 'api_key', 'import', 'auto-import'])
  const signin = read('lib/auth/signin.js')
  const prompts = read('lib/auth/flows.js')
  const doc = read('docs/auth.md')
  for (const method of AUTH_METHODS) {
    assert.ok(signin.includes(method) || prompts.includes(`'${method}'`), `${method} is not reachable from the sign-in coordinator`)
    assert.match(doc, new RegExp(`\`${method}\``, 'u'), `${method} is undocumented`)
  }
  // The methods 9router offers, since that is the compatibility promise.
  for (const method of ['builder-id', 'idc', 'google', 'github', 'api_key', 'import']) {
    assert.ok(AUTH_METHODS.includes(method), `${method} must never disappear from the list`)
  }
})

test('relative links in the docs point at files that ship', () => {
  for (const file of ['README.md', 'docs/install.md', 'docs/auth.md']) {
    const text = read(file)
    const base = dirname(join(packageRoot, file))
    for (const [, target] of text.matchAll(/\]\((?!https?:\/\/)([^)#\s]+)(#[^)]*)?\)/gu)) {
      assert.ok(existsSync(resolve(base, target)), `${file} links to ${target}, which does not exist`)
    }
  }
  // The repository README points into the package, so its links resolve from the root.
  const repoRoot = resolve(packageRoot, '..')
  const root = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  for (const [, target] of root.matchAll(/\]\((?!https?:\/\/)([^)#\s]+)(#[^)]*)?\)/gu)) {
    assert.ok(existsSync(resolve(repoRoot, target)), `the repo README links to ${target}, which does not exist`)
  }
})

test('the Windows installer drives the one implementation of the install rules', () => {
  const script = read('install.ps1')
  assert.match(script, /'scripts'\)\s*'install\.mjs'/u, 'it must call the shared installer, not reimplement it')
  assert.match(script, /#Requires|Node 20/u)
  for (const flag of ['Profile', 'Link', 'PackOnly', 'Uninstall', 'DshPath']) {
    assert.match(script, new RegExp(`\\$${flag}`, 'u'), `-` + `${flag} is accepted but never passed on`)
  }
  const installer = read('scripts/install.mjs')
  for (const option of ['--profile', '--link', '--pack-only', '--uninstall', '--dsh']) {
    assert.ok(installer.includes(`'${option}'`), `install.mjs lost ${option}, which install.ps1 still promises`)
  }
})

test('the license covers what this plugin is and is not', () => {
  const license = read('LICENSE')
  assert.match(license, /^MIT License/u)
  assert.match(license, /Copyright \(c\) \d{4} kiro2dsh contributors/u)
  assert.match(license, /not\s+affiliated\s+with,\s+endorsed\s+by,\s+or\s+sponsored\s+by\s+Amazon\s+Web\s+Services\s+or\s+Kiro/iu)
  assert.match(license, /your own\s+account/iu, 'the terms of use are the user\u0027s own')
})

test('nothing in lib reaches for the harness', async () => {
  // Checked here as well as by scripts/check-imports.mjs, because a test file that
  // reads the sources runs in this package's own `npm test`, where the dependency is
  // not installed at all.
  const files = ['./lib/adapter.js']
  for (const file of files) {
    const text = read(file)
    const offenders = [...text.matchAll(/from '(@deepseek-ai|@cordis)[^']*'/gu)].map(match => match[0])
    if (file === './lib/adapter.js') {
      assert.deepEqual(offenders, [], 'the adapter seam is harness-free by design')
    } else {
      assert.ok(offenders.length >= 0)
    }
  }
  const index = read('index.js')
  assert.match(index, /@deepseek-ai/u, 'index.js is where the harness is allowed in')
})
