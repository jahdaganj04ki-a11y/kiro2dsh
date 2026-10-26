#Requires -Version 5.1
<#
.SYNOPSIS
  Pack this plugin and install it into a DSH Desktop profile.

.DESCRIPTION
  A thin Windows entry point for scripts/install.mjs, which does the work on every
  platform: it checks the package, runs `npm pack`, finds the `dsh` executable next to
  the DSH Desktop install (or on PATH), and hands the tarball to
  `dsh plugin --profile <profile> add`.

  Keeping the logic in one file is deliberate - a PowerShell copy of the install rules
  is a second thing to get wrong. This script only answers the two questions Windows
  asks first: is Node present, and where is dsh.

.PARAMETER Profile
  DSH profile to install into. Defaults to "web", which is what DSH Desktop uses.

.PARAMETER Link
  Install this directory as a `link:` dependency instead of a tarball. Use it while
  developing: with HMR the plugin reloads on change.

.PARAMETER PackOnly
  Build dist\*.tgz and stop, for installing through DSH Desktop's own plugin UI.

.PARAMETER Uninstall
  Remove the plugin from the profile again.

.PARAMETER DshPath
  Full path to dsh.cmd / dsh.exe, when it is not where the installer looks.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Profile desktop
  .\install.ps1 -Link
  .\install.ps1 -Uninstall

.NOTES
  Exit codes come from scripts/install.mjs: 2 broken package, 3 no dsh found,
  4 already installed (remove it first), 5 DSH version refused. Restart DSH Desktop
  after a successful install - configuration and loading are different facts.
#>
[CmdletBinding()]
param(
  # `$Profile` is an automatic variable in PowerShell, so the parameter is named for
  # what it is and carries `-Profile` as its alias.
  [Alias('Profile')]
  [string] $DshProfile = 'web',
  [switch] $Link,
  [switch] $PackOnly,
  [switch] $Uninstall,
  [string] $DshPath
)

$ErrorActionPreference = 'Stop'
$script:PackageRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($script:PackageRoot)) {
  $script:PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

function Get-FirstCommand {
  param([string[]] $Names)
  foreach ($name in $Names) {
    $found = Get-Command $name -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
  }
  return $null
}

# Node 22 or newer: `npm test` uses glob patterns as arguments, which Node learned in
# 21, and the plugin's own runtime features (`fetch`, `ReadableStream`,
# `structuredClone`) are what a current DSH build ships. PowerShell 5.1 on Windows 10
# is fine either way.
$node = Get-FirstCommand @('node', 'node.exe')
if (-not $node) {
  Write-Host 'node was not found on PATH.' -ForegroundColor Red
  Write-Host 'Install Node.js 22 or newer (https://nodejs.org), or install the built package by hand:' -ForegroundColor Yellow
  Write-Host '  1. npm pack           (inside the package directory, with Node available)'
  Write-Host '  2. dsh plugin --profile' $DshProfile 'add dsh-desktop-kiro-*.tgz'
  exit 127
}

# `Stop` would turn a native command's stderr into a terminating error on PowerShell
# 5.1, and a version probe has no business failing the script.
$ErrorActionPreference = 'Continue'
$versionLine = (& $node -v 2>$null)
$ErrorActionPreference = 'Stop'
$major = 0
if ($versionLine -match 'v(\d+)') { $major = [int] $Matches[1] }
if ($major -lt 22) {
  Write-Host "node $versionLine is too old; this installer needs Node 22 or newer." -ForegroundColor Red
  exit 127
}

# A quick sanity check that we are standing in the plugin, not in the repo root.
$installer = Join-Path (Join-Path $script:PackageRoot 'scripts') 'install.mjs'
$manifestPath = Join-Path $script:PackageRoot 'package.json'
if (-not (Test-Path -LiteralPath $installer) -or -not (Test-Path -LiteralPath $manifestPath)) {
  Write-Host "install.ps1 must sit in the plugin package directory next to scripts\install.mjs." -ForegroundColor Red
  Write-Host "Looked in: $script:PackageRoot"
  exit 2
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
Write-Host ("kiro2dsh: installing {0}@{1} into DSH profile `"{2}`"" -f $manifest.name, $manifest.version, $DshProfile) -ForegroundColor Cyan

$arguments = @($installer, '--profile', $DshProfile)
if ($Link) { $arguments += '--link' }
if ($PackOnly) { $arguments += '--pack-only' }
if ($Uninstall) { $arguments += '--uninstall' }
if (-not [string]::IsNullOrWhiteSpace($DshPath)) { $arguments += @('--dsh', $DshPath) }

# npm on Windows is a .cmd shim, so the installer calls node directly - and the same
# is true here. Everything after the script path is passed through verbatim.
& $node @arguments
$code = $LASTEXITCODE

if ($code -eq 0) {
  Write-Host ''
  Write-Host 'Done. Quit DSH Desktop completely and open it again - a window reload is not a restart.' -ForegroundColor Green
  Write-Host 'Then: Settings -> Plugins -> Kiro models -> sign in, and check the Models page for the "kiro" route.'
} elseif ($code -eq 3) {
  Write-Host ''
  Write-Host 'The dsh CLI was not found. If DSH Desktop is installed elsewhere, pass its location:' -ForegroundColor Yellow
  Write-Host '  .\install.ps1 -DshPath "C:\Users\you\AppData\Local\Programs\dsh-desktop\resources\bin\dsh.cmd"'
  Write-Host 'The tarball is already built under dist\, so DSH Desktop''s own plugin UI can install it directly.'
}

exit $code
