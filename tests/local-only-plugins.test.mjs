import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse, stringify } from 'yaml'
import { readMachineLocalSettings } from '../lib/local-only-plugins.js'
import { exportPrivateEnvironment, importPrivateEnvironment } from '../scripts/private-environment-sync.mjs'
import { prepareThirdPartyPlugins, exportThirdPartyPlugins, syncThirdPartyPlugins, inspectThirdPartyPlugins, PLUGIN_BASELINE_FILENAME } from '../scripts/sync-third-party-plugins.mjs'

const local = { name: 'fixture-local', entryIds: ['fixture-private-entry'] }
const secret = 'synthetic-local-plugin-sync-key'
async function write(path, value) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value) }
const json = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n')
async function plugin(profile, name, version) {
  await json(join(profile, 'node_modules', name, 'package.json'), { name, version, type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } })
  await write(join(profile, 'node_modules', name, 'index.js'), 'export {}\n')
}
async function fixture(root, declared = true) {
  const home = join(root, 'home'), profile = join(home, 'profiles/web'), data = join(root, 'data')
  await json(join(profile, 'package.json'), { name: 'fixture-profile', private: true, dependencies: { 'fixture-local': 'link:./owned-local', 'fixture-shared': '1.0.0' }, dsh: { profile: { bundles: ['fixture-local', 'fixture-shared'] } } })
  await plugin(profile, 'fixture-local', '1.0.0'); await plugin(profile, 'fixture-shared', '1.0.0')
  await write(join(profile, 'cordis.patch.yml'), stringify([{ id: local.entryIds[0], config: { privateValue: 'machine-only' }, disabled: true }, { id: 'shared-setting', config: { language: 'en' } }, { id: 'webserver', config: { port: 0 } }]))
  await write(join(home, 'cordis.patch.yml'), stringify([{ name: 'fixture-local', config: { homeSecret: 'machine-home-only' } }, { insert: [{ id: local.entryIds[0], name: 'fixture-local/child' }] }]))
  await write(join(home, 'private-sync.local.yaml'), stringify({ ...(declared ? { localOnlyPlugins: [local] } : {}), 'shared-setting': { localPath: 'machine-setting-only' } }))
  return { home, profile, data }
}

