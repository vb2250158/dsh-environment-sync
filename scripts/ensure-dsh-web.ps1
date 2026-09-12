[CmdletBinding()]
param(
  [switch]$Restart
)

$sourceRoot = $env:DSH_SOURCE_ROOT
if ([string]::IsNullOrWhiteSpace($sourceRoot)) {
  throw 'DSH_SOURCE_ROOT is required.'
}

$entry = Join-Path $sourceRoot 'apps\cli\src\bin.ts'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  throw "DSH_SOURCE_ROOT does not contain apps\cli\src\bin.ts: $sourceRoot"
}

$port = if ([string]::IsNullOrWhiteSpace($env:DSH_WEB_PORT)) { 3180 } else { [int]$env:DSH_WEB_PORT }
if ($port -lt 1 -or $port -gt 65535) {
  throw "DSH_WEB_PORT must be between 1 and 65535: $port"
}

$dshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { Join-Path $HOME '.dsh' } else { $env:DSH_HOME }
$profile = if ([string]::IsNullOrWhiteSpace($env:DSH_WEB_PROFILE)) { 'web' } else { $env:DSH_WEB_PROFILE }
$restartMarker = Join-Path $dshHome "profiles\$profile\.dsh-restart-required"
$mutex = New-Object System.Threading.Mutex($false, "Local\DeepSeekHarness-Web-$port")
$lockTaken = $false
$standardOutputLog = Join-Path $dshHome 'logs\web-host.stdout.log'

# Resolve the Node runtime explicitly instead of trusting PATH order. A harness
# built for one Node major version carries native addons compiled for that
# version's ABI (NODE_MODULE_VERSION); a mismatched interpreter aborts the boot
# with ERR_DLOPEN_FAILED. DSH_NODE_BIN wins, then a well-known absolute install,
# and only then PATH.
function Resolve-NodeRuntime {
  $explicit = $env:DSH_NODE_BIN
  if (-not [string]::IsNullOrWhiteSpace($explicit)) {
    if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) {
      throw "DSH_NODE_BIN does not point at a file: $explicit"
    }
    return $explicit
  }
  # Join-Path throws on a null Path, and ProgramFiles(x86) is absent on 32-bit
  # Windows, so the roots are filtered before any path is composed.
  $candidates = @()
  foreach ($programFiles in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not [string]::IsNullOrWhiteSpace($programFiles)) {
      $candidates += (Join-Path $programFiles 'nodejs\node.exe')
    }
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $onPath) { throw 'No Node.js runtime found on PATH and no absolute install detected. Set DSH_NODE_BIN.' }
  return $onPath.Source
}

# Probe a native addon before anything is stopped, so an ABI mismatch fails
# while the previous host is still serving. Returns $null when no addon is
# available to test (nothing to assert either way).
function Test-NodeRuntimeCompatible {
  param([string]$NodePath, [string]$Root)
  $pnpmDir = Join-Path $Root 'node_modules\.pnpm'
  if (-not (Test-Path -LiteralPath $pnpmDir -PathType Container)) { return $null }
  $addon = Get-ChildItem -LiteralPath $pnpmDir -Directory -Filter 'fs-ext@*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'node_modules\fs-ext' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
    Select-Object -First 1
  if ($null -eq $addon) { return $null }
  $target = ($addon -replace '\\', '/')
  & $NodePath -e "require('$target')" *> $null
  return ($LASTEXITCODE -eq 0)
}

function Test-DshWebHealth {
  $probeUri = "http://127.0.0.1:$port/"
  if (Test-Path -LiteralPath $standardOutputLog -PathType Leaf) {
    $launch = Get-Content -LiteralPath $standardOutputLog -Tail 20 |
      Select-String -Pattern 'dsh web: (http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+)' |
      Select-Object -Last 1
    if ($null -ne $launch) {
      $candidate = [Uri]$launch.Matches[0].Groups[1].Value
      if ($candidate.Port -eq $port) { $probeUri = $candidate.AbsoluteUri }
    }
  }
  try {
    $probeSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $response = Invoke-WebRequest -Uri $probeUri -WebSession $probeSession -UseBasicParsing -TimeoutSec 5
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  } catch {
    # A failed HTTP probe is unhealthy; startup retries until its deadline.
    return $false
  }
}

try {
  $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(2))
  if (-not $lockTaken) { exit 0 }

  $restartRequired = $Restart -or (Test-Path -LiteralPath $restartMarker -PathType Leaf)
  $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0 -and -not $restartRequired) {
    if (Test-DshWebHealth) { exit 0 }
  }

  # Everything that can fail is checked while the current host is still up.
  $node = Resolve-NodeRuntime
  $compatible = Test-NodeRuntimeCompatible -NodePath $node -Root $sourceRoot
  if ($compatible -eq $false) {
    throw "Node runtime $node cannot load the harness native addons (ABI mismatch). The running DSH instance was left untouched. Set DSH_NODE_BIN to a matching runtime, or rebuild the addons for this one."
  }

  $listeners | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'apps/cli/src/bin\.ts.*\bweb\b' -and $_.CommandLine -match "(?:^|\\s)--port\\s+$port(?:\\s|$)" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $stopDeadline = (Get-Date).AddSeconds(15)
  while (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0 -and (Get-Date) -lt $stopDeadline) {
    Start-Sleep -Milliseconds 250
  }
  if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
    throw "Port $port is still in use after stopping DSH."
  }

  $logDirectory = Join-Path $dshHome 'logs'
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  $standardOutputLog = Join-Path $logDirectory 'web-host.stdout.log'
  $standardErrorLog = Join-Path $logDirectory 'web-host.stderr.log'
  $env:NODE_USE_ENV_PROXY = '1'
  $process = Start-Process -FilePath $node -ArgumentList @('--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', "$port") -WorkingDirectory $sourceRoot -WindowStyle Hidden -RedirectStandardOutput $standardOutputLog -RedirectStandardError $standardErrorLog -PassThru
  $startDeadline = (Get-Date).AddSeconds(45)
  do {
    if ($process.HasExited) { throw "DSH exited during startup. See $standardErrorLog" }
    if (Test-DshWebHealth) {
      Remove-Item -LiteralPath $restartMarker -Force -ErrorAction SilentlyContinue
      exit 0
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $startDeadline)
  throw "DSH did not become healthy on port $port. See $standardErrorLog"
} finally {
  if ($lockTaken) { $mutex.ReleaseMutex() | Out-Null }
  if ($null -ne $mutex) { $mutex.Dispose() }
}
