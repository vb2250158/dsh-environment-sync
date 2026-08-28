[CmdletBinding()]
param()

$sourceRoot = $env:DSH_SOURCE_ROOT
if ([string]::IsNullOrWhiteSpace($sourceRoot)) {
  throw 'DSH_SOURCE_ROOT is required.'
}

$entry = Join-Path $sourceRoot 'apps\cli\src\bin.ts'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  throw "DSH_SOURCE_ROOT does not contain apps\\cli\\src\\bin.ts: $sourceRoot"
}

$port = if ([string]::IsNullOrWhiteSpace($env:DSH_WEB_PORT)) { 3180 } else { [int]$env:DSH_WEB_PORT }
if ($port -lt 1 -or $port -gt 65535) {
  throw "DSH_WEB_PORT must be between 1 and 65535: $port"
}

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
      exit 0
    }
  } catch {}

  $listeners | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
}

$dshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { Join-Path $HOME '.dsh' } else { $env:DSH_HOME }
$logDirectory = Join-Path $dshHome 'logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$standardOutputLog = Join-Path $logDirectory 'web-host.stdout.log'
$standardErrorLog = Join-Path $logDirectory 'web-host.stderr.log'

$env:NODE_USE_ENV_PROXY = '1'
$node = (Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $node -ArgumentList @('--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', "$port") -WorkingDirectory $sourceRoot -WindowStyle Hidden -RedirectStandardOutput $standardOutputLog -RedirectStandardError $standardErrorLog | Out-Null
