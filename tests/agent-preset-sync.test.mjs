import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { exportPrivateEnvironment, importPrivateEnvironment } from '../scripts/private-environment-sync.mjs'

async function write(path, contents) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents)
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-sync-'))
  const source = join(root, 'source'), target = join(root, 'target'), data = join(root, 'data')
  const options = { dshHomePath: source, dataRootPath: data, encryptionSecret: 'fixture-key' }
  try {
    await write(join(source, 'settings.yaml'), 'agent-presets:\n  default: coordinator\n')
    await write(join(source, 'profiles/web/package.json'), '{}')
    await write(join(source, '.agent-presets/coordinator/agent.cordis.yml'), '- id: persona\n  name: example-persona\n')
    await write(join(source, '.agent-presets/coordinator/preset.yml'), 'name: 协调模式\norder: 50\n')
    await run({ root, source, target, data, options })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('custom presets, skills and binary assets round-trip; deletions retain unrelated target presets', () => fixture(async ({ source, target, data, options }) => {
  const binary = Buffer.from([0, 255, 128, 10, 0])
  await write(join(source, '.agent-presets/coordinator/assets/图标.bin'), binary)
  await write(join(source, '.agent-presets/coordinator/skills/helper/SKILL.md'), '# Helper\n')
  await write(join(target, '.agent-presets/local-only/agent.cordis.yml'), '[]\n')
  const first = await exportPrivateEnvironment(options)
  await importPrivateEnvironment({ ...options, dshHomePath: target })
  assert.deepEqual(await readFile(join(target, '.agent-presets/coordinator/assets/图标.bin')), binary)
  assert.equal(await readFile(join(target, '.agent-presets/coordinator/preset.yml'), 'utf8'), 'name: 协调模式\norder: 50\n')
  assert.equal(await readFile(join(target, '.agent-presets/coordinator/skills/helper/SKILL.md'), 'utf8'), '# Helper\n')
  assert.equal((await readFile(join(target, 'settings.yaml'), 'utf8')).includes('coordinator'), true)
  const second = await exportPrivateEnvironment(options)
  assert.deepEqual(first.manifest, second.manifest)
  await rm(join(source, '.agent-presets/coordinator'), { recursive: true })
  const removed = await exportPrivateEnvironment(options)
  assert.equal(removed.manifest.agentPresets.files.length, 0)
  assert.equal(removed.manifest.agentPresets.deleted.length, 4)
  await importPrivateEnvironment({ ...options, dshHomePath: target })
  await assert.rejects(readFile(join(target, '.agent-presets/coordinator/agent.cordis.yml')), { code: 'ENOENT' })
  assert.equal(await readFile(join(target, '.agent-presets/local-only/agent.cordis.yml'), 'utf8'), '[]\n')
  await assert.rejects(readFile(join(data, '.agent-presets/coordinator/assets/图标.bin')), { code: 'ENOENT' })
}))

test('legacy snapshots leave local user presets intact', () => fixture(async ({ target, data, options }) => {
  await exportPrivateEnvironment(options)
  const manifestPath = join(data, 'environment.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  delete manifest.agentPresets
  await write(manifestPath, JSON.stringify(manifest))
  await write(join(target, '.agent-presets/local-only/agent.cordis.yml'), '[]\n')
  const result = await importPrivateEnvironment({ ...options, dshHomePath: target })
  assert.equal(result.imported.agentPresets, false)
  assert.equal(await readFile(join(target, '.agent-presets/local-only/agent.cordis.yml'), 'utf8'), '[]\n')
  await assert.rejects(readFile(join(target, '.agent-presets/coordinator/agent.cordis.yml')), { code: 'ENOENT' })
}))

test('an existing computer upgrading its manager retains remote presets until first application', () => fixture(async ({ target, data, options }) => {
  await exportPrivateEnvironment(options)
  await write(join(target, 'settings.yaml'), 'agent-presets:\n  default: local-only\n')
  await write(join(target, 'profiles/web/package.json'), '{}')
  await write(join(target, '.agent-presets/local-only/agent.cordis.yml'), '[]\n')
  const targetOptions = { ...options, dshHomePath: target }
  const exported = await exportPrivateEnvironment(targetOptions)
  assert.equal(exported.manifest.agentPresets.deleted.length, 0)
  assert.equal(exported.manifest.agentPresets.files.length, 3)
  await importPrivateEnvironment(targetOptions)
  assert.equal(await readFile(join(target, '.agent-presets/coordinator/preset.yml'), 'utf8'), 'name: 协调模式\norder: 50\n')
  await rm(join(target, '.agent-presets/coordinator'), { recursive: true })
  const removed = await exportPrivateEnvironment(targetOptions)
  assert.equal(removed.manifest.agentPresets.deleted.length, 2)
  assert.equal(removed.manifest.agentPresets.files.length, 1)
}))

test('missing assets, invalid YAML and escaped manifest paths fail before changing Home', () => fixture(async ({ target, data, options }) => {
  await exportPrivateEnvironment(options)
  await write(join(target, 'settings.yaml'), 'theme: local\n')
  const path = join(data, '.agent-presets/coordinator/agent.cordis.yml')
  await rm(path)
  await assert.rejects(importPrivateEnvironment({ ...options, dshHomePath: target }), { code: 'ENOENT' })
  await write(path, '- [\n')
  await assert.rejects(importPrivateEnvironment({ ...options, dshHomePath: target }), /Invalid agent preset YAML/)
  await write(path, '[]\n')
  const manifestPath = join(data, 'environment.json')
  const original = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const badPath of ['.agent-presets/coordinator/../../settings.yaml', '.agent-presets/coordinator/private-sync.key', '.agent-presets/coordinator/CON', '.agent-presets/coordinator/asset:stream', '.agent-presets/coordinator/logs/transcript']) {
    const manifest = structuredClone(original)
    manifest.agentPresets.deleted.push(badPath)
    await write(manifestPath, JSON.stringify(manifest))
    await assert.rejects(importPrivateEnvironment({ ...options, dshHomePath: target }), /Invalid agent preset inventory/)
    assert.equal(await readFile(join(target, 'settings.yaml'), 'utf8'), 'theme: local\n')
  }
}))

test('linked preset roots cannot read or overwrite unrelated files', () => fixture(async ({ root, source, target, data, options }) => {
  await exportPrivateEnvironment(options)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await mkdir(target)
  await symlink(outside, join(target, '.agent-presets'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(importPrivateEnvironment({ ...options, dshHomePath: target }), /cannot use links/)
  await rm(join(source, '.agent-presets'), { recursive: true })
  await symlink(outside, join(source, '.agent-presets'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(exportPrivateEnvironment(options), /cannot use links/)
  assert.equal((await readFile(join(data, 'environment.json'), 'utf8')).includes('coordinator'), true)
}))
