import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chooseEnvironmentConflict, environmentState, synchronizeEnvironment } from '../lib/environment-workflow.js'

test('two real Git clones preserve changes, resolve conflicts and resume failed application', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-workflow-'))
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    const remote = join(root, 'remote.git'), a = join(root, 'a'), b = join(root, 'b')
    mkdirSync(remote)
    git(remote, 'init', '--bare', '--initial-branch=main')
    git(root, 'clone', '--config', 'core.autocrlf=false', remote, a)
    writeFileSync(join(a, 'settings.yaml'), 'theme: blue\n')
    git(a, 'add', 'settings.yaml')
    git(a, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial')
    git(a, 'push', '-u', 'origin', 'main')
    git(root, 'clone', '--config', 'core.autocrlf=false', remote, b)
    const computers = [a, b].map(repository => ({ repository, home: join(repository, '..', repository === a ? 'home-a' : 'home-b'), profile: 'web' }))
    let localA = 'theme: red\n', localB = '', fail = false
    const runA = upload => synchronizeEnvironment({ ...computers[0], upload, exportSnapshot: async () => writeFileSync(join(a, 'settings.yaml'), localA), applySnapshot: async () => { localA = readFileSync(join(a, 'settings.yaml'), 'utf8') } })
    const runB = upload => synchronizeEnvironment({ ...computers[1], upload, exportSnapshot: async () => writeFileSync(join(b, 'settings.yaml'), localB), applySnapshot: async () => { if (fail) throw new Error('fixture installation failed'); localB = readFileSync(join(b, 'settings.yaml'), 'utf8') } })
    await runA(true)
    await runB(false)
    assert.equal(localB, 'theme: red\n')
    localA = 'theme: green\n'; localB = 'theme: yellow\n'
    await runA(true)
    const conflict = await runB(false)
    assert.equal(conflict.state, 'conflict')
    assert.deepEqual(conflict.conflicts, ['settings.yaml'])
    assert.equal(localB, 'theme: yellow\n')
    await chooseEnvironmentConflict({ ...computers[1], path: 'settings.yaml', side: 'remote' })
    fail = true
    await assert.rejects(runB(false), /fixture installation failed/)
    assert.equal(environmentState(computers[1].home, 'web').phase, 'applying')
    fail = false
    await runB(false)
    assert.equal(localB, 'theme: green\n')
    await runB(true)
    const head = git(b, 'rev-parse', 'HEAD')
    await runB(false)
    assert.equal(git(b, 'rev-parse', 'HEAD'), head)
    assert.equal(git(b, 'status', '--porcelain'), '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
