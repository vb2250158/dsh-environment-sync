[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$Repository,
  [string]$DshHome = (Join-Path $HOME '.dsh'),
  [string]$DataRoot = ''
)
$ErrorActionPreference = 'Stop'
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$DshHome = [IO.Path]::GetFullPath($DshHome)
if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'apps\cli\src\bin.ts'))) { throw 'SourceRoot must point to an installed and built DSH source checkout.' }
if ($Repository -notmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$') { throw 'Repository must be a GitHub HTTPS URL.' }
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Join-Path $DshHome 'private-data' }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$pluginRoot = Split-Path $PSScriptRoot
$commit = (& git -C $pluginRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Run this bootstrap from a checked-out plugin Git release.' }
$env:DSH_HOME = $DshHome
$env:DSH_SOURCE_ROOT = $SourceRoot
$recoveryRoot = Join-Path $DshHome "recovery-runtime\$commit"
if (-not (Test-Path -LiteralPath $recoveryRoot)) {
  & git clone --no-hardlinks $pluginRoot $recoveryRoot
  if ($LASTEXITCODE -ne 0) { throw 'Could not preserve the recovery runtime.' }
  & git -C $recoveryRoot checkout --detach $commit
  if ($LASTEXITCODE -ne 0) { throw 'Could not pin the recovery runtime.' }
}
& pnpm --dir $recoveryRoot install --ignore-scripts --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the recovery runtime.' }
$env:DSH_BOOTSTRAP_PLUGIN_ROOT = $recoveryRoot
$env:DSH_BOOTSTRAP_COMMIT = $commit
& pnpm --dir $SourceRoot dsh plugin --profile web install --lockfile-only --modules-dir .dsh-resolution-modules
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the profile.' }
& node --input-type=module -e 'import fs from "node:fs"; import {pathToFileURL} from "node:url"; import {join} from "node:path"; const m=await import(pathToFileURL(join(process.env.DSH_BOOTSTRAP_PLUGIN_ROOT,"scripts/sync-third-party-plugins.mjs"))); const directory=join(process.env.DSH_HOME,"profiles/web"); m.alignOfficialRuntime(directory,process.env.DSH_SOURCE_ROOT,[JSON.parse(fs.readFileSync(join(process.env.DSH_BOOTSTRAP_PLUGIN_ROOT,"package.json"),"utf8"))]); const path=join(directory,"package.json"); const p=JSON.parse(fs.readFileSync(path,"utf8")); p.dependencies["dsh-environment-sync"]="github:vb2250158/dsh-environment-sync#"+process.env.DSH_BOOTSTRAP_COMMIT; fs.writeFileSync(path,JSON.stringify(p,null,2)+"\n");'
if ($LASTEXITCODE -ne 0) { throw 'Could not align the official DSH runtime.' }
& pnpm --dir $SourceRoot dsh plugin --profile web install --lockfile-only --modules-dir .dsh-resolution-modules
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the sync plugin.' }
& pnpm --dir $SourceRoot dsh plugin --profile web install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Could not install the sync runtime.' }
if (-not (Test-Path -LiteralPath $DataRoot)) {
  & git clone $Repository $DataRoot
  if ($LASTEXITCODE -ne 0) { throw 'Cannot clone the private repository. Sign in to GitHub with repository access, then retry.' }
} elseif (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.git'))) { throw 'DataRoot already exists and is not a Git clone; it was not overwritten.' }
$config = @{ dataRemoteUrl=$Repository; dataLocalPath=$DataRoot } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $DshHome 'profiles\web\private-plugin-repository.json'), $config + "`n")
$recoveryScript = Join-Path $DshHome 'recover-environment.ps1'
$template = @'
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
  $env:DSH_HOME = '__HOME__'
  $env:DSH_SOURCE_ROOT = '__SOURCE__'
  & node '__PLUGIN__/scripts/recover-environment.mjs' --dsh-home $env:DSH_HOME --source-root $env:DSH_SOURCE_ROOT --repository '__DATA__'
  if ($LASTEXITCODE -ne 0) { throw 'Environment recovery failed; the recovery point remains available.' }
  & '__PLUGIN__/scripts/ensure-dsh-web.ps1' -Restart
  [System.Windows.Forms.MessageBox]::Show('Environment restored. Open DSH to continue.', 'DSH recovery') | Out-Null
} catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'DSH recovery') | Out-Null }
'@
$template = $template.Replace('__HOME__',$DshHome.Replace("'","''")).Replace('__SOURCE__',$SourceRoot.Replace("'","''")).Replace('__PLUGIN__',$recoveryRoot.Replace("'","''")).Replace('__DATA__',$DataRoot.Replace("'","''"))
[IO.File]::WriteAllText($recoveryScript, $template + "`n")
$command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $recoveryScript + '"'
[IO.File]::WriteAllText((Join-Path $DshHome 'Recover DSH.vbs'), 'CreateObject("WScript.Shell").Run "' + $command.Replace('"','""') + '", 0, False' + "`n")
& (Join-Path $PSScriptRoot 'ensure-dsh-web.ps1') -Restart
Write-Output 'Open Settings > My plugins, enter the sync key securely, then Pull and apply. Daily synchronization is available in that page.'
