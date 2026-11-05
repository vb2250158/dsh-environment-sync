/** Windows source-launch identity and standalone recovery helper coverage; no Host is started or stopped. */
import assert from 'node:assert/strict'
import childProcess, { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { PrivatePluginManager } from '../lib/private-plugin-manager.js'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const helper = join(packageRoot, 'scripts', 'dsh-web-runtime.ps1')
const ensure = join(packageRoot, 'scripts', 'ensure-dsh-web.ps1')
const bootstrap = join(packageRoot, 'scripts', 'bootstrap-environment.ps1')
const windows = process.platform === 'win32'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-runtime-')))
  t.after(async () => {
    const temporaryRoot = await realpath(tmpdir())
    assert.equal(dirname(resolve(root)), temporaryRoot)
    assert.ok(root.startsWith(join(temporaryRoot, 'dsh-web-runtime-')))
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('the runtime helper preserves explicit, standard-install and PATH resolution and exact branded Host identity', { skip: !windows }, async t => {
  const root = await fixture(t)
  const node = join(root, "DSH Host's.exe")
  const standard = join(root, 'program-files', 'nodejs', 'node.exe')
  const pathNode = join(root, 'path-node.exe')
  await mkdir(dirname(standard), { recursive: true })
  await Promise.all([node, standard, pathNode].map(path => writeFile(path, 'runtime fixture; never executed')))
  const entry = 'C:\\Synthetic source\\apps\\cli\\src\\bin.ts'
  const command = (runtime, suffix = '--no-open --port 15380') => `"${runtime}" --import tsx/esm "${entry}" web ${suffix}`
  const rows = [
    { ProcessId: 101, ExecutablePath: node, CommandLine: command(node) },
    { ProcessId: 102, ExecutablePath: node.toUpperCase(), CommandLine: command(node, '--port=15380') },
    { ProcessId: 103, ExecutablePath: join(root, 'foreign', "DSH Host's.exe"), CommandLine: command(node) },
    { ProcessId: 104, ExecutablePath: node, CommandLine: command(node, '--port 153800') },
    { ProcessId: 105, ExecutablePath: node, CommandLine: `"${node}" -e "apps/cli/src/bin.ts web --port 15380"` },
    { ProcessId: 106, ExecutablePath: node, CommandLine: `"${node}" --import tsx/esm other.js "${entry}" web --port 15380` },
    { ProcessId: 107, ExecutablePath: node, CommandLine: `"${node}" lib/mcp-server.js` },
    { ProcessId: 108, ExecutablePath: node, CommandLine: command(node, '--port 15380 --port 15480') },
    { ProcessId: 109, ExecutablePath: node, CommandLine: command(node, '--port 15480 --port 15380') },
  ]
  await writeFile(join(root, 'rows.json'), JSON.stringify(rows))
  const script = join(root, 'test.ps1')
  await writeFile(script, `
$ErrorActionPreference='Stop'
. $env:DSH_RUNTIME_HELPER
$script:rows=Get-Content -LiteralPath (Join-Path $env:TEST_ROOT 'rows.json') -Raw|ConvertFrom-Json
function Get-CimInstance { param($ClassName,$Filter); $script:lastFilter=$Filter; return $script:rows }
function Get-Command { [CmdletBinding()]param($Name,$CommandType); return [pscustomobject]@{Source=(Join-Path $env:TEST_ROOT 'path-node.exe')} }
$env:DSH_NODE_BIN=Join-Path $env:TEST_ROOT "DSH Host's.exe"
$explicit=Resolve-DshNodeRuntime
$branded=@(Get-DshWebHostProcesses -NodePath $explicit -Port 15380|ForEach-Object ProcessId)
$brandedFilter=$script:lastFilter
$script:rows=@([pscustomobject]@{ProcessId=201;ExecutablePath=$env:REAL_NODE;CommandLine=('"'+$env:REAL_NODE+'" --import tsx/esm apps/cli/src/bin.ts web --port 15380')})
$ordinary=@(Get-DshWebHostProcesses -NodePath $env:REAL_NODE -Port 15380|ForEach-Object ProcessId)
$ordinaryFilter=$script:lastFilter
$env:DSH_NODE_BIN=Join-Path $env:TEST_ROOT 'missing.exe'
$missing=$false
try { Resolve-DshNodeRuntime|Out-Null } catch { $missing=$_.Exception.Message -like '*DSH_NODE_BIN*' }
$env:DSH_NODE_BIN=''
$env:ProgramFiles=Join-Path $env:TEST_ROOT 'program-files'
[Environment]::SetEnvironmentVariable('ProgramFiles(x86)','')
$standard=Resolve-DshNodeRuntime
$env:ProgramFiles=''
$path=Resolve-DshNodeRuntime
[pscustomobject]@{explicit=$explicit;branded=$branded;brandedFilter=$brandedFilter;ordinary=$ordinary;ordinaryFilter=$ordinaryFilter;missing=$missing;standard=$standard;path=$path}|ConvertTo-Json -Compress
`)
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, TEST_ROOT: root, DSH_RUNTIME_HELPER: helper, REAL_NODE: process.execPath, DSH_HOME: root },
  }))
  assert.equal(result.explicit, node)
  assert.deepEqual(result.branded, [101, 102, 109])
  assert.equal(result.brandedFilter, 'Name = "DSH Host\'s.exe"')
  assert.deepEqual(result.ordinary, [201])
  assert.equal(result.ordinaryFilter, `Name = "${process.execPath.split(/[\\/]/).at(-1)}"`)
  assert.equal(result.missing, true)
  assert.equal(result.standard, standard)
  assert.equal(result.path, pathNode)
})

