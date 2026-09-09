import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
