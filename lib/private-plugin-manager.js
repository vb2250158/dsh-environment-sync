/** Private-only GitHub repository manager for DSH custom plugins. */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { isMap, isSeq, parseDocument } from 'yaml'
import { exportThirdPartyPlugins, inspectThirdPartyPlugins, syncThirdPartyPlugins } from '../scripts/sync-third-party-plugins.mjs'
import { exportPrivateEnvironment, importPrivateEnvironment, privateEnvironmentPaths } from '../scripts/private-environment-sync.mjs'

export const PRIVATE_PLUGIN_PACKAGE_NAME = 'dsh-environment-sync'
export const DEFAULT_PRIVATE_PLUGIN_PROFILE = 'web'
export const REPOSITORY_CONFIG_FILENAME = 'private-plugin-repository.json'
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
export const PRIVATE_ENABLEMENT_BEGIN = '# dsh-environment-sync: begin managed enablement'
export const PRIVATE_ENABLEMENT_END = '# dsh-environment-sync: end managed enablement'

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const PATCH_LOCK_STALE_MILLIS = 30_000
const PATCH_LOCK_RETRY_MILLIS = 25
const PATCH_LOCK_RETRIES = 80
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CATALOG_PATH = join(PACKAGE_ROOT, 'catalog.json')
const BUNDLE_PATCH_PATH = join(PACKAGE_ROOT, 'cordis.patch.yml')

/** Reject a profile name before it becomes part of a filesystem path. */
export function validateProfileName(profile) {
  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)) {
    throw new TypeError('Private plugin profile must contain only letters, numbers, underscores, and hyphens')
  }
  return profile
}

/** Resolve the same DSH home used by the normal profile layout. */
export function resolvePrivatePluginDshHome(env = process.env, home = homedir()) {
  return resolve(env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(home, '.dsh'))
}

/** Return a verified private-plugin profile directory. */
export function resolvePrivatePluginProfileDir(dshHome, profile) {
  return join(resolve(dshHome), 'profiles', validateProfileName(profile))
}

export function repositoryConfigPath(dshHome, profile = DEFAULT_PRIVATE_PLUGIN_PROFILE) {
  return join(resolvePrivatePluginProfileDir(dshHome, profile), REPOSITORY_CONFIG_FILENAME)
}

