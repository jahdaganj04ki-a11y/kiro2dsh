#!/usr/bin/env node
/**
 * Install the Kiro plugin into a DSH profile.
 *
 * DSH installs plugins as packages, not as files dropped into a folder: the
 * profile's `package.json` holds the dependency, and its ordered
 * `dsh.profile.bundles` list decides what loads. Hand-editing those two is how a
 * plugin ends up installed-but-not-loaded, so this script only ever calls the
 * supported command — `dsh plugin --profile <profile> add <tarball>` — and packs
 * a real tarball to hand it. When `dsh` cannot be found, it prints the exact
 * command instead of inventing a private install path.
 *
 * Usage:
 *   node scripts/install.mjs                     pack + install into profile "web"
 *   node scripts/install.mjs --profile desktop   another profile
 *   node scripts/install.mjs --link              install from this directory (dev)
 *   node scripts/install.mjs --pack-only         stop after the tarball
 *   node scripts/install.mjs --uninstall         remove it again
 *   node scripts/install.mjs --dsh "C:\\path\\dsh.cmd"
 */

import { execFile, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

/** Parse argv without a dependency, since this must run in a bare checkout. */
function parseArgs(argv) {
  const options = { profile: 'web', link: false, packOnly: false, uninstall: false, dsh: process.env.DSH_BIN || null, yes: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = argv[++index] || options.profile
    else if (arg === '--dsh') options.dsh = argv[++index] || options.dsh
    else if (arg === '--link') options.link = true
    else if (arg === '--pack-only') options.packOnly = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--yes') options.yes = true
    else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n\n${usage()}`)
      process.exit(64)
    }
  }
  return options
}

function usage() {
  return [
    'usage: node scripts/install.mjs [--profile <name>] [--dsh <path>] [--link] [--pack-only] [--uninstall] [--yes]',
    '',
    '  --profile   DSH profile to install into (default: web)',
    '  --link      install this directory as a link: dependency instead of a tarball',
    '  --pack-only produce dist/*.tgz and stop',
    '  --uninstall remove the plugin from the profile',
    '  --dsh       path to the dsh executable (or set DSH_BIN)',
  ].join('\n')
}

/** Windows needs `shell: true` for `.cmd` shims; POSIX must not use a shell. */
const useShell = process.platform === 'win32'

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assertPluginPackage(manifest)

  const dsh = options.dsh ? resolve(options.dsh) : findDsh()
  if (!dsh) {
    console.error([
      'Could not find the `dsh` executable.',
      '',
      `Install the plugin by hand with:`,
      `  dsh plugin --profile ${options.profile} add <path to the tarball below>`,
      '',
      'Or point this script at the executable: --dsh "C:\\Users\\you\\AppData\\Local\\Programs\\dsh-desktop\\resources\\bin\\dsh.cmd"',
    ].join('\n'))
    if (!options.uninstall) {
      const tarball = await pack(manifest)
      console.log(`\npacked: ${tarball}`)
    }
    process.exit(3)
  }
  console.log(`dsh: ${dsh}`)

  if (options.uninstall) {
    await run(dsh, ['plugin', '--profile', options.profile, 'remove', manifest.name], { shell: useShell })
    console.log(`removed ${manifest.name} from profile "${options.profile}". Restart Harness to finish.`)
    return
  }

  const target = options.link ? `link:${packageRoot}` : await pack(manifest)
  if (options.packOnly) return

  console.log(`installing ${target} into profile "${options.profile}"…`)
  const result = spawnSync(dsh, ['plugin', '--profile', options.profile, 'add', target], {
    encoding: 'utf8',
    shell: useShell,
    maxBuffer: 8 * 1024 * 1024,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (output.trim()) console.log(output.trim())
  if (result.status !== 0) {
    if (/already-installed/iu.test(output)) {
      console.error([
        'The profile already installs this package. With HMR enabled DSH refuses to install over a',
        'running copy, so remove it first and try again:',
        `  ${basename(dsh)} plugin --profile ${options.profile} remove ${manifest.name}`,
      ].join('\n'))
      process.exit(4)
    }
    // A peer-range refusal is the usual failure after a DSH upgrade, and the fix is
    // a recorded exemption rather than a version lie in package.json.
    if (/incompatible-version|peer/iu.test(output)) {
      console.error([
        'DSH refused the plugin because its peer versions do not match this DSH build.',
        'Check the runtime version, then grant an exemption only if you accept the risk:',
        `  ${basename(dsh)} plugin --profile ${options.profile} version-exemptions`,
        `  ${basename(dsh)} plugin --profile ${options.profile} allow-version ${manifest.name}@${manifest.version} --dsh-version <runtimeVersion> --accept-risk`,
      ].join('\n'))
      process.exit(5)
    }
    console.error(`installation failed with status ${result.status}`)
    process.exit(result.status ?? 1)
  }

  console.log([
    '',
    `Installed ${manifest.name}@${manifest.version}.`,
    output.includes('restart-required') ? 'Restart Harness (or DSH Desktop) to load it.' : 'DSH applied it; if the model list does not appear, restart Harness.',
    '',
    'Next:',
    '  1. Settings › Plugins › Kiro models',
    '  2. "Use my local Kiro session" if the Kiro IDE is signed in on this machine, or pick another method.',
    '  3. Models page → route `kiro`: every model carries its own endpoint, context, output cap and reasoning mode.',
    '  4. Optional: set `bridge.enable: true` to expose the same models to other agents on 127.0.0.1.',
  ].join('\n'))
}

/** Fail loudly on a manifest that cannot load, rather than letting DSH reject it later. */
function assertPluginPackage(manifest) {
  const problems = []
  if (manifest.type !== 'module') problems.push('package.json must declare "type": "module"')
  if (!manifest.exports?.['.']) problems.push('package.json needs an "./" export pointing at index.js')
  if (!manifest.dsh?.client) problems.push('package.json is missing "dsh.client" (the settings panel contribution)')
  if (!existsSync(join(packageRoot, 'index.js'))) problems.push('index.js is missing')
  const missing = ['lib', 'client.js'].filter(entry => !existsSync(join(packageRoot, entry)))
  if (missing.length > 0) problems.push(`missing files: ${missing.join(', ')}`)
  if (problems.length > 0) {
    console.error(`this directory is not a complete DSH plugin:\n  - ${problems.join('\n  - ')}`)
    process.exit(2)
  }
}

/** `npm pack` into `dist/`, returning the absolute tarball path. */
async function pack(manifest) {
  const dist = join(packageRoot, 'dist')
  mkdirSync(dist, { recursive: true })
  const before = new Set(listTarballs(dist))
  await run('npm', ['pack', '--packaging-strict', '--json'], { cwd: packageRoot, maxBuffer: 4 * 1024 * 1024 }).catch(async error => {
    // Older npm releases reject the flag; retry once without it.
    if (!/packaging-strict/iu.test(String(error?.stderr || error?.message))) throw error
    return run('npm', ['pack', '--json'], { cwd: packageRoot, maxBuffer: 4 * 1024 * 1024 })
  })
  const created = listTarballs(dist).filter(name => !before.has(name))
  const tarball = created[0] || listTarballs(dist).sort().at(-1)
  if (!tarball) {
    console.error('npm pack produced no tarball; run `npm pack` inside the package directory to see why')
    process.exit(2)
  }
  const path = resolve(dist, tarball)
  console.log(`packed ${basename(path)} (${(readFileSync(path).byteLength / 1024).toFixed(0)} kB)`)
  return path
}

function listTarballs(dir) {
  try {
    return readdirSync(dir).filter(name => name.endsWith('.tgz'))
  } catch {
    return []
  }
}

/**
 * Locate the `dsh` executable.
 *
 * Desktop ships the CLI beside the app rather than on PATH, so the Windows
 * install roots are checked explicitly: guessing "it is not installed" and
 * telling the user to install again would be the wrong diagnosis.
 */
function findDsh() {
  const candidates = []
  const local = process.env.LOCALAPPDATA || ''
  const programFiles = process.env.PROGRAMFILES || process.env['ProgramFiles'] || 'C:\\Program Files'
  if (local) candidates.push(join(local, 'Programs', 'dsh-desktop', 'resources', 'bin', 'dsh.cmd'))
  if (programFiles) candidates.push(join(programFiles, 'dsh-desktop', 'resources', 'bin', 'dsh.cmd'))
  if (local) candidates.push(join(local, 'dsh', 'bin', 'dsh.cmd'))
  candidates.push(join(process.env.HOME || '', '.local', 'bin', 'dsh'))
  candidates.push('/usr/local/bin/dsh')
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
  const found = String(which.stdout || '').split(/\r?\n/u).map(line => line.trim()).find(Boolean)
  return found || null
}

main().catch(error => {
  console.error(error?.stderr || error?.message || String(error))
  process.exit(1)
})