test('a standalone ensure copy without its helper fails before touching any Home or service', { skip: !windows }, async t => {
  const root = await fixture(t)
  const standalone = join(root, 'ensure-dsh-web.ps1')
  await copyFile(ensure, standalone)
  assert.throws(() => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', standalone], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_WEB_PORT: '15380' }, stdio: 'pipe',
  }), error => error.status !== 0 && error.stderr.includes('DSH Web runtime helpers are missing'))
  await assert.rejects(access(join(root, 'home')), { code: 'ENOENT' })
})

test('bootstrap retains only explicit runtime selection and quotes spaces and apostrophes in both launchers', { skip: !windows }, async t => {
  const root = await fixture(t)
  const node = join(root, "DSH Host's.exe")
  await writeFile(node, 'runtime fixture; never executed')
  await copyFile(helper, join(root, 'dsh-web-runtime.ps1'))
  const script = join(root, 'bootstrap-templates.ps1')
  await writeFile(script, `
$ErrorActionPreference='Stop'
$tokens=$null; $parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:BOOTSTRAP_SOURCE,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Bootstrap source contains syntax errors.' }
$statements=@($ast.EndBlock.Statements | Where-Object {
  $_.Extent.Text -match '^\\$(nodeSelection|template|startTemplate)\\s*=' -or
  ($_.GetType().Name -eq 'IfStatementAst' -and $_.Extent.Text -match '\\$env:DSH_NODE_BIN')
})
if ($statements.Count -ne 6) { throw ('Unexpected bootstrap template statement count: '+$statements.Count) }
$templateScript=Join-Path $env:TEST_ROOT 'template-expressions.ps1'
[IO.File]::WriteAllText($templateScript,($statements.Extent.Text -join "\n"))
$results=@(foreach ($selection in @($env:TEST_NODE,'',' ')) {
  $env:DSH_NODE_BIN=$selection
  $DshHome=Join-Path $env:TEST_ROOT 'home'
  $SourceRoot=Join-Path $env:TEST_ROOT 'source'
  $recoveryRoot=Join-Path $env:TEST_ROOT 'recovery'
  $DataRoot=Join-Path $env:TEST_ROOT 'data'
  . $templateScript
  $launchers=@(foreach ($rendered in @($template,$startTemplate)) {
    $renderTokens=$null; $renderErrors=$null
    $renderAst=[System.Management.Automation.Language.Parser]::ParseInput($rendered,[ref]$renderTokens,[ref]$renderErrors)
    if ($renderErrors.Count -ne 0) { throw 'Generated launcher contains syntax errors.' }
    $assignments=@($renderAst.FindAll({ param($item)
      $item -is [System.Management.Automation.Language.AssignmentStatementAst] -and $item.Left.Extent.Text -eq '$env:DSH_NODE_BIN'
    },$true))
    $env:DSH_NODE_BIN='roundtrip sentinel'
    foreach ($assignment in $assignments) { . ([scriptblock]::Create($assignment.Extent.Text)) }
    [pscustomobject]@{count=$assignments.Count;runtime=$env:DSH_NODE_BIN;unresolved=$rendered.Contains('__NODE_SELECTION__');literal=@($assignments|ForEach-Object {$_.Extent.Text})}
  })
  [pscustomobject]@{selection=$selection;launchers=$launchers}
})
$results|ConvertTo-Json -Depth 5 -Compress
`)
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, TEST_ROOT: root, TEST_NODE: node, BOOTSTRAP_SOURCE: bootstrap, DSH_HOME: root },
  }))
  assert.equal(result.length, 3)
  for (const launcher of result[0].launchers) {
    assert.equal(launcher.count, 1)
    assert.equal(launcher.runtime, node)
    assert.equal(launcher.literal[0], `$env:DSH_NODE_BIN = '${node.replaceAll("'", "''")}'`)
    assert.equal(launcher.unresolved, false)
  }
  for (const state of result.slice(1)) {
    for (const launcher of state.launchers) {
      assert.equal(launcher.count, 0)
      assert.equal(launcher.runtime, 'roundtrip sentinel')
      assert.equal(launcher.unresolved, false)
    }
  }
})