/** Profile-local Loader overlay that owns private plugin enablement. */
export function profilePatchPath(dshHome, profile = DEFAULT_PRIVATE_PLUGIN_PROFILE) {
  return join(resolvePrivatePluginProfileDir(dshHome, profile), PROFILE_PATCH_FILENAME)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readOptionalJson(path) {
  if (!existsSync(path)) return undefined
  try {
    return readJson(path)
  } catch {
    return undefined
  }
}

function readOptionalText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function patchDocument(contents, path) {
  if (contents.trim() === '') return null
  const document = parseDocument(contents)
  if (document.errors.length > 0) throw new Error(`Cannot update ${path}: ${document.errors[0].message}`)
  if (document.contents !== null && !isSeq(document.contents)) throw new Error(`Cannot update ${path}: the patch root must be a YAML array`)
  return document
}

function patchEntry(node) {
  if (!isMap(node)) return null
  const id = node.get('id')
  if (typeof id !== 'string') return null
  const disabled = node.get('disabled')
  return {
    id,
    enabled: typeof disabled === 'boolean' ? !disabled : disabled === undefined ? true : null,
    start: node.range?.[0] ?? -1,
  }
}

function enablementBlockRange(contents, path) {
  const begin = contents.indexOf(PRIVATE_ENABLEMENT_BEGIN)
  const end = contents.indexOf(PRIVATE_ENABLEMENT_END)
  if (begin === -1 && end === -1) return null
  if (begin === -1 || end === -1 || end < begin || contents.indexOf(PRIVATE_ENABLEMENT_BEGIN, begin + PRIVATE_ENABLEMENT_BEGIN.length) !== -1 || contents.indexOf(PRIVATE_ENABLEMENT_END, end + PRIVATE_ENABLEMENT_END.length) !== -1) {
    throw new Error(`Cannot update ${path}: private managed enablement markers are malformed`)
  }
  const beginLineEnd = contents.indexOf('\n', begin)
  const endLineEnd = contents.indexOf('\n', end)
  return {
    start: begin,
    entriesStart: beginLineEnd === -1 ? contents.length : beginLineEnd + 1,
    entriesEnd: end,
    end: endLineEnd === -1 ? contents.length : endLineEnd + 1,
  }
}

function managedEnablement(contents, path) {
  const range = enablementBlockRange(contents, path)
  if (range === null) return new Map()
  const document = patchDocument(contents.slice(range.entriesStart, range.entriesEnd), path)
  const values = new Map()
  for (const node of document?.contents?.items ?? []) {
    const entry = patchEntry(node)
    if (entry === null || entry.enabled === null || values.has(entry.id)) throw new Error(`Cannot update ${path}: managed enablement entries must have unique string ids and boolean disabled values`)
    values.set(entry.id, entry.enabled)
  }
  return values
}

function patchStates(contents, path, loaderId) {
  const range = enablementBlockRange(contents, path)
  const document = patchDocument(contents, path)
  const states = []
  for (const node of document?.contents?.items ?? []) {
    const entry = patchEntry(node)
    if (entry?.id !== loaderId) continue
    states.push({
      enabled: entry.enabled,
      source: range !== null && entry.start >= range.entriesStart && entry.start < range.entriesEnd ? 'private-manager' : 'manual',
    })
  }
  return states
}

function lastPatchState(contents, path, loaderId) {
  const states = patchStates(contents, path, loaderId)
  return states.at(-1) ?? null
}

function hasManualPatchEntry(contents, path, loaderId) {
  return patchStates(contents, path, loaderId).some(state => state.source === 'manual')
}

function renderEnablementBlock(values, newline) {
  const lines = [PRIVATE_ENABLEMENT_BEGIN]
  for (const [loaderId, enabled] of values) lines.push(`- id: ${loaderId}`, `  disabled: ${String(!enabled)}`)
  lines.push(PRIVATE_ENABLEMENT_END)
  return `${lines.join(newline)}${newline}`
}

function replaceManagedEnablement(contents, path, loaderId, enabled) {
  const range = enablementBlockRange(contents, path)
  if (hasManualPatchEntry(contents, path, loaderId)) throw new Error(`Cannot update ${path}: ${loaderId} already has a manual profile patch entry`)
  const values = managedEnablement(contents, path)
  values.set(loaderId, enabled)
  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const block = renderEnablementBlock(values, newline)
  let next
  if (range === null) {
    const emptyRoot = /^([\s\S]*?)(?:^|\n)\[\][ \t]*(?:\r?\n)?$/m.exec(contents)
    next = emptyRoot === null
      ? `${contents}${contents === '' || contents.endsWith('\n') ? '' : newline}${block}`
      : `${emptyRoot[1]}${emptyRoot[1] === '' || emptyRoot[1].endsWith('\n') ? '' : newline}${block}`
  } else {
    next = `${contents.slice(0, range.start)}${block}${contents.slice(range.end)}`
  }
  patchDocument(next, path)
  return next
}

function writeAtomic(path, contents) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function withPatchLock(path, callback) {
  const lock = `${path}.dsh-environment-sync.lock`
  mkdirSync(dirname(path), { recursive: true })
  let descriptor
  for (let attempt = 0; attempt < PATCH_LOCK_RETRIES; attempt++) {
    try {
      descriptor = openSync(lock, 'wx', 0o600)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const age = Date.now() - statSync(lock).mtimeMs
      if (age > PATCH_LOCK_STALE_MILLIS) unlinkSync(lock)
      else sleep(PATCH_LOCK_RETRY_MILLIS)
    }
  }
  if (descriptor === undefined) throw new Error(`Timed out waiting to update ${path}`)
  try {
    return callback()
  } finally {
    closeSync(descriptor)
    unlinkSync(lock)
  }
}

function homePatchPath(dshHome) {
  return join(resolve(dshHome), PROFILE_PATCH_FILENAME)
}

/** Return the requested state and every persistent profile/home override for one loader row. */
export function privatePluginEnablement(dshHome, profile, loaderId) {
  if (typeof loaderId !== 'string' || loaderId.trim() === '') throw new TypeError('Private plugin loader id is required')
  const profilePath = profilePatchPath(dshHome, profile)
  const profileContents = readOptionalText(profilePath)
  const requestedEnabled = managedEnablement(profileContents, profilePath).get(loaderId) ?? true
  const profileState = lastPatchState(profileContents, profilePath, loaderId)
  const homePath = homePatchPath(dshHome)
  const homeState = lastPatchState(readOptionalText(homePath), homePath, loaderId)
  const effective = homeState ?? profileState ?? { enabled: true, source: 'bundle' }
  return {
    requestedEnabled,
    enabled: requestedEnabled,
    effectiveEnabled: effective.enabled,
    overrideSource: homeState === null ? effective.source : 'home',
    profileHasManualOverride: hasManualPatchEntry(profileContents, profilePath, loaderId),
    homeHasOverride: homeState !== null,
  }
}

/** Read one private loader row's current persistent effective enablement. */
export function privatePluginEnabled(dshHome, profile, loaderId) {
  return privatePluginEnablement(dshHome, profile, loaderId).effectiveEnabled !== false
}

/** Write one catalog-owned state into the manager-only profile patch section. */
export function writePrivatePluginEnabled(dshHome, profile, loaderId, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Private plugin enabled state must be a boolean')
  const path = profilePatchPath(dshHome, profile)
  return withPatchLock(path, () => {
    const contents = readOptionalText(path)
    const next = replaceManagedEnablement(contents, path, loaderId, enabled)
    writeAtomic(path, next)
    return enabled
  })
}

function packageVersion(manifest) {
  return typeof manifest?.version === 'string' && manifest.version.trim() !== '' ? manifest.version : null
}

function readPluginVersion(root, manifestPath) {
  return packageVersion(readOptionalJson(join(root, manifestPath)))
}

function readPluginChangelog(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(entry => typeof entry?.version === 'string' && Array.isArray(entry?.changes))
    .map(entry => ({
      version: entry.version,
      date: typeof entry.date === 'string' ? entry.date : '',
      changes: entry.changes.filter(change => typeof change === 'string' && change.trim() !== ''),
    }))
}

function bundleLoaderIds(bundlePatchPath = BUNDLE_PATCH_PATH) {
  const document = patchDocument(readFileSync(bundlePatchPath, 'utf8'), bundlePatchPath)
  const ids = new Set()
  for (const patch of document?.contents?.items ?? []) {
    if (!isMap(patch)) continue
    const inserted = patch.get('insert')
    if (!isSeq(inserted)) continue
    for (const node of inserted.items) {
      const entry = patchEntry(node)
      if (entry !== null) ids.add(entry.id)
    }
  }
  return ids
}

function readCatalog(catalogPath = CATALOG_PATH) {
  const catalog = readOptionalJson(catalogPath)
  if (!Array.isArray(catalog?.plugins)) return []
  return catalog.plugins
    .filter(plugin => typeof plugin?.id === 'string' && typeof plugin?.name === 'string' && typeof plugin?.packageName === 'string')
    .map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      packageName: plugin.packageName,
      repository: typeof plugin.repository === 'string' ? plugin.repository : '',
      author: typeof plugin.author === 'string' ? plugin.author : '',
      description: typeof plugin.description === 'string' ? plugin.description : '',
      details: typeof plugin.details === 'string' ? plugin.details : '',
      changelog: readPluginChangelog(plugin.changelog),
      loaderId: typeof plugin.loaderId === 'string' && plugin.loaderId.trim() !== '' ? plugin.loaderId : null,
      manageable: plugin.manageable !== false && typeof plugin.loaderId === 'string' && plugin.loaderId.trim() !== '',
    }))
}

