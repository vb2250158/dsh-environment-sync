/** Record and reproduce portable DSH profile plugins. */

import spawn from 'cross-spawn'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import lockfile from 'proper-lockfile'
import { assertNoPendingTakeover } from '../lib/stale-takeover.js'
import { parse, parseDocument, stringify } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const THIRD_PARTY_MANIFEST_FILENAME = 'plugins.json'
export const THIRD_PARTY_MANIFEST_SCHEMA_VERSION = 2
export const PRIVATE_PLUGIN_PACKAGE_NAME = 'dsh-environment-sync'
export const RESTART_MARKER_FILENAME = '.dsh-restart-required'
export const PLUGIN_BASELINE_FILENAME = '.dsh-plugin-sync-baseline.json'
const OFFICIAL_PACKAGE_PREFIX = '@deepseek-ai/'
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function profileName(value) {
  if (typeof value !== 'string' || !PROFILE_NAME_PATTERN.test(value)) throw new TypeError('Plugin profile must contain only letters, numbers, underscores, and hyphens')
  return value
}

/** Web and Desktop share portable settings and third-party package records. */
export function profilesShareEnvironment(source, target) {
  const from = profileName(source), to = profileName(target)
  return from === to || (['web', 'desktop'].includes(from) && ['web', 'desktop'].includes(to))
}

