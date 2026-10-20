import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportThirdPartyPlugins, readThirdPartyManifest, syncThirdPartyPlugins } from '../scripts/sync-third-party-plugins.mjs'

const commit = 'a'.repeat(40)

async function fixture(operation) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subdirectory-'))
  const profileDir = join(root, 'profile'), repositoryPath = join(root, 'repository')
  await mkdir(join(repositoryPath, 'config'), { recursive: true })
  await mkdir(profileDir)
  const manifestPath = join(repositoryPath, 'config/plugins.json')
  const writeManifest = specifier => writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, plugins: [{ name: 'ds-bot', version: '1.0.0', specifier }] }))
  try { await operation({ root, profileDir, repositoryPath, manifestPath, writeManifest }) }
  finally { await rm(root, { recursive: true, force: true }) }
}

for (const source of ['github:owner/bot', 'git+https://github.com/owner/bot.git']) {
  test(`exports and synchronizes an unchanged subdirectory package: ${source}`, () => fixture(async ({ profileDir, repositoryPath, manifestPath }) => {
    const specifier = `${source}#${commit}&path:packages/ds-bot`
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'ds-bot': specifier } }))
    await mkdir(join(profileDir, 'node_modules/ds-bot'), { recursive: true })
    await writeFile(join(profileDir, 'node_modules/ds-bot/package.json'), JSON.stringify({ name: 'ds-bot', version: '1.0.0', author: 'Original Author', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    const exported = exportThirdPartyPlugins({ profileDir, repositoryPath })
    assert.equal(exported.plugins[0].specifier, specifier)
    assert.equal(exported.plugins[0].author, 'Original Author')
    assert.equal(readThirdPartyManifest(manifestPath).plugins[0].repositoryOwner, 'owner')
    const result = await syncThirdPartyPlugins({ profileDir, repositoryPath, spawnCommand() { throw new Error('Unchanged plugins must not run an installer') } })
    assert.deepEqual(result.commands, [])
    assert.equal(result.restartRequired, false)
  }))
}

for (const packageName of ['wrong-package', 'ds-bot']) {
test(`preflight reads the selected package at the pinned commit: ${packageName}`, () => fixture(async ({ profileDir, repositoryPath, writeManifest }) => {
  await writeFile(join(profileDir, 'package.json'), '{"dependencies":{}}\n')
  await writeManifest(`github:owner/bot#${commit}&path:packages/ds-bot`)
  const commands = []
  const before = await readFile(join(profileDir, 'package.json'), 'utf8')
  const specifier = `github:owner/bot#${commit}&path:packages/ds-bot`
  let installed = false
  const operation = syncThirdPartyPlugins({ profileDir, repositoryPath, profile: 'desktop', desktopManager: {
    async installBundle(requested) {
      assert.equal(requested, specifier)
      installed = true
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'ds-bot': specifier } }))
      await mkdir(join(profileDir, 'node_modules/ds-bot'), { recursive: true })
      await writeFile(join(profileDir, 'node_modules/ds-bot/package.json'), JSON.stringify({ name: 'ds-bot', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      return { application: 'restart-required', bundle: 'ds-bot' }
    },
    async removeBundle() { throw new Error('Unexpected removal') },
  }, spawnCommand(command, args, options) {
    commands.push({ command, args })
    assert.equal(options.shell, false)
    assert.equal(command, 'git')
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      if (args.includes('show')) child.stdout.emit('data', JSON.stringify({ name: packageName, version: '1.0.0' }))
      child.emit('close', 0, null)
    })
    return child
  } })
  if (packageName === 'wrong-package') await assert.rejects(operation, /名称或版本与 Git 提交不符/)
  else assert.equal((await operation).restartRequired, true)
  assert.equal(commands.find(item => item.args.includes('remote.origin.url')).args.at(-1), 'https://github.com/owner/bot.git')
  const fetch = commands.find(item => item.args.includes('fetch'))
  assert.equal(fetch.args.at(-1), commit)
  assert.equal(fetch.args.at(-2), 'origin')
  assert.equal(fetch.args.includes('--filter=blob:none'), true)
  assert.equal(commands.find(item => item.args.includes('show')).args.at(-1), `${commit}:packages/ds-bot/package.json`)
  assert.equal(installed, packageName === 'ds-bot')
  if (!installed) assert.equal(await readFile(join(profileDir, 'package.json'), 'utf8'), before)
}))
}

for (const suffix of ['', '.', '..', '../ds-bot', 'packages/../ds-bot', '/ds-bot', 'C:/ds-bot', 'packages\\ds-bot', '%2e%2e/ds-bot', 'ds-bot&path:other', 'ds-bot&foo:bar', 'ds-bot#other']) {
  test(`rejects unsafe subdirectory before spawning: ${JSON.stringify(suffix)}`, () => fixture(async ({ profileDir, repositoryPath, writeManifest }) => {
    await writeFile(join(profileDir, 'package.json'), '{"dependencies":{}}\n')
    await writeManifest(`github:owner/bot#${commit}&path:${suffix}`)
    await assert.rejects(syncThirdPartyPlugins({ profileDir, repositoryPath, spawnCommand() { throw new Error('Invalid path reached process execution') } }), /40-character commit/)
    assert.equal(await readFile(join(profileDir, 'package.json'), 'utf8'), '{"dependencies":{}}\n')
  }))
}
