import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse, stringify } from 'yaml'
import { exportPrivateEnvironment, importPrivateEnvironment } from '../scripts/private-environment-sync.mjs'
import { environmentState, synchronizeEnvironment } from '../lib/environment-workflow.js'

const secret = 'synthetic-overlay-baseline-key'
const shared = {
  waimai: { dryRun: false, autoTasks: [], title: 'shared' },
  'rabiroute-agent': { localAgentUnrestricted: true, enforceAgentCommunication: false },
  'provider-visibility': { modelSync: { targets: [{ settingsNs: 'fixture', provider: 'fixture' }], intervalMs: 300000, timeoutMs: 10000 } },
  'llm-fixture': { apiKeyEnv: 'FIXTURE_API_KEY' },
}
const overlay = {
  waimai: { dryRun: true, autoTasks: [] },
  'rabiroute-agent': { localAgentUnrestricted: false, enforceAgentCommunication: true },
  'provider-visibility': { modelSync: { targets: [] } },
  'llm-fixture': { apiKeyEnv: 'LOCAL_FIXTURE_API_KEY' },
}
const current = {
  waimai: { dryRun: true, autoTasks: [], title: 'local-portable-change' },
  'rabiroute-agent': { localAgentUnrestricted: false, enforceAgentCommunication: true },
  'provider-visibility': { modelSync: { targets: [], intervalMs: 300000, timeoutMs: 10000 } },
  'llm-fixture': { apiKeyEnv: 'LOCAL_FIXTURE_API_KEY' },
}
async function write(path, value) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value) }
async function homeSettings(home, settings, profileConfig) {
  await write(join(home, 'profiles/web/package.json'), '{}')
  if (profileConfig) await write(join(home, 'profiles/web/cordis.patch.yml'), stringify(Object.entries(settings).map(([id, config]) => ({ id, name: 'fixture-plugin', config }))))
  else await write(join(home, 'settings.yaml'), stringify(settings))
}