function readJson(path, description) {
  if (!existsSync(path)) throw new Error(`${description} does not exist: ${path}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readOptionalJson(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.third-party-sync.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporaryPath, path)
}

function isOfficialPackage(name) {
  return name.startsWith(OFFICIAL_PACKAGE_PREFIX)
}

function isSupportedGitSpecifier(specifier) {
  return /^(?:github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|git\+https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+)#[0-9a-f]{40}$/i.test(specifier)
}

function sourceKind(specifier) {
  if (/^(?:git\+|github:)/.test(specifier)) return 'github'
  if (/^https?:\/\//.test(specifier)) return 'tarball'
  return 'registry'
}

function githubRepositoryOwner(specifier) {
  const githubMatch = /^github:([^/]+)\/[^#]+#[0-9a-f]{40}$/i.exec(specifier)
  if (githubMatch !== null) return githubMatch[1]
  const httpsMatch = /^git\+https:\/\/github\.com\/([^/]+)\/[^#]+(?:\.git)?#[0-9a-f]{40}$/i.exec(specifier)
  return httpsMatch?.[1] ?? null
}

function packageAuthor(manifest) {
  if (typeof manifest?.author === 'string' && manifest.author.trim() !== '') return manifest.author.trim()
  if (manifest?.author !== null && typeof manifest?.author === 'object' && typeof manifest.author.name === 'string' && manifest.author.name.trim() !== '') return manifest.author.name.trim()
  return null
}

function githubRepositorySlug(value, name) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(value.trim())) throw new Error(`Plugin package ${name} upstream repository must use owner/repository`)
  return value.trim()
}

function portableSpecifier(name, requested, version) {
  if (typeof requested !== 'string' || requested.trim() === '') throw new Error(`Plugin package ${name} has no dependency specifier`)
  const specifier = requested.trim()
  if (/^(?:link:|file:|workspace:)/.test(specifier)) throw new Error(`Plugin package ${name} uses a local-only specifier: ${specifier}`)
  if (/^(?:git\+|github:)/.test(specifier)) {
    if (!isSupportedGitSpecifier(specifier)) throw new Error(`Git plugin package ${name} must pin a 40-character commit: ${specifier}`)
    return specifier
  }
  if (/^https?:\/\//.test(specifier)) throw new Error(`Plugin package ${name} uses an unsupported tarball specifier: ${specifier}`)
  if (typeof version !== 'string' || version.trim() === '') throw new Error(`Plugin package ${name} has no installed version`)
  return `${name}@${version}`
}

function packageRootFromEntry(entry, expectedName) {
  let current = resolve(dirname(entry))
  while (true) {
    const manifestPath = join(current, 'package.json')
    const manifest = readOptionalJson(manifestPath)
    if (manifest?.name === expectedName) return { root: current, manifest }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function packageInfo(profileDir, name) {
  const requireFromProfile = createRequire(join(resolve(profileDir), 'package.json'))
  let entry
  try {
    entry = requireFromProfile.resolve(`${name}/package.json`)
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error?.code !== 'MODULE_NOT_FOUND') throw error
    // Packages that hide their manifest must expose a module entry to locate it.
    try {
      entry = requireFromProfile.resolve(name)
    } catch (entryError) {
      throw new Error(`Plugin package ${name} is not installed in ${profileDir}: ${entryError instanceof Error ? entryError.message : String(entryError)}`)
    }
  }
  const info = packageRootFromEntry(entry, name)
  if (info === undefined) throw new Error(`Cannot locate package.json for plugin package ${name}`)
  return info
}

function profileManifest(profileDir) {
  return readJson(join(resolve(profileDir), 'package.json'), 'DSH profile package.json')
}

function profilePackagePlugin(manifest) {
  return manifest?.dsh?.bundle?.patch !== undefined || manifest?.dsh?.client !== undefined
}

function profilePackageBundle(manifest) {
  return manifest?.dsh?.bundle?.patch !== undefined
}

function normalizeRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Plugin record must be an object')
  const name = record.name
  const specifier = record.specifier
  if (typeof name !== 'string' || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/.test(name) || isOfficialPackage(name)) throw new Error(`Plugin name is not portable: ${String(name)}`)
  if (typeof specifier !== 'string' || specifier.trim() === '') throw new Error(`Plugin ${name} needs a specifier`)
  const version = typeof record.version === 'string' && record.version.trim() !== '' ? record.version : null
  const source = typeof record.source === 'string' && record.source.trim() !== '' ? record.source : sourceKind(specifier)
  const repositoryOwner = githubRepositoryOwner(specifier.trim())
  const author = typeof record.author === 'string' && record.author.trim() !== '' ? record.author.trim() : repositoryOwner
  const upstreamRepository = githubRepositorySlug(record.upstreamRepository, name)
  if ((source === 'github' || /^(?:git\+|github:)/.test(specifier)) && !isSupportedGitSpecifier(specifier)) {
    throw new Error(`Git plugin package ${name} must pin a 40-character commit`)
  }
  if (/^(?:link:|file:|workspace:)/.test(specifier)) throw new Error(`Plugin package ${name} uses a local-only specifier`)
  if (/^https?:\/\//.test(specifier)) throw new Error(`Plugin package ${name} uses an unsupported tarball specifier`)
  if (!/^(?:git\+|github:)/.test(specifier) && (version === null || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version) || specifier !== `${name}@${version}`)) {
    throw new Error(`Registry plugin package ${name} must use its exact recorded name and version`)
  }
  if (record.repositoryOwner !== undefined && record.repositoryOwner !== repositoryOwner) throw new Error(`Plugin package ${name} repository owner does not match its specifier`)
  if (upstreamRepository !== null && (typeof record.author !== 'string' || record.author.trim() === '')) throw new Error(`Plugin package ${name} with an upstream repository must record its original author`)
  return {
    name,
    specifier: specifier.trim(),
    version,
    source,
    repositoryOwner,
    ...(author === null ? {} : { author }),
    ...(upstreamRepository === null ? {} : { upstreamRepository }),
    description: typeof record.description === 'string' ? record.description : '',
  }
}

export function manifestPath(repositoryPath) {
  return join(resolve(repositoryPath), 'config', THIRD_PARTY_MANIFEST_FILENAME)
}

/** Return the restart-pending marker for a profile whose plugins changed. */
export function restartMarkerPath(profileDir) {
  return join(resolve(profileDir), RESTART_MARKER_FILENAME)
}

/** Record that a user deferred an already-required restart. */
export function deferRestart(profileDir, profile = 'web') {
  const safeProfile = profileName(profile)
  writeJsonAtomically(restartMarkerPath(profileDir), {
    profile: safeProfile,
    deferredAt: new Date().toISOString(),
    note: 'Restart required for installed updates to take effect.',
  })
}

export function emptyThirdPartyManifest(profile = 'web') {
  return { schemaVersion: THIRD_PARTY_MANIFEST_SCHEMA_VERSION, profile: profileName(profile), plugins: [] }
}

export function readThirdPartyManifest(path, profile = 'web') {
  if (!existsSync(path)) return emptyThirdPartyManifest(profile)
  const value = readJson(path, 'Plugin manifest')
  if (value.schemaVersion !== THIRD_PARTY_MANIFEST_SCHEMA_VERSION) throw new Error(`Unsupported plugin manifest schema: ${String(value.schemaVersion)}`)
  if (value.profile !== undefined && !profilesShareEnvironment(value.profile, profile)) throw new Error(`Plugin manifest profile does not match ${profile}`)
  if (!Array.isArray(value.plugins)) throw new Error('Plugin manifest plugins must be an array')
  const plugins = value.plugins.map(normalizeRecord)
  const names = new Set()
  for (const plugin of plugins) {
    if (names.has(plugin.name)) throw new Error(`Plugin is listed more than once: ${plugin.name}`)
    names.add(plugin.name)
  }
  return { schemaVersion: THIRD_PARTY_MANIFEST_SCHEMA_VERSION, profile: profileName(profile), plugins }
}

/** Read direct profile dependencies that contribute a DSH bundle or browser client. */
export function readInstalledThirdPartyPlugins(profileDir, { includeManager = false } = {}) {
  const manifest = profileManifest(profileDir)
  const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }
  return Object.entries(dependencies)
    .filter(([name]) => !isOfficialPackage(name) && (includeManager || name !== PRIVATE_PLUGIN_PACKAGE_NAME))
    .map(([name, requested]) => {
      const info = packageInfo(profileDir, name)
      if (!profilePackagePlugin(info.manifest)) return null
      return {
        name,
        requested: typeof requested === 'string' ? requested : '',
        version: typeof info.manifest.version === 'string' ? info.manifest.version : null,
        source: sourceKind(typeof requested === 'string' ? requested : ''),
        description: typeof info.manifest.description === 'string' ? info.manifest.description : '',
        author: packageAuthor(info.manifest),
        upstreamRepository: githubRepositorySlug(info.manifest?.dsh?.upstreamRepository, name),
        bundle: profilePackageBundle(info.manifest),
        client: info.manifest?.dsh?.client !== undefined,
      }
    })
    .filter(value => value !== null)
}

/** Validate installed sources and build a portable manifest without writing files. */
export function prepareThirdPartyPlugins({ profileDir, profile = 'web' }) {
  const installed = readInstalledThirdPartyPlugins(profileDir, { includeManager: true })
  const plugins = installed.map(plugin => {
    const specifier = portableSpecifier(plugin.name, plugin.requested, plugin.version)
    const repositoryOwner = githubRepositoryOwner(specifier)
    const author = plugin.author ?? repositoryOwner
    return {
      name: plugin.name,
      specifier,
      version: plugin.version,
      source: sourceKind(specifier),
      ...(repositoryOwner === null ? {} : { repositoryOwner }),
      ...(author === null ? {} : { author }),
      ...(plugin.upstreamRepository === null ? {} : { upstreamRepository: plugin.upstreamRepository }),
      description: plugin.description,
    }
  })
  return { schemaVersion: THIRD_PARTY_MANIFEST_SCHEMA_VERSION, profile: profileName(profile), plugins }
}

/** Export the validated installed plugin manifest. */
export function exportThirdPartyPlugins(options) {
  const manifest = prepareThirdPartyPlugins(options)
  const path = manifestPath(options.repositoryPath)
  writeJsonAtomically(path, manifest)
  return { manifestPath: path, ...manifest }
}

/** Record the plugin set successfully shared or installed on this computer. */
export function recordPluginBaseline({ profileDir, repositoryPath, profile = 'web' }) {
  const manifest = readThirdPartyManifest(manifestPath(repositoryPath), profile)
  if (!existsSync(manifestPath(repositoryPath))) throw new Error('Cannot record a missing plugin manifest')
  writeJsonAtomically(join(resolve(profileDir), PLUGIN_BASELINE_FILENAME), manifest)
}

/** Preserve unowned plugins and reject remote deletions of locally changed plugins. */
function staleManagedPlugins(profileDir, installed, desiredNames, profile) {
  const path = join(resolve(profileDir), PLUGIN_BASELINE_FILENAME)
  const baseline = existsSync(path) ? readThirdPartyManifest(path, profile).plugins : []
  return installed.filter(plugin => {
    if (plugin.name === PRIVATE_PLUGIN_PACKAGE_NAME) return false
    if (desiredNames.has(plugin.name)) return false
    const previous = baseline.find(record => record.name === plugin.name)
    if (previous === undefined) return false
    const requested = sourceKind(previous.specifier) === 'github' ? previous.specifier : previous.version
    if (plugin.requested !== requested || plugin.version !== previous.version) {
      throw new Error(`插件 ${plugin.name} 在本机已修改，但远端已删除；请先解决冲突，未更改安装。`)
    }
    return true
  }).map(plugin => plugin.name)
}

function run(command, args, { cwd, env = process.env, spawnCommand = spawn } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnCommand(command, args, { cwd, env, shell: false, windowsHide: true })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk.toString() })
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    child.once('error', rejectRun)
    child.once('close', (exitCode, signal) => resolveRun({ ok: exitCode === 0, exitCode, signal, output: output.trim() }))
  })
}

function resolveSourceRoot(sourceRoot = '', env = process.env) {
  const candidate = sourceRoot.trim() !== '' ? sourceRoot : (env.DSH_SOURCE_ROOT?.trim() || process.cwd())
  const resolved = resolve(candidate)
  if (!existsSync(join(resolved, 'apps', 'cli', 'src', 'bin.ts'))) throw new Error(`Official DSH source root is not configured or is invalid: ${resolved}`)
  return resolved
}

function packageManagerCommand() {
  return 'pnpm'
}

/** Source-launched profiles must resolve official interfaces from the same DSH checkout. */
export function alignOfficialRuntime(profileDir, sourceRoot, packageManifests = []) {
  const overrides = {}
  const official = new Map()
  const add = directory => {
    const path = join(directory, 'package.json')
    if (!existsSync(path)) return
    const manifest = readJson(path, 'Official package')
    if (manifest.name?.startsWith(OFFICIAL_PACKAGE_PREFIX)) {
      overrides[manifest.name] = `link:${directory.replaceAll('\\', '/')}`
      official.set(manifest.name, manifest)
    }
  }
  for (const group of ['packages', 'vendor']) {
    const root = join(sourceRoot, group)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = join(root, entry.name)
      if (group === 'vendor') add(directory)
      else for (const child of readdirSync(directory, { withFileTypes: true })) if (child.isDirectory()) add(join(directory, child.name))
    }
  }
  const path = join(profileDir, 'pnpm-workspace.yaml')
  const profile = profileManifest(profileDir)
  const required = new Set()
  const visit = manifest => {
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (!official.has(name) || required.has(name)) continue
      required.add(name)
      visit(official.get(name))
    }
  }
  for (const name of Object.keys(profile.dependencies ?? {})) {
    if (isOfficialPackage(name)) continue
    try { visit(packageInfo(profileDir, name).manifest) } catch (error) {
      if (!String(error.message).includes('not installed')) throw error
    }
  }
  for (const manifest of packageManifests) visit(manifest)
  // Removed upstream packages must not survive a source-runtime upgrade.
  for (const name of Object.keys(profile.dependencies ?? {})) {
    if (isOfficialPackage(name) && !official.has(name)) delete profile.dependencies[name]
  }
  for (const name of required) profile.dependencies[name] = overrides[name]
  writeJsonAtomically(join(profileDir, 'package.json'), profile)
  const config = existsSync(path) ? parse(readFileSync(path, 'utf8')) : { packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false }
  const retainedOverrides = Object.fromEntries(Object.entries(config.overrides ?? {}).filter(([name]) => !isOfficialPackage(name) || official.has(name)))
  const next = stringify({ ...config, overrides: { ...retainedOverrides, ...overrides } })
  if (existsSync(path) && readFileSync(path, 'utf8') === next) return false
  writeFileSync(path, next)
  return true
}

function restoreExactDependencySpecifiers(profileDir, plugins) {
  const path = join(resolve(profileDir), 'package.json')
  const manifest = readJson(path, 'DSH profile package.json')
  if (manifest.dependencies === null || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) throw new Error('DSH profile package.json dependencies must be an object')
  for (const plugin of plugins) {
    manifest.dependencies[plugin.name] = sourceKind(plugin.specifier) === 'github' ? plugin.specifier : plugin.version
  }
  writeJsonAtomically(path, manifest)
}

/** Refuse source-CLI mutations of a Desktop-owned profile. */
export function requireDesktopManager(manager) {
  if (typeof manager?.installBundle !== 'function' || typeof manager?.removeBundle !== 'function') {
    throw new Error('Desktop synchronization requires the application-owned pluginManager; source CLI installation is not supported')
  }
}

async function withExactDesktopVersions(profileDir, operation) {
  const path = join(profileDir, 'pnpm-workspace.yaml')
  const original = existsSync(path) ? readFileSync(path, 'utf8') : null
  const before = original === null ? {} : parse(original)
  if (before === null || typeof before !== 'object' || Array.isArray(before)) throw new Error('Desktop pnpm workspace settings must be an object')
  writeFileSync(path, stringify({ ...before, saveExact: true }))
  try { return await operation() } finally {
    const after = parse(readFileSync(path, 'utf8'))
    if (after === null || typeof after !== 'object' || Array.isArray(after)) throw new Error('Desktop installer left invalid workspace settings; recovery record retained')
    if (Object.hasOwn(before, 'saveExact')) after.saveExact = before.saveExact
    else delete after.saveExact
    if (isDeepStrictEqual(after, before)) {
      if (original === null) unlinkSync(path)
      else writeFileSync(path, original)
    } else writeFileSync(path, stringify(after))
  }
}

async function changeDesktopBundle(manager, action, name, specifier, profileDir) {
  const result = await withExactDesktopVersions(profileDir, () => action === 'add'
    ? manager.installBundle(specifier, { enabled: false })
    : manager.removeBundle(name))
  if (!['applied', 'restart-required'].includes(result.application)) {
    throw new Error(`Desktop plugin ${action} ${name} failed: ${result.error?.diagnostic ?? result.error?.code ?? result.packageResult?.output ?? result.application}`)
  }
  if (action === 'add' && result.bundle !== name) throw new Error(`Desktop installer returned an unexpected bundle for ${name}`)
  if (action === 'add') await retainDesktopGitSource(profileDir, name, specifier)
  return { name, action, ok: true, application: result.application }
}

/** Restore a fixed GitHub spec only when pnpm's direct lock record proves that exact repository and commit. */
export async function retainDesktopGitSource(profileDir, name, specifier) {
  const expected = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9a-f]{40})$/i.exec(specifier)
  if (expected === null) return
  const manifestPath = join(profileDir, 'package.json')
  await withFileLock(manifestPath, async () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const recorded = manifest.dependencies?.[name]
    if (recorded === specifier) return
    const repository = `https://github.com/${expected[1]}.git`
    if (recorded !== `git+${repository}`) throw new Error(`Desktop installer changed the Git source for ${name}`)
    const lockPath = join(profileDir, 'pnpm-lock.yaml')
    const document = parseDocument(readFileSync(lockPath, 'utf8'))
    if (document.errors.length) throw new Error('Desktop installer left an invalid lockfile')
    const lock = document.toJS()
    const direct = lock.importers?.['.']?.dependencies?.[name]
    const pinned = `git+${repository}#${expected[2]}`
    const resolution = lock.packages?.[`${name}@${pinned}`]?.resolution
    if (direct?.specifier !== recorded || typeof direct.version !== 'string' ||
      !(direct.version === pinned || direct.version.startsWith(pinned + '(')) ||
      resolution?.type !== 'git' || resolution.repo !== repository || resolution.commit !== expected[2]) {
      throw new Error(`Desktop lockfile does not prove the fixed Git commit for ${name}`)
    }
    manifest.dependencies[name] = specifier
    document.setIn(['importers', '.', 'dependencies', name, 'specifier'], specifier)
    await writeFileAtomic(lockPath, document.toString(), { mode: 0o600 })
    await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  })
}

