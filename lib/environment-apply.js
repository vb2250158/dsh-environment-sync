/** Keep configuration and plugin rollback in the same persistent application record. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { importPrivateEnvironment, preparePrivateEnvironment } from '../scripts/private-environment-sync.mjs'
import { syncThirdPartyPlugins } from '../scripts/sync-third-party-plugins.mjs'
import lockfile from 'proper-lockfile'

function save(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

/** Apply a snapshot, or restore the previous complete environment on any reported failure. */
export async function applyEnvironment(options) {
  const profile = options.profile ?? 'web'
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profile)) throw new Error('Invalid profile')
  const directory = join(resolve(options.dshHomePath), 'profiles', profile)
  mkdirSync(directory, { recursive: true })
  const release = await lockfile.lock(join(directory, '.dsh-environment-apply'), { realpath: false })
  try { return await applyEnvironmentOnce(options) } finally { await release() }
}

async function applyEnvironmentOnce({ dshHomePath, dataRootPath, profile = 'web', sourceRoot, encryptionSecret, verify = async () => {}, restoreOnly = false }) {
  const home = resolve(dshHomePath)
  const profileDir = join(home, 'profiles', profile)
  const journalPath = join(profileDir, '.dsh-environment-restore.json')
  const allowed = new Set(['settings.yaml', 'AGENTS.md', 'cordis.patch.yml', `profiles/${profile}/cordis.patch.yml`, '.credentials.yaml', 'plugins/subscriptions/auth.json'])
  const restore = async journal => {
    if (journal.schemaVersion !== 1 || !Array.isArray(journal.files) || journal.files.some(entry => !allowed.has(entry.path) || (entry.contents !== null && typeof entry.contents !== 'string'))) throw new Error('Invalid environment recovery record')
    for (const entry of journal.files) {
      const path = join(home, entry.path)
      if (entry.contents === null) { if (existsSync(path)) unlinkSync(path) }
      else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, entry.contents, { mode: 0o600 }) }
    }
    await syncThirdPartyPlugins({ profileDir, repositoryPath: dataRootPath, profile, sourceRoot, operationId: journal.id, restoreOnly: true })
    save(journalPath, { ...journal, state: 'restored' })
  }
  const pending = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : null
  if (restoreOnly) {
    if (pending === null) throw new Error('没有可恢复的环境记录')
    await restore(pending)
    return { restored: true }
  }
  if (pending?.state === 'applying' || pending?.state === 'restore-failed') await restore(pending)
  const prepared = await preparePrivateEnvironment({ dshHomePath: home, dataRootPath, profile, encryptionSecret })
  const files = prepared.writes.map(entry => ({ path: relative(home, entry.path).replaceAll('\\', '/'), contents: existsSync(entry.path) ? readFileSync(entry.path, 'utf8') : null }))
  const journal = { schemaVersion: 1, id: randomUUID(), state: 'applying', files }
  save(journalPath, journal)
  try {
    await syncThirdPartyPlugins({ profileDir, repositoryPath: dataRootPath, profile, sourceRoot, operationId: journal.id })
    await importPrivateEnvironment({ dshHomePath: home, dataRootPath, profile, encryptionSecret })
    await verify()
    save(journalPath, { ...journal, state: 'succeeded' })
    return { restored: false }
  } catch (error) {
    try { await restore(journal) } catch (rollbackError) {
      save(journalPath, { ...journal, state: 'restore-failed' })
      throw new AggregateError([error, rollbackError], '环境应用与恢复均未完成；恢复点已保留，请重试。')
    }
    throw error
  }
}
