import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse, stringify } from 'yaml'
import { retainDesktopGitSource } from '../scripts/sync-third-party-plugins.mjs'

for (const invalid of [null, 'commit', 'repo', 'direct']) {
  test(`Desktop retains fixed private Git source: ${invalid ?? 'verified lock'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-git-'))
    const name = 'fixture-plugin', commit = '1'.repeat(40)
    const repository = 'https://github.com/example/plugin.git'
    const recorded = `git+${repository}`, pinned = recorded + '#' + commit
    const specifier = `github:example/plugin#${commit}`
    const manifest = { dependencies: { [name]: recorded, unrelated: '2.0.0' }, dsh: { profile: { bundles: [] } } }
    const lock = { lockfileVersion: '9.0', importers: { '.': { dependencies: { [name]: { specifier: recorded, version: pinned + '(peer@1.0.0)' } } } }, packages: { [name + '@' + pinned]: { resolution: { type: 'git', repo: repository, commit } } } }
    if (invalid === 'commit') lock.packages[name + '@' + pinned].resolution.commit = '2'.repeat(40)
    if (invalid === 'repo') lock.packages[name + '@' + pinned].resolution.repo = 'https://github.com/other/plugin.git'
    if (invalid === 'direct') lock.importers['.'].dependencies[name].version = recorded + '#' + '2'.repeat(40)
    const before = JSON.stringify(manifest, null, 2) + '\n', lockBefore = stringify(lock)
    try {
      await writeFile(join(root, 'package.json'), before)
      await writeFile(join(root, 'pnpm-lock.yaml'), lockBefore)
      if (invalid) {
        await assert.rejects(retainDesktopGitSource(root, name, specifier), /does not prove/)
        assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before)
        assert.equal(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'), lockBefore)
      } else {
        await retainDesktopGitSource(root, name, specifier)
        const after = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
        assert.deepEqual(after, { ...manifest, dependencies: { ...manifest.dependencies, [name]: specifier } })
        const lockAfter = parse(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'))
        assert.deepEqual(lockAfter.packages, lock.packages)
        assert.equal(lockAfter.importers['.'].dependencies[name].specifier, specifier)
        await retainDesktopGitSource(root, name, specifier)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}