function installedPluginVersion(profileDir, packageName) {
  return packageVersion(readOptionalJson(join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json')))
}

function normalizeGitHubUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('GitHub repository address is required')
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new TypeError('GitHub repository address must be a valid HTTPS URL')
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new TypeError('GitHub repository address must use https://github.com/...')
  }
  if (parsed.search || parsed.hash || parsed.pathname.split('/').filter(Boolean).length < 2) {
    throw new TypeError('GitHub repository address must name an owner and repository')
  }
  parsed.pathname = parsed.pathname.replace(/\.git$/, '')
  return parsed.toString().replace(/\/$/, '')
}

function canonicalRemoteUrl(value) {
  if (typeof value !== 'string') return value
  return value.replace(/\.git$/, '').replace(/\/$/, '')
}

function normalizeLocalPath(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('Private data directory is required')
  const path = value.trim()
  if (!isAbsolute(path)) throw new TypeError('Private data directory must be an absolute path')
  return resolve(path)
}

/** Validate the public source repository and separate private data repository. */
export function normalizeRepositoryConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Repository configuration must be an object')
  }
  return {
    dataRemoteUrl: normalizeGitHubUrl(value.dataRemoteUrl),
    dataLocalPath: normalizeLocalPath(value.dataLocalPath),
  }
}

function dataRepositoryConfig(config) {
  return config === undefined ? undefined : { remoteUrl: config.dataRemoteUrl, localPath: config.dataLocalPath }
}

export function readRepositoryConfig(dshHome, profile = DEFAULT_PRIVATE_PLUGIN_PROFILE) {
  const parsed = readOptionalJson(repositoryConfigPath(dshHome, profile))
  try {
    return parsed === undefined ? undefined : normalizeRepositoryConfig(parsed)
  } catch {
    return undefined
  }
}

