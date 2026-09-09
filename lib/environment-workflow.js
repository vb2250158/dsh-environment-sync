/** Git owns shared history; this workflow preserves local edits before applying a merged snapshot. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'

export function environmentFiles(profile) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profile)) throw new Error('Invalid sync profile')
  return ['environment.json', 'settings.yaml', 'AGENTS.md', 'cordis.patch.yml', `profiles/${profile}/cordis.patch.yml`, 'credentials.enc.json', 'config/plugins.json']
}

function statePath(home, profile) { return join(home, 'profiles', profile, '.dsh-environment-operation.json') }

function saveState(home, profile, state) {
  const path = statePath(home, profile)
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
}

export function environmentState(home, profile) {
  const path = statePath(home, profile)
  if (!existsSync(path)) return { phase: 'new', appliedCommit: null }
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!['new', 'exporting', 'merging', 'conflict', 'applying', 'pushing', 'ready'].includes(value.phase)) throw new Error('Invalid environment operation record')
  return value
}

export function markEnvironmentRestored(home, profile) {
  saveState(home, profile, { ...environmentState(home, profile), phase: 'ready' })
}

async function git(repository, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repository, ...args], { windowsHide: true, shell: false })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

async function checked(repository, args) {
  const result = await git(repository, args)
  if (!result.ok) throw new Error((result.stderr || result.stdout || `Git exited ${result.code}`).slice(-1800))
  return result.stdout
}

export async function environmentConflicts(repository) {
  const result = await git(repository, ['diff', '--name-only', '--diff-filter=U'])
  return result.ok ? result.stdout.split('\n').filter(Boolean) : []
}

export async function environmentConflictDetails(repository) {
  const paths = await environmentConflicts(repository)
  return Promise.all(paths.map(async path => {
    if (path === 'credentials.enc.json') return { path, local: '本机加密凭据', remote: '远端加密凭据' }
    const [local, remote] = await Promise.all(['2', '3'].map(stage => git(repository, ['show', `:${stage}:${path}`])))
    return { path, local: local.ok ? local.stdout.slice(0, 16000) : '已删除', remote: remote.ok ? remote.stdout.slice(0, 16000) : '已删除' }
  }))
}

/** Resolve one conflicted file using Git's preserved local or remote generation. */
export async function chooseEnvironmentConflict({ home, profile, repository, path, side }) {
  if (!environmentFiles(profile).includes(path) || !['local', 'remote'].includes(side)) throw new Error('Invalid conflict selection')
  const release = await lockfile.lock(repository, { lockfilePath: join(repository, '.git', 'dsh-environment.lock') })
  try {
    if (!(await environmentConflicts(repository)).includes(path)) throw new Error('This file no longer has a conflict')
    const stage = side === 'local' ? '2' : '3'
    const present = await git(repository, ['cat-file', '-e', `:${stage}:${path}`])
    if (present.ok) {
      await checked(repository, ['checkout', side === 'local' ? '--ours' : '--theirs', '--', path])
      await checked(repository, ['add', '--', path])
    } else {
      await checked(repository, ['rm', '--', path])
    }
    const conflicts = await environmentConflicts(repository)
    if (conflicts.length === 0) {
      await checked(repository, ['-c', 'user.name=DSH Environment Sync', '-c', 'user.email=dsh-sync@localhost', 'commit', '--no-edit'])
      saveState(home, profile, { ...environmentState(home, profile), phase: 'applying' })
    }
    return conflicts
  } finally { await release() }
}

async function commitChanges(repository, paths) {
  const tracked = (await checked(repository, ['ls-files', '--', ...paths])).split('\n').filter(Boolean)
  const existing = paths.filter(path => existsSync(join(repository, path)))
  const selected = [...new Set([...tracked, ...existing])]
  if (selected.length === 0) throw new Error('The environment snapshot is empty')
  await checked(repository, ['add', '-A', '--', ...selected])
  const staged = (await checked(repository, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean)
  if (staged.some(path => !paths.includes(path))) throw new Error('暂存区含同步范围之外的文件，已停止提交。')
  const difference = await git(repository, ['diff', '--cached', '--quiet'])
  if (difference.code === 1) await checked(repository, ['-c', 'user.name=DSH Environment Sync', '-c', 'user.email=dsh-sync@localhost', 'commit', '-m', 'Sync shared DSH environment'])
  else if (!difference.ok) throw new Error(difference.stderr || 'Cannot inspect staged environment')
}

/** Run upload or pull with recoverable Git phases. Callbacks own validation and installation. */
export async function synchronizeEnvironment({ home, profile, repository, upload, exportSnapshot, applySnapshot }) {
  mkdirSync(join(home, 'profiles', profile), { recursive: true })
  const release = await lockfile.lock(repository, { lockfilePath: join(repository, '.git', 'dsh-environment.lock') })
  const paths = environmentFiles(profile)
  let state = environmentState(home, profile)
  const save = next => { state = { ...state, ...next }; saveState(home, profile, state) }
  try {
    const conflicts = await environmentConflicts(repository)
    if (conflicts.length) return { state: 'conflict', message: '请先选择冲突文件的本机或远端版本。', conflicts }
    // Resolved conflicts may have been committed by an external Git client.
    if (state.phase === 'conflict') save({ phase: 'applying' })
    if (state.phase === 'new' || state.phase === 'ready') {
      const changes = await checked(repository, ['status', '--porcelain=v1', '--untracked-files=all'])
      if (changes !== '') throw new Error('配置仓库存在未归入同步操作的改动，已保留。请先通过 Git 客户端提交，避免覆盖。')
      save({ phase: 'exporting', upload })
    }
    if (state.phase === 'exporting') {
      // First restore uses the remote environment; later pulls first preserve local changes.
      if (state.upload || state.appliedCommit !== null) {
        await exportSnapshot()
        await commitChanges(repository, paths)
      }
      save({ phase: 'merging' })
    }
    if (state.phase === 'merging') {
      await checked(repository, ['fetch', 'origin', '--prune'])
      const upstream = await git(repository, ['rev-parse', '--verify', '@{upstream}'])
      if (!upstream.ok) throw new Error('同步分支没有关联远端分支，请先通过 Git 客户端发布此分支。')
      const merged = await git(repository, ['-c', 'user.name=DSH Environment Sync', '-c', 'user.email=dsh-sync@localhost', 'merge', '--no-edit', upstream.stdout])
      if (!merged.ok) {
        const conflicts = await environmentConflicts(repository)
        if (!conflicts.length) throw new Error(merged.stderr || merged.stdout)
        save({ phase: 'conflict' })
        return { state: 'conflict', message: '本机改动已保存；请选择冲突文件采用的版本。', conflicts }
      }
      save({ phase: 'applying' })
    }
    if (state.phase === 'applying') {
      await applySnapshot()
      save({ phase: state.upload ? 'pushing' : 'ready', appliedCommit: await checked(repository, ['rev-parse', 'HEAD']) })
    }
    if (state.phase === 'pushing') {
      const pushed = await git(repository, ['push', 'origin', 'HEAD'])
      if (!pushed.ok) {
        save({ phase: 'merging' })
        throw new Error((pushed.stderr || '上传失败；点击重试将重新合并远端更新。').slice(-1800))
      }
      save({ phase: 'ready' })
    }
    return { state: 'succeeded', message: state.upload ? '共享环境已应用并上传。' : '共享环境已应用；本机尚未上传的改动已保留。', afterHead: state.appliedCommit }
  } finally { await release() }
}