/** Install the manifest's plugins and remove stale profile plugins. */
async function applyThirdPartyPlugins({ profileDir, repositoryPath, sourceRoot = '', profile = 'web', spawnCommand = spawn, packageManifests = [], desktopManager }) {
  const safeProfile = profileName(profile)
  if (!existsSync(manifestPath(repositoryPath))) throw new Error('Plugin manifest is missing; no plugins were changed')
  const manifest = readThirdPartyManifest(manifestPath(repositoryPath), safeProfile)
  const installed = readInstalledThirdPartyPlugins(profileDir, { includeManager: true })
  const desiredNames = new Set(manifest.plugins.map(plugin => plugin.name))
  const changed = manifest.plugins.filter(plugin => {
    const current = installed.find(item => item.name === plugin.name)
    return current === undefined || current.version !== plugin.version || current.requested !== (sourceKind(plugin.specifier) === 'github' ? plugin.specifier : plugin.version)
  })
  const removed = staleManagedPlugins(profileDir, installed, desiredNames, safeProfile)
  if (changed.length === 0 && removed.length === 0) {
    recordPluginBaseline({ profileDir, repositoryPath, profile: safeProfile })
    return { manifestPath: manifestPath(repositoryPath), profile: safeProfile, plugins: readInstalledThirdPartyPlugins(profileDir), commands: [], restartRequired: existsSync(restartMarkerPath(profileDir)) }
  }
  if (safeProfile === 'desktop') {
    const commands = []
    for (const plugin of changed) {
      commands.push(await changeDesktopBundle(desktopManager, 'add', plugin.name, plugin.specifier, profileDir))
      const installed = readInstalledThirdPartyPlugins(profileDir, { includeManager: true }).find(item => item.name === plugin.name)
      if (installed?.version !== plugin.version || installed.requested !== (sourceKind(plugin.specifier) === 'github' ? plugin.specifier : plugin.version)) throw new Error(`Desktop plugin ${plugin.name} did not retain its exact recorded version and source`)
    }
    for (const name of removed) commands.push(await changeDesktopBundle(desktopManager, 'remove', name, undefined, profileDir))
    writeJsonAtomically(restartMarkerPath(profileDir), { profile: safeProfile, requestedAt: new Date().toISOString() })
    recordPluginBaseline({ profileDir, repositoryPath, profile: safeProfile })
    return { manifestPath: manifestPath(repositoryPath), profile: safeProfile, plugins: readInstalledThirdPartyPlugins(profileDir), commands, restartRequired: true }
  }
  const dshSourceRoot = resolveSourceRoot(sourceRoot)
  alignOfficialRuntime(profileDir, dshSourceRoot, packageManifests)
  const env = { ...process.env, DSH_HOME: dirname(dirname(resolve(profileDir))) }
  const commands = []
  // pnpm 11 can reinterpret installed source links as registry versions during add.
  // Resolve against an empty modules directory; the final frozen install owns node_modules.
  if (existsSync(join(profileDir, '.dsh-resolution-modules'))) throw new Error('Dependency resolution directory must be empty and absent')
  for (const plugin of changed) {
    const result = await run(packageManagerCommand(), ['--dir', dshSourceRoot, 'dsh', 'plugin', '--profile', safeProfile, 'add', '--lockfile-only', '--modules-dir', '.dsh-resolution-modules', '--save-exact', plugin.specifier], { spawnCommand, env })
    commands.push({ name: plugin.name, action: 'add', ...result })
    if (!result.ok) throw new Error(`安装插件 ${plugin.name} 失败：${result.output || `exit ${String(result.exitCode)}`}`)
  }
  for (const name of removed) {
    const result = await run(packageManagerCommand(), ['--dir', dshSourceRoot, 'dsh', 'plugin', '--profile', safeProfile, 'remove', '--lockfile-only', '--config.modules-dir=.dsh-resolution-modules', name], { spawnCommand, env })
    commands.push({ name, action: 'remove', ...result })
    if (!result.ok) throw new Error(`移除插件 ${name} 失败：${result.output || `exit ${String(result.exitCode)}`}`)
  }
  restoreExactDependencySpecifiers(profileDir, manifest.plugins)
  const lockfile = await run(packageManagerCommand(), ['--dir', profileDir, 'install', '--lockfile-only', '--modules-dir', '.dsh-resolution-modules'], { spawnCommand })
  commands.push({ name: 'profile', action: 'lockfile', ...lockfile })
  if (!lockfile.ok) throw new Error(`固定插件安装来源失败：${lockfile.output || `exit ${String(lockfile.exitCode)}`}`)
  const detachedRoot = join(profileDir, '.dsh-detached-links', randomUUID())
  for (const current of installed) {
    if (!/^(?:link:|file:)/.test(current.requested) || (!changed.some(plugin => plugin.name === current.name) && !removed.includes(current.name))) continue
    const entry = join(profileDir, 'node_modules', current.name)
    if (!existsSync(entry) || !lstatSync(entry).isSymbolicLink()) continue
    // Move the junction itself so installation cannot write into the developer checkout.
    const saved = join(detachedRoot, current.name)
    mkdirSync(dirname(saved), { recursive: true })
    renameSync(entry, saved)
  }
  const installation = await run(packageManagerCommand(), ['--dir', dshSourceRoot, 'dsh', 'plugin', '--profile', safeProfile, 'install', '--frozen-lockfile'], { spawnCommand, env })
  commands.push({ name: 'profile', action: 'install', ...installation })
  if (!installation.ok) throw new Error(`应用插件锁文件失败：${installation.output || `exit ${String(installation.exitCode)}`}`)
  const restartMarker = restartMarkerPath(profileDir)
  writeFileSync(restartMarker, `${JSON.stringify({ profile: safeProfile, requestedAt: new Date().toISOString() })}\n`)
  recordPluginBaseline({ profileDir, repositoryPath, profile: safeProfile })
  return { manifestPath: manifestPath(repositoryPath), profile: safeProfile, plugins: readInstalledThirdPartyPlugins(profileDir), commands, restartRequired: true }
}