export function writeRepositoryConfig(dshHome, profile, value) {
  const config = normalizeRepositoryConfig(value)
  const path = repositoryConfigPath(dshHome, profile)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return config
}

function profilePackageState(dshHome, profile) {
  const profileDir = resolvePrivatePluginProfileDir(dshHome, profile)
  const profileManifest = readOptionalJson(join(profileDir, 'package.json'))
  const requestedVersion = typeof profileManifest?.dependencies?.[PRIVATE_PLUGIN_PACKAGE_NAME] === 'string'
    ? profileManifest.dependencies[PRIVATE_PLUGIN_PACKAGE_NAME]
    : null
  const installedManifest = readOptionalJson(join(profileDir, 'node_modules', PRIVATE_PLUGIN_PACKAGE_NAME, 'package.json'))
  const installedVersion = typeof installedManifest?.version === 'string' ? installedManifest.version : null
  return {
    profileDir,
    profileManifest,
    package: {
      name: PRIVATE_PLUGIN_PACKAGE_NAME,
      requestedVersion,
      installedVersion,
      installed: installedVersion !== null,
    },
  }
}

/** Read the profile manifest and installed private bundle without Loader enumeration. */
export function readPrivatePluginStatus({
  dshHome = resolvePrivatePluginDshHome(),
  profile = DEFAULT_PRIVATE_PLUGIN_PROFILE,
  catalogPath = CATALOG_PATH,
} = {}) {
  const safeProfile = validateProfileName(profile)
  const state = profilePackageState(dshHome, safeProfile)
  const plugins = readCatalog(catalogPath).map(plugin => {
    const localVersion = installedPluginVersion(state.profileDir, plugin.packageName)
    if (!plugin.manageable) {
      return {
        ...plugin,
        localVersion,
        remoteVersion: null,
        installed: localVersion !== null,
        enabled: true,
        requestedEnabled: true,
        effectiveEnabled: true,
        overrideSource: 'bundle',
        controlAvailable: false,
      }
    }
    const enablement = privatePluginEnablement(dshHome, safeProfile, plugin.loaderId)
    return {
      ...plugin,
      localVersion,
      remoteVersion: null,
      installed: localVersion !== null,
      enabled: enablement.requestedEnabled,
      controlAvailable: !enablement.profileHasManualOverride && !enablement.homeHasOverride,
      ...enablement,
    }
  })
  return { profile: safeProfile, profileDir: state.profileDir, package: state.package, plugins }
}

function runProcess(command, args, { cwd, spawnCommand = spawn, rawOutput = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnCommand(command, args, {
      ...(cwd === undefined ? {} : { cwd }),
      shell: false,
      windowsHide: true,
    })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk.toString() })
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    child.once('error', rejectRun)
    child.once('close', (exitCode, signal) => {
      resolveRun({ ok: exitCode === 0, exitCode, signal, output: rawOutput ? output : outputSummary(output) })
    })
  })
}

async function git(localPath, args, spawnCommand) {
  return runProcess('git', ['-C', localPath, ...args], { spawnCommand })
}

function linkedDependencyPath(spec, profileDir) {
  if (typeof spec !== 'string' || !spec.startsWith('link:')) return null
  const value = spec.slice('link:'.length)
  return value === '' ? null : resolve(profileDir, value)
}

async function gitValue(localPath, args, spawnCommand) {
  const result = await git(localPath, args, spawnCommand)
  return result.ok ? result.output.trim() : null
}

