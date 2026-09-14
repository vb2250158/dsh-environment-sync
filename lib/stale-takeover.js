/** Explicit preserve-current takeover. No installer, Git, snapshot restore or secret logging. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync, chmodSync } from 'node:fs'
import { resolve, join, dirname, relative, isAbsolute } from 'node:path'
import lockfile from 'proper-lockfile'

export const JOURNALS = ['.dsh-environment-operation.json', '.dsh-environment-restore.json', '.dsh-plugin-operation.json']
const PENDING = '.dsh-stale-takeover.pending.json'
const fail = () => { throw new Error('Takeover refused; preserve records and review local prerequisites. No diagnostic file contents are emitted.') }
export function assertNoPendingTakeover(profileDir) {
  if (existsSync(join(profileDir, PENDING))) throw new Error('Preserve-current takeover is pending; finish its explicit CLI recovery before any sync or restore.')
}
function safePath(path) {
  path = resolve(path)
  let cursor = path
  while (true) {
    if (existsSync(cursor)) {
      if (lstatSync(cursor).isSymbolicLink() || resolve(realpathSync(cursor)).toLowerCase() !== cursor.toLowerCase()) fail()
    } else {
      try { lstatSync(cursor); fail() } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return path
}
function bytes(path) {
  safePath(path)
  if (!existsSync(path)) return null
  if (!lstatSync(path).isFile()) fail()
  return readFileSync(path)
}
const hash = value => value === null ? null : createHash('sha256').update(value).digest('hex')
function put(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, contents); fsyncSync(fd) } finally { closeSync(fd) }
}
function immutable(path, value) {
  if (existsSync(path)) { if (hash(bytes(path)) !== hash(value)) fail(); return }
  put(path, value)
  chmodSync(path, 0o400)
}
function files(profile) {
  return [...new Set(['settings.yaml', 'AGENTS.md', 'cordis.patch.yml', '.credentials.yaml', 'plugins/subscriptions/auth.json',
    ...['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', '.dsh-plugin-sync-baseline.json', '.dsh-restart-required', 'private-plugin-repository.json', ...JOURNALS].map(n => `profiles/${profile}/${n}`)])]
}

/** hooks are injection-only tests, never accepted by the CLI. Errors deliberately omit paths/data. */
export async function takeoverStaleTransactions(options, hooks = {}) {
  const releases = []
  try {
    if (options.confirmPreserveCurrent !== true || options.acknowledgeUnverifiedInstallation !== true || options.confirmExclusiveMaintenance !== true || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options.profile ?? '')) fail()
    for (const key of ['home', 'repository', 'backupDirectory']) if (typeof options[key] !== 'string' || !isAbsolute(options[key])) fail()
    const home = safePath(options.home), profile = options.profile
    const profileDir = safePath(join(home, 'profiles', profile)), repository = safePath(options.repository)
    const backup = safePath(options.backupDirectory), backupRoot = safePath(join(home, 'backups'))
    const within = relative(backupRoot, backup)
    if (!within || within.startsWith('..') || isAbsolute(within)) fail()
    for (const dir of [home, profileDir, repository, join(repository, '.git')]) if (!existsSync(dir) || !lstatSync(dir).isDirectory()) fail()
    const locks = [join(repository, '.git', 'dsh-environment.lock'), join(profileDir, '.dsh-environment-apply.lock'), join(profileDir, '.dsh-plugin-sync.lock')]
    // Fail closed on ANY existing lock, including stale or unrecognised entries. Never steal.
    for (const path of locks) { safePath(path); if (existsSync(path)) fail() }
    // proper-lockfile keys its in-process ownership table by the first argument,
    // not lockfilePath. Each held lock needs a distinct identity or later locks
    // overwrite earlier ownership and leave their on-disk directories behind.
    for (const path of locks) releases.push(await lockfile.lock(path, { lockfilePath: path, realpath: false, stale: 2147483647, retries: 0 }))
    const pendingPath = join(profileDir, PENDING)
    const pendingBytes = bytes(pendingPath)
    const receiptPath = join(backup, 'receipt.json')
    const receipt = { schemaVersion: 1, disposition: 'preserved-current-not-restored', installationConsistency: 'not-proven', oldTransactionSucceeded: false, synchronizationSucceeded: false }
    if (pendingBytes !== null && JSON.parse(pendingBytes).backup !== backup) fail()
    if (existsSync(receiptPath)) {
      if (JOURNALS.some(n => existsSync(join(profileDir, n)))) fail()
      if (hash(bytes(receiptPath)) !== hash(Buffer.from(JSON.stringify(receipt)))) fail()
    }
    if (pendingBytes === null && !existsSync(receiptPath)) {
      // Existing directories are never adopted as a new operation's archive.
      if (existsSync(backup)) fail()
      put(pendingPath, JSON.stringify({ schemaVersion: 1, backup }))
    }
    mkdirSync(backup, { recursive: true, mode: 0o700 })
    const manifestPath = join(backup, 'manifest.json')
    let manifest
    if (existsSync(manifestPath)) manifest = JSON.parse(bytes(manifestPath))
    else {
      const entries = files(profile).map(path => ({ path, value: bytes(join(home, path)) }))
      if (!entries.some(e => JOURNALS.some(n => e.path.endsWith('/' + n)) && e.value !== null)) fail()
      for (const e of entries) if (e.value !== null) immutable(join(backup, 'current', e.path), e.value)
      manifest = { schemaVersion: 1, files: entries.map(e => ({ path: e.path, hash: hash(e.value) })) }
      // Partial manifest writes stay separate; no journal is moved before publication.
      const tmp = join(backup, 'manifest.pending')
      if (existsSync(tmp)) { if (hash(bytes(tmp)) !== hash(Buffer.from(JSON.stringify(manifest)))) fail() }
      else put(tmp, JSON.stringify(manifest))
      renameSync(tmp, manifestPath); chmodSync(manifestPath, 0o400)
    }
    if (manifest.schemaVersion !== 1 || JSON.stringify(manifest.files.map(e => e.path)) !== JSON.stringify(files(profile))) fail()
    // Verify the entire backup and current non-journal set before resuming any move.
    for (const e of manifest.files) {
      if (hash(bytes(join(backup, 'current', e.path))) !== e.hash) fail()
      const journal = JOURNALS.find(n => e.path === `profiles/${profile}/${n}`)
      const current = hash(bytes(join(home, e.path)))
      if (!journal) { if (current !== e.hash) fail() }
      else {
        const archived = hash(bytes(join(backup, 'journals', journal)))
        if (current !== e.hash && !(current === null && archived === e.hash)) fail()
        if (archived !== null && (archived !== e.hash || current !== null)) fail()
      }
    }
    for (const name of JOURNALS) {
      const source = join(profileDir, name), target = join(backup, 'journals', name)
      if (!existsSync(source)) continue
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      renameSync(source, target) // same-volume atomic move; EXDEV fails closed with pending barrier
      chmodSync(target, 0o400)
      hooks.afterMove?.(name)
    }
    immutable(receiptPath, Buffer.from(JSON.stringify(receipt)))
    if (existsSync(pendingPath)) unlinkSync(pendingPath)
    return receipt
  } catch (error) {
    hooks.onError?.('operation', error)
    fail()
  } finally {
    let releaseFailed = false
    for (const [index, release] of releases.reverse().entries()) {
      try {
        await release()
        hooks.afterRelease?.(index)
      } catch (error) {
        releaseFailed = true
        try { hooks.onError?.('release', error) } catch { /* diagnostic hooks cannot prevent releasing other locks */ }
      }
    }
    releases.length = 0
    if (releaseFailed) fail()
  }
}