const RESTORE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', PLUGIN_BASELINE_FILENAME, RESTART_MARKER_FILENAME]

async function preflightGitPlugins(profileDir, plugins, installed, spawnCommand) {
  const manifests = []
  for (const plugin of plugins) {
    if (sourceKind(plugin.specifier) !== 'github') continue
    const current = installed.find(item => item.name === plugin.name)
    if (current?.requested === plugin.specifier && current.version === plugin.version) continue
    const hash = createHash('sha256').update(plugin.specifier).digest('hex')
    const cache = join(profileDir, '.dsh-plugin-cache', hash)
    mkdirSync(cache, { recursive: true })
    const [source, commit] = plugin.specifier.split('#')
    const url = source.startsWith('github:') ? `https://github.com/${source.slice(7)}.git` : source.slice(4)
    for (const args of [['init', '--quiet', cache], ['-C', cache, 'fetch', '--quiet', '--depth=1', url, commit]]) {
      const result = await run('git', args, { spawnCommand })
      if (!result.ok) throw new Error(`插件 ${plugin.name} 来源不可读取；尚未修改安装：${result.output}`)
    }
    const result = await run('git', ['-C', cache, 'show', `${commit}:package.json`], { spawnCommand })
    if (!result.ok) throw new Error(`插件 ${plugin.name} 提交缺少 package.json`)
    const manifest = JSON.parse(result.output)
    if (manifest.name !== plugin.name || manifest.version !== plugin.version) throw new Error(`插件 ${plugin.name} 的名称或版本与 Git 提交不符`)
    manifests.push(manifest)
  }
  return manifests
}

