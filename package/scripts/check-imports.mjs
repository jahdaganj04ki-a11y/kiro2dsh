#!/usr/bin/env node
/**
 * Module-boundary and load check.
 *
 * Two properties matter for this plugin and are easy to lose in a refactor:
 *
 *  1. every module must *load* on its own — a circular import or a renamed export
 *     would otherwise only surface when a user happens to open that path;
 *  2. `lib/**` must stay free of harness imports, because that is what lets the
 *     whole protocol run under `node --test` with no installed dependencies, and
 *     what keeps provider logic in one direction (lib → harness types never).
 *
 * @module scripts/check-imports.mjs
 */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Files allowed to import `@deepseek-ai/*`: the plugin entry and the adapter seam. */
const HARNESS_ALLOWED = new Set(['index.js', 'lib/adapter.js'])

/** Recursively collect `.js` files below a directory. */
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(path)
  }
  return out
}

const failures = []
const files = [...await walk(join(root, 'lib')), join(root, 'index.js')]

for (const file of files) {
  const rel = relative(root, file).replace(/\\/gu, '/')
  const source = await readFile(file, 'utf8')
  const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gmu)].map(match => match[1])
    .concat([...source.matchAll(/^\s*export\s[^;]*?from\s+['"]([^'"]+)['"]/gmu)].map(match => match[1]))
  for (const specifier of imports) {
    if (specifier.startsWith('@deepseek-ai/')) {
      if (!HARNESS_ALLOWED.has(rel)) failures.push(`${rel}: imports ${specifier}; lib/* must stay harness-free`)
      continue
    }
    if (specifier.startsWith('node:')) continue
    if (!specifier.startsWith('.')) {
      failures.push(`${rel}: imports the bare specifier "${specifier}" — only @deepseek-ai/* packages and node: builtins are allowed`)
      continue
    }
    // A relative import must resolve to a file that exists, or the module graph is
    // broken and only the code path that touched it would ever notice.
    const target = resolve(dirname(file), specifier)
    try {
      await readFile(target)
    } catch {
      failures.push(`${rel}: cannot resolve "${specifier}"`)
    }
  }
  if (/from\s+['"]\.\.\/\.\.\//u.test(source)) {
    failures.push(`${rel}: reaches above the package root`)
  }
  if (/\brequire\s*\(/u.test(source)) {
    failures.push(`${rel}: uses require() in an ES module`)
  }
}

// Load every module the way the plugin will, so a missing named export fails here.
for (const file of files) {
  if (file.endsWith('index.js')) continue
  try {
    await import(`file://${file}`)
  } catch (error) {
    failures.push(`${relative(root, file)}: failed to load — ${error.message}`)
  }
}

if (failures.length > 0) {
  console.error(`module check failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`module check passed (${files.length} modules, harness imports confined to ${[...HARNESS_ALLOWED].join(', ')})`)
