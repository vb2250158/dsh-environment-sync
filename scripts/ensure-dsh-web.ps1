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
$mutex = New-Object System.Threading.Mutex($false, "Local\\DeepSeekHarness-Web-$port")
$lockTaken = $false

try {
  $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(2))
  if (-not $lockTaken) { exit 0 }

  $restartRequired = $Restart -or (Test-Path -LiteralPath $restartMarker -PathType Leaf)
  $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0 -and -not $restartRequired) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { exit 0 }
    } catch {}
  }

  $listeners | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
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
  $node = (Get-Command node -ErrorAction Stop).Source
  $process = Start-Process -FilePath $node -ArgumentList @('--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', "$port") -WorkingDirectory $sourceRoot -WindowStyle Hidden -RedirectStandardOutput $standardOutputLog -RedirectStandardError $standardErrorLog -PassThru
  $startDeadline = (Get-Date).AddSeconds(45)
  do {
    if ($process.HasExited) { throw "DSH exited during startup. See $standardErrorLog" }
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
        Remove-Item -LiteralPath $restartMarker -Force -ErrorAction SilentlyContinue
        exit 0
      }
    } catch {}
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $startDeadline)
  throw "DSH did not become healthy on port $port. See $standardErrorLog"
} finally {
  if ($lockTaken) { $mutex.ReleaseMutex() | Out-Null }
  $mutex.Dispose()
}