function restoreProfileFiles(profileDir, previous, filenames = RESTORE_FILES) {
  for (const filename of filenames) {
    const path = join(profileDir, filename)
    const contents = previous[filename]
    if (contents === null) {
      if (existsSync(path)) unlinkSync(path)
    } else {
      writeFileSync(path, contents, { mode: 0o600 })
    }
  }
}

/** Serialize plugin installation and restore the previous profile after failure or interruption. */
export async function syncThirdPartyPlugins(options) {
  const profileDir = resolve(options.profileDir)
  const desktop = profileName(options.profile ?? 'web') === 'desktop'
  if (desktop) requireDesktopManager(options.desktopManager)
  // Reject missing input before creating operation records or profile directories.
  if (!options.restoreOnly) {
    if (!existsSync(manifestPath(options.repositoryPath))) throw new Error('Plugin manifest is missing; no plugins were changed')
    readThirdPartyManifest(manifestPath(options.repositoryPath), options.profile ?? 'web')
  }
  const lockPath = join(profileDir, '.dsh-plugin-sync.lock')
  const release = await lockfile.lock(profileDir, { lockfilePath: lockPath })
  const journalPath = join(profileDir, '.dsh-plugin-operation.json')
  const restore = async journal => {
    if (journal.schemaVersion !== 1 || (journal.installationRequired !== undefined && typeof journal.installationRequired !== 'boolean') || RESTORE_FILES.some(name => typeof journal.previous?.[name] !== 'string' && journal.previous?.[name] !== null)) {
      throw new Error('Plugin recovery record is invalid; the profile was not changed')
    }
    if (desktop) {
      if (!Array.isArray(journal.desktopTargets) || journal.desktopTargets.some(name => typeof name !== 'string' || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/.test(name) || isOfficialPackage(name))
        || !Array.isArray(journal.desktopPrevious) || journal.desktopPrevious.some(item => typeof item?.name !== 'string' || typeof item?.version !== 'string')) {
        throw new Error('Desktop plugin recovery targets are invalid; the profile was not changed')
      }
      const saved = JSON.parse(journal.previous['package.json']).dependencies ?? {}
      if (saved === null || typeof saved !== 'object' || Array.isArray(saved)
        || new Set(journal.desktopTargets).size !== journal.desktopTargets.length
        || new Set(journal.desktopPrevious.map(item => item.name)).size !== journal.desktopPrevious.length
        || journal.desktopTargets.some(name => saved[name] !== undefined && (typeof saved[name] !== 'string' || !journal.desktopPrevious.some(item => item.name === name && item.version !== '')))) {
        throw new Error('Desktop plugin recovery dependencies are invalid; the profile was not changed')
      }
      restoreProfileFiles(profileDir, journal.previous, ['pnpm-workspace.yaml'])
      for (const name of [...journal.desktopTargets].reverse()) {
        const current = profileManifest(profileDir).dependencies?.[name]
        if (saved[name] === undefined) {
          if (current !== undefined) await changeDesktopBundle(options.desktopManager, 'remove', name, undefined, profileDir)
        } else {
          const installed = current === undefined ? undefined : packageInfo(profileDir, name).manifest
          const previousRecord = journal.desktopPrevious?.find(item => item.name === name)
          if (current === saved[name] && installed?.version === previousRecord?.version) continue
          const specifier = /^(?:git\+|github:)/.test(saved[name]) ? saved[name] : `${name}@${previousRecord.version}`
          await changeDesktopBundle(options.desktopManager, 'add', name, specifier, profileDir)
        }
      }
      restoreProfileFiles(profileDir, journal.previous)
      writeJsonAtomically(journalPath, { ...journal, state: 'restored' })
      return
    }
    restoreProfileFiles(profileDir, journal.previous)
    // A completed no-op changed only sync metadata; node_modules needs no installer.
    // Interrupted and older records retain the conservative installation path.
    if (journal.installationRequired === false) {
      writeJsonAtomically(journalPath, { ...journal, state: 'restored' })
      return
    }
    const sourceRoot = resolveSourceRoot(options.sourceRoot ?? '')
    const restored = await run(packageManagerCommand(), ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', profileName(options.profile ?? 'web'), 'install', journal.previous['pnpm-lock.yaml'] === null ? '--no-frozen-lockfile' : '--frozen-lockfile'], {
      spawnCommand: options.spawnCommand ?? spawn,
      env: { ...process.env, DSH_HOME: dirname(dirname(profileDir)) },
    })
    if (!restored.ok) throw new Error(`插件恢复失败，恢复记录已保留：${restored.output || restored.exitCode}`)
    // The official installer may normalize bundle metadata; preserve the saved configuration.
    restoreProfileFiles(profileDir, journal.previous)
    writeJsonAtomically(journalPath, { ...journal, state: 'restored' })
  }
  try {
    assertNoPendingTakeover(profileDir)
    const pending = existsSync(journalPath) ? readJson(journalPath, 'Plugin operation') : null
    if (options.restoreOnly) {
      if (pending !== null && (options.operationId === undefined || pending.operationId === options.operationId)) {
        try { await restore(pending) } catch (error) {
          writeJsonAtomically(journalPath, { ...pending, state: 'restore-failed' })
          throw error
        }
      }
      return { restored: pending !== null }
    }
    if (pending?.state === 'applying' || pending?.state === 'restore-failed') await restore(pending)
    // Validate source and deletion conflicts before saving a new recovery point.
    const installed = readInstalledThirdPartyPlugins(profileDir)
    const manifest = readThirdPartyManifest(manifestPath(options.repositoryPath), options.profile ?? 'web')
    staleManagedPlugins(profileDir, installed, new Set(manifest.plugins.map(plugin => plugin.name)), options.profile ?? 'web')
    const packageManifests = await preflightGitPlugins(profileDir, manifest.plugins, readInstalledThirdPartyPlugins(profileDir, { includeManager: true }), options.spawnCommand ?? spawn)
    const previous = Object.fromEntries(RESTORE_FILES.map(name => [name, existsSync(join(profileDir, name)) ? readFileSync(join(profileDir, name), 'utf8') : null]))
    const desktopInstalled = desktop ? readInstalledThirdPartyPlugins(profileDir, { includeManager: true }) : []
    const desktopTargets = desktop ? [...new Set([
      ...manifest.plugins.filter(plugin => {
        const current = desktopInstalled.find(item => item.name === plugin.name)
        return current === undefined || current.version !== plugin.version || current.requested !== (sourceKind(plugin.specifier) === 'github' ? plugin.specifier : plugin.version)
      }).map(plugin => plugin.name),
      ...staleManagedPlugins(profileDir, installed, new Set(manifest.plugins.map(plugin => plugin.name)), 'desktop'),
    ])] : undefined
    const journal = { schemaVersion: 1, state: 'applying', operationId: options.operationId ?? null, startedAt: new Date().toISOString(), previous,
      ...(desktop ? { desktopTargets, desktopPrevious: desktopInstalled.map(({ name, version }) => ({ name, version })) } : {}),
    }
    writeJsonAtomically(journalPath, journal)
    try {
      const result = await applyThirdPartyPlugins({ ...options, packageManifests })
      writeJsonAtomically(journalPath, { ...journal, state: 'succeeded', installationRequired: result.commands.length > 0 })
      return result
    } catch (error) {
      try {
        await restore(journal)
      } catch (restoreError) {
        writeJsonAtomically(journalPath, { ...journal, state: 'restore-failed' })
        throw new AggregateError([error, restoreError], '插件应用失败，自动恢复未完成；再次拉取将先重试恢复。')
      }
      throw error
    }
  } finally {
    await release()
  }
}