async function inspectRepository(config, spawnCommand = spawn) {
  const missing = {
    configured: false,
    remoteUrl: null,
    localPath: null,
    pathExists: false,
    isGitRepository: false,
    originUrl: null,
    remoteMatches: false,
    branch: null,
    head: null,
    remoteHead: null,
    changes: null,
    upstream: null,
    canClone: false,
    canFetch: false,
    canPull: false,
    problem: '请先配置私有环境仓库。',
  }
  if (config === undefined) return missing

  const pathExists = existsSync(config.localPath)
  if (!pathExists) {
    return {
      ...missing,
      configured: true,
      remoteUrl: config.remoteUrl,
      localPath: config.localPath,
      canClone: true,
      problem: '本地目录尚不存在，可以克隆 GitHub 仓库。',
    }
  }
  const isDirectory = statSync(config.localPath).isDirectory()
  if (!isDirectory) {
    return {
      ...missing,
      configured: true,
      remoteUrl: config.remoteUrl,
      localPath: config.localPath,
      pathExists: true,
      problem: '本地插件地址不是目录。',
    }
  }
  const repository = await gitValue(config.localPath, ['rev-parse', '--is-inside-work-tree'], spawnCommand)
  if (repository !== 'true') {
    const empty = readdirSync(config.localPath).length === 0
    return {
      ...missing,
      configured: true,
      remoteUrl: config.remoteUrl,
      localPath: config.localPath,
      pathExists: true,
      canClone: empty,
      problem: empty ? '本地目录为空，可以克隆 GitHub 仓库。' : '本地目录不是 Git 仓库，不能覆盖其中的文件。',
    }
  }

  const [originUrl, branch, head, porcelain, upstreamName] = await Promise.all([
    gitValue(config.localPath, ['remote', 'get-url', 'origin'], spawnCommand),
    gitValue(config.localPath, ['branch', '--show-current'], spawnCommand),
    gitValue(config.localPath, ['rev-parse', '--short', 'HEAD'], spawnCommand),
    gitValue(config.localPath, ['status', '--porcelain=v1'], spawnCommand),
    gitValue(config.localPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], spawnCommand),
  ])
  const changes = porcelain === null ? null : porcelain.split('\n').filter(Boolean).length
  let upstream = null
  let remoteHead = null
  if (upstreamName !== null) {
    const [distance, upstreamHead] = await Promise.all([
      gitValue(config.localPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], spawnCommand),
      gitValue(config.localPath, ['rev-parse', '--short', '@{upstream}'], spawnCommand),
    ])
    const [behind, ahead] = distance?.split(/\s+/).map(Number) ?? []
    if (Number.isSafeInteger(behind) && Number.isSafeInteger(ahead)) upstream = { name: upstreamName, behind, ahead }
    remoteHead = upstreamHead
  }
  const remoteMatches = canonicalRemoteUrl(originUrl) === canonicalRemoteUrl(config.remoteUrl)
  const clean = changes === 0
  const canFetch = remoteMatches
  const canPull = remoteMatches && clean && upstream !== null && upstream.behind > 0
  return {
    configured: true,
    remoteUrl: config.remoteUrl,
    localPath: config.localPath,
    pathExists: true,
    isGitRepository: true,
    originUrl,
    remoteMatches,
    branch,
    head,
    remoteHead,
    changes,
    upstream,
    canClone: false,
    canFetch,
    canPull,
    problem: !remoteMatches
      ? '本地 origin 与配置的 GitHub 地址不同。'
      : !clean
        ? `本地有 ${String(changes)} 项未提交或未追踪改动；请先提交并推送，再同步更新。`
        : null,
  }
}

function actionResult(action, result, beforeHead, afterHead) {
  return {
    state: result.ok ? 'succeeded' : 'failed',
    action,
    message: result.output || (result.ok ? '操作完成。' : `git exited with code ${String(result.exitCode)}`),
    beforeHead,
    afterHead,
  }
}

function requireRepository(repository, condition, message) {
  if (!condition) throw new Error(message)
  return repository
}

function normalizePluginEnablementRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Private plugin enablement request must be an object')
  if (typeof value.id !== 'string' || value.id.trim() === '') throw new TypeError('Private plugin id is required')
  if (typeof value.enabled !== 'boolean') throw new TypeError('Private plugin enabled state must be a boolean')
  return { id: value.id, enabled: value.enabled }
}

/** Clone, fetch, or fast-forward pull only the configured private checkout. */
export async function runRepositoryAction(config, action, spawnCommand = spawn) {
  const before = await inspectRepository(config, spawnCommand)
  let result
  if (action === 'clone') {
    requireRepository(before, before.canClone, before.problem || 'The local plugin directory cannot be cloned into.')
    result = await runProcess('git', ['clone', config.remoteUrl, config.localPath], { spawnCommand })
  } else if (action === 'fetch') {
    requireRepository(before, before.canFetch, before.problem || 'GitHub fetch is unavailable.')
    result = await git(config.localPath, ['fetch', 'origin', '--prune'], spawnCommand)
  } else if (action === 'pull') {
    requireRepository(before, before.canPull, before.problem || 'GitHub pull is unavailable.')
    result = await git(config.localPath, ['pull', '--ff-only'], spawnCommand)
  } else if (action === 'sync') {
    requireRepository(before, before.canFetch, before.problem || 'GitHub synchronization is unavailable.')
    requireRepository(before, before.changes === 0, '本地存在未提交或未追踪改动；请先提交并推送，再同步更新。')
    const fetched = await git(config.localPath, ['fetch', 'origin', '--prune'], spawnCommand)
    if (!fetched.ok) return { repository: await inspectRepository(config, spawnCommand), operation: actionResult(action, fetched, before.head, before.head) }
    const afterFetch = await inspectRepository(config, spawnCommand)
    if (afterFetch.canPull) {
      result = await git(config.localPath, ['pull', '--ff-only'], spawnCommand)
    } else {
      result = fetched
    }
  } else {
    throw new TypeError('Unsupported private repository action')
  }
  const after = await inspectRepository(config, spawnCommand)
  return { repository: after, operation: actionResult(action, result, before.head, after.head) }
}


