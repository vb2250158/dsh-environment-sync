import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import spawn from 'cross-spawn'
import { syncThirdPartyPlugins } from '../scripts/sync-third-party-plugins.mjs'

test('real Git preflight fetches package metadata without unrelated media and rejects a version mismatch before installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-metadata-'))
  const remote = join(root, 'remote'), profileDir = join(root, 'profile'), repositoryPath = join(root, 'private')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${pathToFileURL(remote).href}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://example.invalid/plugin.git',
    GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always', GIT_TERMINAL_PROMPT: '0' }
  const git = args => execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    await mkdir(remote)
    git(['init', '--quiet', '-b', 'main', remote])
    git(['-C', remote, 'config', 'uploadpack.allowFilter', 'true'])
    git(['-C', remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true'])
    await writeFile(join(remote, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }))
    await writeFile(join(remote, 'unrelated-media.bin'), randomBytes(128 * 1024))
    git(['-C', remote, 'add', '.'])
    git(['-C', remote, 'commit', '--quiet', '-m', 'fixture'])
    const commit = git(['-C', remote, 'rev-parse', 'HEAD'])
    const media = git(['-C', remote, 'rev-parse', 'HEAD:unrelated-media.bin'])
    const packageBlob = git(['-C', remote, 'rev-parse', 'HEAD:package.json'])
    const specifier = `git+https://example.invalid/plugin.git#${commit}`
    await mkdir(profileDir)
    await mkdir(join(repositoryPath, 'config'), { recursive: true })
    await writeFile(join(profileDir, 'package.json'), '{"dependencies":{}}\n')
    const writeManifest = version => writeFile(join(repositoryPath, 'config/plugins.json'), JSON.stringify({ schemaVersion: 2,
      plugins: [{ name: 'fixture-plugin', version, specifier }] }))
    await writeManifest('1.0.0')
    let installs = 0
    const options = { profileDir, repositoryPath, profile: 'desktop',
      spawnCommand: (command, args, options) => spawn(command, args, { ...options, env }),
      desktopManager: {
        async installBundle(actual) {
          assert.equal(actual, specifier)
          installs++
          await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': specifier } }))
          await mkdir(join(profileDir, 'node_modules/fixture-plugin'), { recursive: true })
          await writeFile(join(profileDir, 'node_modules/fixture-plugin/package.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
          return { application: 'restart-required', bundle: 'fixture-plugin' }
        },
        async removeBundle() { throw new Error('Unexpected removal') },
      } }
    await syncThirdPartyPlugins(options)
    const cache = join(profileDir, '.dsh-plugin-cache', createHash('sha256').update(specifier).digest('hex'))
    const objects = git(['-C', cache, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).split('\n')
    assert.equal(objects.includes(packageBlob), true)
    assert.equal(objects.includes(media), false)
    const before = await readFile(join(profileDir, 'package.json'), 'utf8')
    await writeManifest('2.0.0')
    await assert.rejects(syncThirdPartyPlugins(options), /名称或版本与 Git 提交不符/)
    assert.equal(installs, 1)
    assert.equal(await readFile(join(profileDir, 'package.json'), 'utf8'), before)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
