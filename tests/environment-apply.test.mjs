import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyEnvironment } from '../lib/environment-apply.js'
import { exportPrivateEnvironment } from '../scripts/private-environment-sync.mjs'
import { exportThirdPartyPlugins } from '../scripts/sync-third-party-plugins.mjs'

test('environment and nested plugin locks release independently across repeated applications', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-lock-'))
  const home = join(root, 'home'), repository = join(root, 'data'), profileDir = join(home, 'profiles/web')
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
    writeFileSync(join(home, 'settings.yaml'), 'theme: blue\n')
    const options = { dshHomePath: home, dataRootPath: repository, encryptionSecret: 'fixture-acceptance-key' }
    await exportPrivateEnvironment(options)
    exportThirdPartyPlugins({ profileDir, repositoryPath: repository })
    for (let index = 0; index < 2; index++) {
      await applyEnvironment(options)
      assert.equal(JSON.parse(readFileSync(join(profileDir, '.dsh-environment-restore.json'))).state, 'succeeded')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('failed verification restores preset definitions, deleted binary assets and settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-preset-rollback-'))
  const home = join(root, 'home'), source = join(root, 'source'), repository = join(root, 'data')
  const options = { dshHomePath: home, dataRootPath: repository, encryptionSecret: 'fixture-key' }
  const original = Buffer.from([255, 0, 128, 1])
  try {
    for (const directory of [home, source]) {
      mkdirSync(join(directory, 'profiles/web'), { recursive: true })
      mkdirSync(join(directory, '.agent-presets/sample'), { recursive: true })
      writeFileSync(join(directory, 'profiles/web/package.json'), JSON.stringify({ name: 'fixture', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
      writeFileSync(join(directory, 'settings.yaml'), 'theme: original\n')
      writeFileSync(join(directory, '.agent-presets/sample/agent.cordis.yml'), '[]\n')
    }
    writeFileSync(join(source, '.agent-presets/sample/old.bin'), original)
    await exportPrivateEnvironment({ ...options, dshHomePath: source })
    exportThirdPartyPlugins({ profileDir: join(home, 'profiles/web'), repositoryPath: repository })
    writeFileSync(join(home, '.agent-presets/sample/old.bin'), original)
    rmSync(join(source, '.agent-presets/sample/old.bin'))
    writeFileSync(join(source, '.agent-presets/sample/agent.cordis.yml'), '- id: changed\n')
    writeFileSync(join(source, '.agent-presets/sample/new.bin'), Buffer.from([1, 2, 3]))
    writeFileSync(join(source, 'settings.yaml'), 'theme: incoming\n')
    await exportPrivateEnvironment({ ...options, dshHomePath: source })
    await assert.rejects(applyEnvironment({ ...options, verify: async () => { throw new Error('fixture verification failed') } }), /fixture verification failed/)
    assert.equal(readFileSync(join(home, '.agent-presets/sample/agent.cordis.yml'), 'utf8'), '[]\n')
    assert.deepEqual(readFileSync(join(home, '.agent-presets/sample/old.bin')), original)
    assert.equal(existsSync(join(home, '.agent-presets/sample/new.bin')), false)
    assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'theme: original\n')
    assert.equal(JSON.parse(readFileSync(join(home, 'profiles/web/.dsh-environment-restore.json'))).state, 'restored')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