function readPrivateEnvironmentSummary(dataLocalPath, profile) {
  try {
    const paths = privateEnvironmentPaths(dataLocalPath, profile)
    const manifest = readJson(paths.manifest)
    return {
      configured: true,
      manifestPath: paths.manifest,
      profile: manifest.profile,
      bundleCount: Array.isArray(manifest.bundles) ? manifest.bundles.length : 0,
      dependencyCount: Array.isArray(manifest.dependencies) ? manifest.dependencies.length : 0,
      settingsNamespaceCount: Array.isArray(manifest.settingsNamespaces) ? manifest.settingsNamespaces.length : 0,
      credentialsEncrypted: manifest.included?.credentials === true,
      problem: null,
    }
  } catch (error) {
    return {
      configured: false,
      manifestPath: null,
      profile,
      bundleCount: 0,
      dependencyCount: 0,
      settingsNamespaceCount: 0,
      credentialsEncrypted: false,
      problem: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Export, commit, and push the complete private DSH environment. */
export async function publishPrivateEnvironmentRepository(config, { dshHome, profile, spawnCommand = spawn } = {}) {
  const dataConfig = dataRepositoryConfig(config)
  const before = await inspectRepository(dataConfig, spawnCommand)
  requireRepository(before, before.isGitRepository && before.remoteMatches, before.problem || 'Private data repository is unavailable.')
  requireRepository(before, before.changes === 0, '私有数据目录有未提交或未追踪改动；请先处理后再上传环境。')

  const fetched = await git(dataConfig.localPath, ['fetch', 'origin', '--prune'], spawnCommand)
  if (!fetched.ok) throw new Error(fetched.output || 'Private data fetch failed')
  const afterFetch = await inspectRepository(dataConfig, spawnCommand)
  if ((afterFetch.upstream?.behind ?? 0) > 0) throw new Error('私有数据仓库有其他电脑的新提交；请先下载并应用，再重新上传。')
  if ((afterFetch.upstream?.ahead ?? 0) > 0) throw new Error('私有数据仓库已有尚未推送的本机提交；请先推送或处理该提交。')

  await exportPrivateEnvironment({ dshHomePath: dshHome, dataRootPath: dataConfig.localPath, profile })
  exportThirdPartyPlugins({ profileDir: resolvePrivatePluginProfileDir(dshHome, profile), repositoryPath: dataConfig.localPath, profile })
  const added = await git(dataConfig.localPath, ['add', '-A'], spawnCommand)
  if (!added.ok) throw new Error(added.output || 'Private data git add failed')
  const changed = await git(dataConfig.localPath, ['diff', '--cached', '--quiet'], spawnCommand)
  if (changed.exitCode === 0) {
    return { repository: await inspectRepository(dataConfig, spawnCommand), operation: { state: 'succeeded', action: 'publish-data', message: '私有环境与远程记录一致，没有需要上传的变化。', beforeHead: before.head, afterHead: before.head } }
  }
  if (changed.exitCode !== 1) throw new Error(changed.output || 'Private data change detection failed')
  const committed = await git(dataConfig.localPath, ['commit', '-m', 'Sync DSH private environment'], spawnCommand)
  if (!committed.ok) throw new Error(committed.output || 'Private data commit failed')
  const pushed = await git(dataConfig.localPath, ['push', '-u', 'origin', 'HEAD'], spawnCommand)
  if (!pushed.ok) throw new Error(pushed.output || 'Private data push failed')
  const after = await inspectRepository(dataConfig, spawnCommand)
  return { repository: after, operation: { state: 'succeeded', action: 'publish-data', message: '完整 DSH 环境已加密凭据并上传到私有数据仓库。', beforeHead: before.head, afterHead: after.head } }
}

/** Fast-forward the private data repository, restore the environment, and install recorded bundles. */
export async function importPrivateEnvironmentRepository(config, { dshHome, profile, spawnCommand = spawn } = {}) {
  const dataConfig = dataRepositoryConfig(config)
  const outcome = await runRepositoryAction(dataConfig, 'sync', spawnCommand)
  if (outcome.operation.state !== 'succeeded') return outcome
  await importPrivateEnvironment({ dshHomePath: dshHome, dataRootPath: dataConfig.localPath, profile })
  const thirdParty = await syncThirdPartyPlugins({
    profileDir: resolvePrivatePluginProfileDir(dshHome, profile),
    repositoryPath: dataConfig.localPath,
    profile,
  })
  outcome.operation.action = 'sync-data'
  outcome.operation.message = `私有环境已应用；开源插件已对齐：${String(thirdParty.plugins.length)} 个。`
  return outcome
}

function createManagerClass(protocol) {
  const remoteInitializers = []

  function markRemoteMethod(method) {
    protocol.Remote(method)(Manager.prototype[method], {
      private: false,
      static: false,
      name: method,
      addInitializer(initializer) {
        remoteInitializers.push(initializer)
      },
    })
  }

  class Manager extends protocol.TypertRemoteService {
    constructor(ctx, config = {}) {
      super(ctx, 'privatePluginManager')
      this.profile = validateProfileName(config.profile ?? DEFAULT_PRIVATE_PLUGIN_PROFILE)
      this.dshHome = resolvePrivatePluginDshHome()
      this.lastOperation = { state: 'idle', action: null, message: '' }
      this.running = false
      for (const initialize of remoteInitializers) initialize.call(this)
    }

    repositoryConfig() {
      return readRepositoryConfig(this.dshHome, this.profile)
    }

    async status() {
      return this.snapshot()
    }

    async configure(request) {
      if (this.running) throw new Error('Plugin manager operation is already running')
      const config = writeRepositoryConfig(this.dshHome, this.profile, request)
      this.lastOperation = { state: 'succeeded', action: 'configure', message: '私有环境仓库设置已保存。' }
      return this.snapshot(config)
    }

    async setEnabled(request) {
      if (this.running) throw new Error('Plugin manager operation is already running')
      const toggle = normalizePluginEnablementRequest(request)
      const plugin = readPrivatePluginStatus({ dshHome: this.dshHome, profile: this.profile }).plugins.find(item => item.id === toggle.id)
      if (plugin === undefined || !plugin.manageable || plugin.loaderId === null) throw new Error('This plugin cannot be enabled or disabled')
      if (!plugin.controlAvailable) {
        throw new Error(plugin.homeHasOverride
          ? 'This plugin is overridden by the DSH home patch; change that higher-priority patch first'
          : 'This plugin has a manual profile patch entry; remove it before using the plugin manager')
      }
      writePrivatePluginEnabled(this.dshHome, this.profile, plugin.loaderId, toggle.enabled)
      this.lastOperation = {
        state: 'succeeded',
        action: 'set-enabled',
        message: `${plugin.name}已${toggle.enabled ? '启用' : '停用'}；DSH 正在实时调和配置，请刷新浏览器更新插件页面。`,
      }
      return this.snapshot()
    }

    async cloneData() { return this.runDataRepository('clone') }

    async publishData() {
      if (this.running) throw new Error('Private environment operation is already running')
      const config = this.repositoryConfig()
      if (config === undefined) throw new Error('请先配置私有环境仓库')
      this.running = true
      try {
        const outcome = await publishPrivateEnvironmentRepository(config, { dshHome: this.dshHome, profile: this.profile })
        this.lastOperation = outcome.operation
      } catch (error) {
        this.lastOperation = { state: 'failed', action: 'publish-data', message: error instanceof Error ? error.message : String(error) }
      } finally {
        this.running = false
      }
      return this.snapshot(config)
    }

    async syncData() {
      if (this.running) throw new Error('Private environment operation is already running')
      const config = this.repositoryConfig()
      if (config === undefined) throw new Error('请先配置私有环境仓库')
      this.running = true
      try {
        const outcome = await importPrivateEnvironmentRepository(config, { dshHome: this.dshHome, profile: this.profile })
        this.lastOperation = outcome.operation
      } catch (error) {
        this.lastOperation = { state: 'failed', action: 'sync-data', message: error instanceof Error ? error.message : String(error) }
      } finally {
        this.running = false
      }
      return this.snapshot(config)
    }

    async recordThirdParty() {
      if (this.running) throw new Error('Plugin manager operation is already running')
      const config = this.repositoryConfig()
      if (config === undefined) throw new Error('请先配置私有环境仓库')
      try {
        const recorded = exportThirdPartyPlugins({
          profileDir: resolvePrivatePluginProfileDir(this.dshHome, this.profile),
          repositoryPath: config.dataLocalPath,
          profile: this.profile,
        })
        this.lastOperation = {
          state: 'succeeded',
          action: 'record-third-party',
          message: `已记录 ${String(recorded.plugins.length)} 个开源插件；提交并推送私有仓库后，其他电脑可同步安装。`,
        }
      } catch (error) {
        this.lastOperation = {
          state: 'failed',
          action: 'record-third-party',
          message: error instanceof Error ? error.message : String(error),
        }
      }
      return this.snapshot(config)
    }

    async syncThirdParty() {
      if (this.running) throw new Error('Plugin manager operation is already running')
      const config = this.repositoryConfig()
      if (config === undefined) throw new Error('请先配置私有环境仓库')
      this.running = true
      try {
        const result = await syncThirdPartyPlugins({
          profileDir: resolvePrivatePluginProfileDir(this.dshHome, this.profile),
          repositoryPath: config.dataLocalPath,
          profile: this.profile,
        })
        this.lastOperation = {
          state: 'succeeded',
          action: 'sync-third-party',
          message: `开源插件已对齐：${String(result.plugins.length)} 个。`,
        }
      } catch (error) {
        this.lastOperation = {
          state: 'failed',
          action: 'sync-third-party',
          message: error instanceof Error ? error.message : String(error),
        }
      } finally {
        this.running = false
      }
      return this.snapshot(config)
    }

    async runDataRepository(action) {
      if (this.running) throw new Error('Private environment operation is already running')
      const config = this.repositoryConfig()
      if (config === undefined) throw new Error('请先配置私有环境仓库')
      this.running = true
      try {
        const outcome = await runRepositoryAction(dataRepositoryConfig(config), action)
        this.lastOperation = outcome.operation
      } catch (error) {
        this.lastOperation = { state: 'failed', action: `${action}-data`, message: error instanceof Error ? error.message : String(error) }
      } finally {
        this.running = false
      }
      return this.snapshot(config)
    }

    async snapshot(config = this.repositoryConfig()) {
      const base = readPrivatePluginStatus({ dshHome: this.dshHome, profile: this.profile })
      const dataRepository = await inspectRepository(dataRepositoryConfig(config))
      const operation = this.running ? { ...this.lastOperation, state: 'running' } : this.lastOperation
      let thirdParty
      if (config === undefined) {
        thirdParty = { manifestPath: null, configured: false, plugins: [], installed: [], extra: [] }
      } else {
        try {
          thirdParty = inspectThirdPartyPlugins({
            profileDir: resolvePrivatePluginProfileDir(this.dshHome, this.profile),
            repositoryPath: config.dataLocalPath,
            profile: this.profile,
          })
        } catch (error) {
          thirdParty = {
            manifestPath: null,
            configured: false,
            plugins: [],
            installed: [],
            extra: [],
            problem: error instanceof Error ? error.message : String(error),
          }
        }
      }
      return {
        ...base,
        dataRepository,
        environment: config === undefined ? null : readPrivateEnvironmentSummary(config.dataLocalPath, this.profile),
        thirdParty,
        operation,
        restartRequired: operation.state === 'succeeded' && ['sync-third-party', 'sync-data'].includes(operation.action),
        refreshRequired: operation.state === 'succeeded' && operation.action === 'set-enabled',
      }
    }
  }

  markRemoteMethod('status')
  markRemoteMethod('configure')
  markRemoteMethod('setEnabled')
  markRemoteMethod('cloneData')
  markRemoteMethod('publishData')
  markRemoteMethod('syncData')
  markRemoteMethod('recordThirdParty')
  markRemoteMethod('syncThirdParty')
  return Manager
}

/** Unit tests and non-profile callers use the package-local protocol. */
export const PrivatePluginManager = createManagerClass({ TypertRemoteService, Remote })

let profileManagerClass

/**
 * Bind the Host service to the protocol instance used by the active DSH profile.
 * A linked private package otherwise resolves its own protocol copy and the Host
 * gateway cannot discover the Remote method markers.
 */
export function createProfilePrivatePluginManager() {
  if (profileManagerClass !== undefined) return profileManagerClass
  try {
    const profileRequire = createRequire(join(
      resolvePrivatePluginProfileDir(resolvePrivatePluginDshHome(), DEFAULT_PRIVATE_PLUGIN_PROFILE),
      'package.json',
    ))
    const protocol = profileRequire('@deepseek-ai/dsh-typert-protocol')
    if (typeof protocol?.TypertRemoteService === 'function' && typeof protocol?.Remote === 'function') {
      profileManagerClass = createManagerClass(protocol)
      return profileManagerClass
    }
  } catch {
    // Unit tests and unusual profile layouts can use the package-local protocol.
  }
  profileManagerClass = PrivatePluginManager
  return profileManagerClass
}
