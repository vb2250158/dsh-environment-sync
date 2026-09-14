import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { takeoverStaleTransactions, assertNoPendingTakeover, JOURNALS } from '../lib/stale-takeover.js'
import { environmentState } from '../lib/environment-workflow.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-takeover-test-'))
  const profileDir = join(home, 'profiles', 'test')
  const repository = join(home, 'repo')
  await mkdir(profileDir, { recursive: true }); await mkdir(join(repository, '.git'), { recursive: true })
  await mkdir(join(home, 'backups'))
  await writeFile(join(profileDir, 'package.json'), '{"dependencies":{}}')
  await writeFile(join(profileDir, '.dsh-plugin-sync-baseline.json'), 'current baseline')
  await writeFile(join(home, 'settings.yaml'), 'current: preserved')
  for (const name of JOURNALS) await writeFile(join(profileDir, name), JSON.stringify(name.includes('environment-operation') ? { phase: 'applying', upload: true } : { state: 'restore-failed', previous: 'SECRET-SENTINEL' }))
  return { home, profileDir, repository, profile: 'test', backupDirectory: join(home, 'backups', 'takeover'), confirmPreserveCurrent: true, acknowledgeUnverifiedInstallation: true, confirmExclusiveMaintenance: true }
}

test('archives all layers byte-for-byte, preserves current files and drops inherited upload', async t => {
  const o = await fixture(t)
  const before = await Promise.all(JOURNALS.map(n => readFile(join(o.profileDir, n))))
  const result = await takeoverStaleTransactions(o)
  assert.equal(result.installationConsistency, 'not-proven')
  assert.ok(!JSON.stringify(result).includes('SECRET-SENTINEL'))
  for (let i = 0; i < JOURNALS.length; i++) {
    await assert.rejects(access(join(o.profileDir, JOURNALS[i])))
    assert.deepEqual(await readFile(join(o.backupDirectory, 'journals', JOURNALS[i])), before[i])
  }
  assert.equal(await readFile(join(o.home, 'settings.yaml'), 'utf8'), 'current: preserved')
  assert.equal(await readFile(join(o.profileDir, '.dsh-plugin-sync-baseline.json'), 'utf8'), 'current baseline')
  assert.deepEqual(environmentState(o.home, o.profile), { phase: 'new', appliedCommit: null })
  assert.deepEqual(await takeoverStaleTransactions(o), result)
})

test('refuses every existing lock including old locks without removing it', async t => {
  for (const name of ['.dsh-plugin-sync.lock', '.dsh-environment-apply.lock']) {
    const o = await fixture(t); await mkdir(join(o.profileDir, name))
    await assert.rejects(takeoverStaleTransactions(o))
    await access(join(o.profileDir, name)); await access(join(o.profileDir, JOURNALS[0]))
  }
  const o = await fixture(t); await mkdir(join(o.repository, '.git', 'dsh-environment.lock'))
  await assert.rejects(takeoverStaleTransactions(o))
})

test('interrupted multi-journal move is blocked and safely resumes forward', async t => {
  const o = await fixture(t)
  await assert.rejects(takeoverStaleTransactions(o, { afterMove: () => { throw new Error('injected failure') } }))
  assert.throws(() => assertNoPendingTakeover(o.profileDir))
  await takeoverStaleTransactions(o)
  assert.doesNotThrow(() => assertNoPendingTakeover(o.profileDir))
})

test('requires explicit acknowledgements and Home backup destination', async t => {
  const o = await fixture(t)
  await assert.rejects(takeoverStaleTransactions({ ...o, confirmPreserveCurrent: false }))
  await assert.rejects(takeoverStaleTransactions({ ...o, acknowledgeUnverifiedInstallation: false }))
  await assert.rejects(takeoverStaleTransactions({ ...o, confirmExclusiveMaintenance: false }))
  await assert.rejects(takeoverStaleTransactions({ ...o, backupDirectory: join(o.home, 'elsewhere') }))
})

test('resume refuses changed current files and preserves pending barrier', async t => {
  const o = await fixture(t)
  await assert.rejects(takeoverStaleTransactions(o, { afterMove: () => { throw new Error('stop') } }))
  await writeFile(join(o.home, 'settings.yaml'), 'external change')
  await assert.rejects(takeoverStaleTransactions(o))
  assert.throws(() => assertNoPendingTakeover(o.profileDir))
})