for (const profileConfig of [false, true]) test(`export preserves masked shared values and exports unmasked changes (${profileConfig})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-baseline-'))
  const home = join(root, 'home'), before = join(root, 'before'), data = join(root, 'data')
  try {
    await homeSettings(before, { ...shared, deleted: { value: 'old' } }, profileConfig)
    await exportPrivateEnvironment({ dshHomePath: before, dataRootPath: data, encryptionSecret: secret })
    await homeSettings(home, current, profileConfig)
    await write(join(home, 'private-sync.local.yaml'), stringify(overlay))
    const options = { dshHomePath: home, dataRootPath: data, encryptionSecret: secret }
    const result = await exportPrivateEnvironment(options)
    const expected = { ...shared, waimai: { ...shared.waimai, title: 'local-portable-change' } }
    assert.deepEqual(parse(await readFile(join(data, 'settings.yaml'), 'utf8')), expected)
    assert.deepEqual(result.manifest.settingsNamespaces, Object.keys(expected).sort())
    if (profileConfig) {
      const rows = parse(await readFile(join(data, 'profiles/web/cordis.patch.yml'), 'utf8'))
      assert.deepEqual(Object.fromEntries(rows.map(row => [row.id, row.config])), expected)
    }
    const first = await readFile(join(data, 'settings.yaml'), 'utf8')
    await exportPrivateEnvironment(options)
    assert.equal(await readFile(join(data, 'settings.yaml'), 'utf8'), first)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('initial export does not share local overrides or adopt an unowned old settings file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-initial-'))
  const home = join(root, 'home'), data = join(root, 'data')
  try {
    await homeSettings(home, current, false)
    await write(join(home, 'private-sync.local.yaml'), stringify(overlay))
    await write(join(data, 'settings.yaml'), stringify(shared))
    await exportPrivateEnvironment({ dshHomePath: home, dataRootPath: data, encryptionSecret: secret })
    assert.deepEqual(parse(await readFile(join(data, 'settings.yaml'), 'utf8')), {
      waimai: { title: 'local-portable-change' },
      'provider-visibility': { modelSync: { intervalMs: 300000, timeoutMs: 10000 } },
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('old masked machine paths, device URLs, credentials and local-only entries stay excluded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-unsafe-'))
  const home = join(root, 'home'), data = join(root, 'data')
  try {
    await homeSettings(home, {}, false)
    await exportPrivateEnvironment({ dshHomePath: home, dataRootPath: data, encryptionSecret: secret })
    const unsafe = {
      'nas-workspace-support': { enabled: true },
      'emotional-chat-workbench': { enabled: true },
      'rabi-default-persona': { managerBaseUrl: 'https://device.example' },
      localOnlyPlugins: [{ name: 'remote-local', entryIds: [] }],
      'local-entry': { enabled: true },
      'fixture-local': { enabled: true },
      fixture: { path: 'fixture-relative', other: 'X:/fixture-only', relative: '../fixture-only', device: 'http://127.0.0.1:1', deviceName: 'http://fixture-device.local', apiKey: 'synthetic-not-a-real-key', accessToken: 'synthetic-token', targets: [{ provider: 'fixture', root: 'fixture-relative' }], apiKeyEnv: 'FIXTURE_API_KEY', model: 'fixture/model', enabled: false, nullable: null },
    }
    await write(join(data, 'settings.yaml'), stringify(unsafe))
    await write(join(home, 'settings.yaml'), stringify(unsafe))
    await write(join(home, 'private-sync.local.yaml'), stringify({ ...unsafe, localOnlyPlugins: [{ name: 'fixture-local', entryIds: ['local-entry'] }] }))
    await exportPrivateEnvironment({ dshHomePath: home, dataRootPath: data, encryptionSecret: secret })
    assert.deepEqual(parse(await readFile(join(data, 'settings.yaml'), 'utf8')), { fixture: { apiKeyEnv: 'FIXTURE_API_KEY', model: 'fixture/model', enabled: false, nullable: null } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('invalid previous snapshot fails before changing shared files or the Home preset baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-invalid-'))
  const home = join(root, 'home'), data = join(root, 'data')
  try {
    await homeSettings(home, current, false)
    const options = { dshHomePath: home, dataRootPath: data, encryptionSecret: secret }
    await exportPrivateEnvironment(options)
    const baseline = join(home, '.dsh-agent-presets-sync-baseline.json')
    const before = await readFile(baseline, 'utf8')
    await write(join(data, 'settings.yaml'), '[invalid, previous, mapping]\n')
    await assert.rejects(exportPrivateEnvironment(options), /Previous shared DSH settings/)
    assert.equal(await readFile(baseline, 'utf8'), before)
    assert.equal(await readFile(join(data, 'settings.yaml'), 'utf8'), '[invalid, previous, mapping]\n')
    const manifest = JSON.parse(await readFile(join(data, 'environment.json'), 'utf8'))
    await write(join(data, 'environment.json'), JSON.stringify({ ...manifest, profile: 'headless' }))
    await assert.rejects(exportPrivateEnvironment(options), /Previous shared environment manifest/)
    assert.equal(await readFile(baseline, 'utf8'), before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const profileConfig of [false, true]) test(`receive then publish preserves the other machine's masked values through real Git (${profileConfig})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-roundtrip-'))
  const remote = join(root, 'remote.git'), a = join(root, 'a'), b = join(root, 'b'), homeA = join(root, 'home-a'), homeB = join(root, 'home-b')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    await mkdir(remote)
    git(remote, 'init', '--bare', '--initial-branch=main')
    git(root, 'clone', '--config', 'core.autocrlf=false', remote, a)
    const base = { ...shared, 'provider-visibility': { visible: true }, 'ui-fixture': { preference: 'base' } }
    await homeSettings(homeA, base, profileConfig)
    await exportPrivateEnvironment({ dshHomePath: homeA, dataRootPath: a, encryptionSecret: secret })
    git(a, 'add', '.')
    git(a, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'Initial shared fixture')
    git(a, 'push', '-u', 'origin', 'main')
    git(root, 'clone', '--config', 'core.autocrlf=false', remote, b)
    await homeSettings(homeB, current, profileConfig)
    await write(join(homeB, 'private-sync.local.yaml'), stringify(overlay))
    let failApply = false
    const run = (home, repository, upload) => synchronizeEnvironment({ home, repository, profile: 'web', upload,
      exportSnapshot: () => exportPrivateEnvironment({ dshHomePath: home, dataRootPath: repository, encryptionSecret: secret }),
      applySnapshot: () => {
        if (failApply && home === homeB) throw new Error('Synthetic apply failure')
        return importPrivateEnvironment({ dshHomePath: home, dataRootPath: repository, encryptionSecret: secret })
      },
    })
    await run(homeB, b, false)
    await homeSettings(homeA, { ...base, 'provider-visibility': { visible: true, ...shared['provider-visibility'] } }, profileConfig)
    await run(homeA, a, true)
    if (profileConfig) {
      const rows = parse(await readFile(join(homeB, 'profiles/web/cordis.patch.yml'), 'utf8'))
      rows.find(row => row.id === 'ui-fixture').config.preference = 'portable-from-b'
      await write(join(homeB, 'profiles/web/cordis.patch.yml'), stringify(rows))
    } else {
      const settings = parse(await readFile(join(homeB, 'settings.yaml'), 'utf8'))
      settings['ui-fixture'].preference = 'portable-from-b'
      await write(join(homeB, 'settings.yaml'), stringify(settings))
    }
    failApply = true
    await assert.rejects(run(homeB, b, false), /Synthetic apply failure/)
    assert.equal(environmentState(homeB, 'web').phase, 'applying')
    failApply = false
    await run(homeB, b, false)
    const local = profileConfig ? Object.fromEntries(parse(await readFile(join(homeB, 'profiles/web/cordis.patch.yml'), 'utf8')).map(row => [row.id, row.config])) : parse(await readFile(join(homeB, 'settings.yaml'), 'utf8'))
    assert.equal(local.waimai.dryRun, true)
    assert.equal(local['rabiroute-agent'].localAgentUnrestricted, false)
    assert.deepEqual(local['provider-visibility'].modelSync.targets, [])
    await run(homeB, b, true)
    const published = parse(git(remote, 'show', 'main:settings.yaml'))
    assert.equal(published.waimai.dryRun, false)
    assert.equal(published['rabiroute-agent'].localAgentUnrestricted, true)
    assert.deepEqual(published['provider-visibility'].modelSync.targets, shared['provider-visibility'].modelSync.targets)
    assert.equal(published['ui-fixture'].preference, 'portable-from-b')
    if (profileConfig) {
      const patch = parse(git(remote, 'show', 'main:profiles/web/cordis.patch.yml'))
      assert.deepEqual(Object.fromEntries(patch.map(row => [row.id, row.config])), published)
    }
    const head = git(b, 'rev-parse', 'HEAD')
    await run(homeB, b, true)
    assert.equal(git(b, 'rev-parse', 'HEAD'), head)
    assert.equal(git(remote, 'rev-parse', 'main'), head)
    assert.equal(environmentState(homeB, 'web').appliedCommit, head)
    assert.equal(environmentState(homeB, 'web').phase, 'ready')
  } finally { await rm(root, { recursive: true, force: true }) }
})
