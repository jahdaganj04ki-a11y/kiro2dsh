# Installing the Kiro plugin

The plugin is a normal npm package that DSH installs into a *profile*. Nothing is
copied into the DSH application directory, and no DSH file is edited by hand.

## What DSH actually does with a plugin

A DSH profile is a small npm project. On Windows it lives beside the desktop's user
data:

```text
%APPDATA%\dsh-desktop\harness\package.json      ← dependencies + the plugin list
%APPDATA%\dsh-desktop\harness\node_modules\dsh-desktop-kiro\
```

Installing a plugin therefore means "add this package to the profile and let the
loader know". That is why the supported paths all take a **tarball**: a directory
copy that never enters `package.json` is installed on disk but never loaded, which is
the most common way a plugin appears to be broken.

## Path A — the scripts in this package (recommended)

From the `package` directory, with DSH Desktop installed:

```powershell
.\install.ps1                       # pack + install into profile "web"
.\install.ps1 -Profile desktop
.\install.ps1 -Link                 # install this checkout, so edits reload with HMR
.\install.ps1 -PackOnly             # only build dist\*.tgz
.\install.ps1 -Uninstall
.\install.ps1 -DshPath "C:\path\to\dsh.cmd"
```

Node 22 or newer is needed to run these scripts (and to run the tests); the plugin
itself executes inside DSH's own runtime.

It is a thin wrapper over `scripts/install.mjs`, which does the work on every
platform:

```bash
node scripts/install.mjs --profile web
node scripts/install.mjs --link      # development against a running DSH
```

The script:

1. checks the package is a complete plugin (`type: module`, an `./` export, the
   `dsh.client` contribution, `index.js`, `client.js`, `lib/`);
2. runs `npm pack` into `dist/` — whose `prepack` hook runs the import guard and the
   whole test suite first, so a package that installs is a package that tested
   (`npm pack --ignore-scripts` skips that step);
3. finds the `dsh` executable — next to the Windows install
   (`%LOCALAPPDATA%\Programs\dsh-desktop\resources\bin\dsh.cmd`,
   `%PROGRAMFILES%\dsh-desktop\…`), or on `PATH`, or via `--dsh`;
4. runs `dsh plugin --profile <profile> add <tarball>` and reports what it printed.

If `dsh` cannot be found it does **not** guess at a private install path: it prints
the tarball's location and the exact command to run, and exits `3`.

Exit codes: `2` broken package, `3` no `dsh` found, `4` already installed,
`5` refused because of the DSH version, anything else is the CLI's own status.

## Path B — DSH Desktop's own plugin manager

Settings → Plugins. Choose "install from a file" (the label varies by version) and pick
`dist\dsh-desktop-kiro-<version>.tgz`. Use **Path A**'s `--pack-only` to produce it.

Some builds only offer the plugin market. If the file chooser is missing, your build
predates local installs; `dsh plugin add --help` tells you whether the CLI accepts a
local `.tgz`. Do not install by hand into `node_modules` and expect it to load.

## Path C — the CLI directly

```powershell
dsh plugin --profile web add dist\dsh-desktop-kiro-0.1.0.tgz
dsh plugin --profile web remove dsh-desktop-kiro
```

`link:` installs are supported for development:

```powershell
dsh plugin --profile web add link:C:\work\kiro2dsh\package
```

With HMR on, DSH refuses to install over a running copy (`already-installed`) — remove
it first, then add it again.

## Verifying it

Two different facts, and it is worth keeping them apart:

```powershell
# 1. configured: the plugin is in the profile's layers
dsh --profile web --dump-config | Select-String kiro

# 2. loaded: restart DSH Desktop, then look for "Kiro models" under Settings → Plugins
#    and for the `kiro` provider route on the Models page
```

`--dump-config` proves configuration only. Loading needs a restart, and the desktop
build must not be "restarted" by reloading a window — quit the app.

Then sign in (**Settings → Plugins → Kiro models** → *Use my local Kiro session* when
the Kiro IDE is logged in on this machine) and press **Refresh from Kiro**. A working
install answers with a model count; `GET http://127.0.0.1:<port>/v1/kiro/status` says
the same thing when `bridge.enable` is on.

## When a DSH upgrade refuses the package

The plugin pins its peers to the DSH package versions it was tested against:

```json
"peerDependencies": { "@deepseek-ai/dsh-llm": "^0.1.2-rc.1 || ^0.1.7-rc.1 || …" }
```

After a Desktop upgrade the install can be refused with `incompatible-version` or a
peer warning. Read the runtime version (About, or `dsh --version`), then decide:

```powershell
dsh plugin --profile web version-exemptions
dsh plugin --profile web allow-version dsh-desktop-kiro@0.1.0 --dsh-version <runtimeVersion> --accept-risk
```

An exemption says "run it anyway". The plugin's harness surface is narrow — the
adapter contract, `ctx.settings`, `ctx.credentials`, `ctx.connection.fetch.register`,
`ctx.authorization` — so it usually survives a bump, but a refusal is information, not
noise: update the ranges in `package.json` and rebuild when you can.

## Offline or restricted machines

`npm pack` needs no network, and the plugin has one runtime dependency
(`@deepseek-ai/schemastery`, already present in DSH). To move the package by hand:

```bash
cd package && npm pack          # → dsh-desktop-kiro-0.1.0.tgz
```

Copy the tarball and install it with Path B or C. To install into a profile without
`dsh`, unpack it inside the profile and add the dependency yourself — but then DSH's
plugin list also has to be updated, which is exactly what the CLI does for you, so
prefer any path that goes through `dsh`.

## Uninstall

```powershell
.\install.ps1 -Uninstall
# or
dsh plugin --profile web remove dsh-desktop-kiro
```

The credential record (`dsh-desktop-kiro/account` in the credential store) and the
settings namespace are left in place, so a reinstall finds your accounts. Remove each
account in the panel first if that is not what you want; see [auth.md](auth.md#what-is-stored-where).