test('one declaration excludes package, bundle, settings and both patches; import preserves local values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-only-'))
  try {
    const { home, profile, data } = await fixture(root)
    const exported = await exportPrivateEnvironment({ dshHomePath: home, dataRootPath: data, encryptionSecret: secret })
    const plugins = exportThirdPartyPlugins({ profileDir: profile, repositoryPath: data })
    assert.deepEqual(plugins.plugins.map(p => p.name), ['fixture-shared'])
    assert.deepEqual(exported.manifest.dependencies.map(p => p.name), ['fixture-shared'])
    assert.deepEqual(exported.manifest.bundles, ['fixture-shared'])
    for (const name of ['settings.yaml', 'cordis.patch.yml', 'profiles/web/cordis.patch.yml', 'environment.json', 'config/plugins.json']) {
      const text = await readFile(join(data, name), 'utf8')
      assert.doesNotMatch(text, /machine-only|machine-home-only|machine-setting-only|localOnlyPlugins|fixture-local|fixture-private-entry/)
    }
    await write(join(data, 'settings.yaml'), 'shared-setting:\n  language: zh\nlocalOnlyPlugins:\n  - name: fixture-shared\n    entryIds: [shared-setting]\nfixture-private-entry:\n  privateValue: incoming-wrong\n')
    await write(join(data, 'cordis.patch.yml'), '- name: fixture-local\n  config:\n    homeSecret: incoming-wrong\n')
    await write(join(data, 'profiles/web/cordis.patch.yml'), '- id: fixture-private-entry\n  config:\n    privateValue: incoming-wrong\n- id: shared-setting\n  config:\n    language: zh\n')
    await importPrivateEnvironment({ dshHomePath: home, dataRootPath: data, encryptionSecret: secret })
    const patch = parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'))
    assert.equal(patch.find(p => p.id === local.entryIds[0]).config.privateValue, 'machine-only')
    assert.equal(patch.find(p => p.id === local.entryIds[0]).disabled, true)
    assert.equal(patch.find(p => p.id === 'shared-setting').config.language, 'zh')
    assert.equal(patch.find(p => p.id === 'shared-setting').config.localPath, 'machine-setting-only')
    assert.equal(patch.some(p => p.id === 'localOnlyPlugins'), false)
    assert.match(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), /machine-home-only/)
    assert.deepEqual(readMachineLocalSettings(home).plugins, [local])
    await write(join(home, 'private-sync.local.yaml'), '')
    assert.deepEqual(readMachineLocalSettings(home).plugins, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('undeclared local packages and malformed declarations still reject', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-only-invalid-'))
  try {
    const { home, profile, data } = await fixture(root, false)
    assert.throws(() => prepareThirdPartyPlugins({ profileDir: profile }), /local-only specifier/)
    await assert.rejects(exportPrivateEnvironment({ dshHomePath: home, dataRootPath: data, encryptionSecret: secret }), /local-only dependency/)
    for (const value of [{}, ['fixture-local'], [{ name: '../escape', entryIds: [] }], [{ name: '@deepseek-ai/dsh-base', entryIds: [] }], [{ name: 'fixture-local', entryIds: 'wrong' }]]) {
      await write(join(home, 'private-sync.local.yaml'), stringify({ localOnlyPlugins: value }))
      assert.throws(() => readMachineLocalSettings(home), /localOnlyPlugins/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

function installer(profile, calls, failInstall = false) {
  let failed = false
  return (command, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    calls.push([...args])
    queueMicrotask(async () => {
      try {
        if (failInstall && args.includes('--frozen-lockfile') && !failed) { failed = true; child.emit('close', 1); return }
        if (args.includes('add')) {
          const specifier = args.at(-1), split = specifier.lastIndexOf('@'), name = specifier.slice(0, split), version = specifier.slice(split + 1)
          const p = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')); p.dependencies[name] = version
          await json(join(profile, 'package.json'), p); await plugin(profile, name, version)
        }
        child.emit('close', 0)
      } catch (error) { child.emit('error', error) }
    })
    return child
  }
}

for (const remoteContainsLocal of [false, true]) test(`real update retains local dependency/bundle despite old baseline or remote record (${remoteContainsLocal})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-only-update-'))
  try {
    const { home, profile, data } = await fixture(root), source = join(root, 'source'), calls = []
    await write(join(source, 'apps/cli/src/bin.ts'), '')
    const shared = { name: 'fixture-shared', version: '2.0.0', specifier: 'fixture-shared@2.0.0' }, priorLocal = { name: 'fixture-local', version: '1.0.0', specifier: 'fixture-local@1.0.0' }
    await json(join(profile, PLUGIN_BASELINE_FILENAME), { schemaVersion: 3, profile: 'web', plugins: [priorLocal] })
    await json(join(data, 'config/plugins.json'), { schemaVersion: 3, profile: 'web', plugins: [...(remoteContainsLocal ? [priorLocal] : []), shared] })
    const result = await syncThirdPartyPlugins({ profileDir: profile, repositoryPath: data, sourceRoot: source, spawnCommand: installer(profile, calls) })
    const visible = inspectThirdPartyPlugins({ profileDir: profile, repositoryPath: data })
    assert.equal(visible.plugins.some(p => p.name === 'fixture-local'), false)
    assert.equal(visible.extra.some(p => p.name === 'fixture-local'), true)
    assert.ok(result.commands.some(c => c.action === 'install'))
    assert.ok(calls.some(args => args.includes('--frozen-lockfile')))
    assert.ok(calls.every(args => !args.includes('fixture-local') && !args.some(a => a === 'fixture-local@1.0.0')))
    const p = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.equal(p.dependencies['fixture-local'], 'link:./owned-local')
    assert.equal(p.dependencies['fixture-shared'], '2.0.0')
    assert.ok(p.dsh.profile.bundles.includes('fixture-local'))
    assert.equal(JSON.parse(await readFile(join(profile, PLUGIN_BASELINE_FILENAME), 'utf8')).plugins.some(p => p.name === 'fixture-local'), false)
    assert.equal((await syncThirdPartyPlugins({ profileDir: profile, repositoryPath: data, sourceRoot: source, spawnCommand: installer(profile, calls) })).commands.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failed frozen installation restores original local profile and patch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-only-rollback-'))
  try {
    const { profile, data } = await fixture(root), source = join(root, 'source'), calls = []
    await write(join(source, 'apps/cli/src/bin.ts'), '')
    await json(join(data, 'config/plugins.json'), { schemaVersion: 3, profile: 'web', plugins: [{ name: 'fixture-shared', version: '2.0.0', specifier: 'fixture-shared@2.0.0' }] })
    const names = ['package.json', 'cordis.patch.yml'], before = await Promise.all(names.map(name => readFile(join(profile, name), 'utf8')))
    await assert.rejects(syncThirdPartyPlugins({ profileDir: profile, repositoryPath: data, sourceRoot: source, spawnCommand: installer(profile, calls, true) }), /应用插件锁文件失败/)
    assert.deepEqual(await Promise.all(names.map(name => readFile(join(profile, name), 'utf8'))), before)
    assert.equal(JSON.parse(await readFile(join(profile, '.dsh-plugin-operation.json'), 'utf8')).state, 'restored')
  } finally { await rm(root, { recursive: true, force: true }) }
})