/** Read the committed manifest beside the currently installed profile plugins. */
export function inspectThirdPartyPlugins({ profileDir, repositoryPath, profile = 'web' }) {
  const safeProfile = profileName(profile)
  const path = manifestPath(repositoryPath)
  const manifest = readThirdPartyManifest(path, safeProfile)
  const installed = readInstalledThirdPartyPlugins(profileDir, { includeManager: true })
  const installedByName = new Map(installed.map(plugin => [plugin.name, plugin]))
  return {
    manifestPath: path,
    configured: existsSync(path),
    plugins: manifest.plugins.map(plugin => ({ ...plugin, installed: installedByName.get(plugin.name) ?? null })),
    installed,
    extra: installed.filter(plugin => !manifest.plugins.some(record => record.name === plugin.name)),
  }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = argument('--mode')
  const dshHome = argument('--dsh-home')
  const repository = argument('--repository')
  const sourceRoot = argument('--source-root') ?? ''
  if ((mode !== 'Export' && mode !== 'Import') || dshHome === undefined || repository === undefined) {
    throw new Error('Usage: node sync-third-party-plugins.mjs --mode <Export|Import> --dsh-home <path> --repository <path> [--source-root <path>]')
  }
  const profile = argument('--profile') ?? 'web'
  const profileDir = join(resolve(dshHome), 'profiles', profileName(profile))
  const result = mode === 'Export'
    ? exportThirdPartyPlugins({ profileDir, repositoryPath: repository, profile })
    : await syncThirdPartyPlugins({ profileDir, repositoryPath: repository, sourceRoot, profile })
  console.log(`${mode === 'Export' ? 'Recorded' : 'Synchronized'} DSH plugins: ${result.plugins.length}`)
}