test('real Windows process queries identify an ordinary and renamed Node without starting a Web service', { skip: !windows }, async t => {
  const root = await fixture(t)
  const branded = join(root, 'DSH identity probe.exe')
  const entry = join(root, 'apps', 'cli', 'src', 'bin.ts')
  await copyFile(process.execPath, branded)
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, "process.stdin.resume(); process.stdin.on('end', () => process.exitCode=0); process.stdout.write('ready\\n')\n")
  const children = []
  try {
    for (const executable of [process.execPath, branded]) {
      const child = childProcess.spawn(executable, ['--import', 'data:text/javascript,', entry, 'web', '--port', '15380'], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DSH_HOME: root, HOME: root, USERPROFILE: root, NODE_OPTIONS: '' },
      })
      children.push(child)
      await new Promise((resolveReady, reject) => {
        child.once('error', reject)
        child.once('exit', code => reject(new Error(`Identity probe exited before readiness: ${code}`)))
        child.stdout.once('data', () => resolveReady())
      })
    }
    const script = join(root, 'process-probe.ps1')
    await writeFile(script, `
$ErrorActionPreference='Stop'
. $env:DSH_RUNTIME_HELPER
[pscustomobject]@{
 ordinary=@(Get-DshWebHostProcesses -NodePath $env:REAL_NODE -Port 15380|ForEach-Object ProcessId)
 branded=@(Get-DshWebHostProcesses -NodePath $env:BRANDED_NODE -Port 15380|ForEach-Object ProcessId)
}|ConvertTo-Json -Compress
`)
    const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, encoding: 'utf8', env: { ...process.env, DSH_RUNTIME_HELPER: helper, REAL_NODE: process.execPath, BRANDED_NODE: branded, DSH_HOME: root },
    }))
    assert.ok(result.ordinary.includes(children[0].pid))
    assert.deepEqual(result.branded, [children[1].pid])
  } finally {
    await Promise.all(children.map(child => new Promise((resolveClosed, reject) => {
      if (child.exitCode !== null) { resolveClosed(); return }
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolveClosed() : reject(new Error(`Identity probe exit: ${code}`)))
      child.stdin.end()
    })))
  }
})

test('restart recovery copies both scripts and missing helpers fail before launch', { skip: !windows }, async t => {
  const root = await fixture(t)
  const home = join(root, 'home')
  const source = join(root, 'source')
  const installedScripts = join(home, 'profiles', 'web', 'node_modules', 'dsh-environment-sync', 'scripts')
  await mkdir(join(source, 'apps', 'cli', 'src'), { recursive: true })
  await writeFile(join(source, 'apps', 'cli', 'src', 'bin.ts'), '')
  await mkdir(installedScripts, { recursive: true })
  await writeFile(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: {} }))
  await copyFile(ensure, join(installedScripts, 'ensure-dsh-web.ps1'))
  const previousSource = process.env.DSH_SOURCE_ROOT
  process.env.DSH_SOURCE_ROOT = source
  const calls = []
  const previousSpawn = childProcess.spawn
  childProcess.spawn = (...args) => {
    calls.push(args)
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('close', 0))
    return child
  }
  syncBuiltinESMExports()
  try {
    const ctx = new Context()
    ctx.provide('profileContext', { name: 'web', home })
    const manager = new PrivatePluginManager(ctx)
    await assert.rejects(manager.restartEnvironment(), error => error.code === 'ENOENT' && error.path.endsWith('dsh-web-runtime.ps1'))
    assert.equal(calls.length, 0)
    await assert.rejects(access(join(home, 'recovery-runtime')), { code: 'ENOENT' })
    await copyFile(helper, join(installedScripts, 'dsh-web-runtime.ps1'))
    await manager.restartEnvironment()
    assert.equal(calls.length, 1)
    assert.equal(await readFile(join(home, 'recovery-runtime', 'restart-dsh-web.ps1'), 'utf8'), await readFile(ensure, 'utf8'))
    assert.equal(await readFile(join(home, 'recovery-runtime', 'dsh-web-runtime.ps1'), 'utf8'), await readFile(helper, 'utf8'))
    assert.equal(calls[0][2].env.DSH_HOME, home)
  } finally {
    childProcess.spawn = previousSpawn
    syncBuiltinESMExports()
    if (previousSource === undefined) delete process.env.DSH_SOURCE_ROOT
    else process.env.DSH_SOURCE_ROOT = previousSource
  }
})
