/** Record and reproduce portable DSH profile plugins. */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const THIRD_PARTY_MANIFEST_FILENAME = 'plugins.json'
export const THIRD_PARTY_MANIFEST_SCHEMA_VERSION = 2
export const PRIVATE_PLUGIN_PACKAGE_NAME = 'dsh-environment-sync'
export const RESTART_MARKER_FILENAME = '.dsh-restart-required'
const OFFICIAL_PACKAGE_PREFIX = '@deepseek-ai/'
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function profileName(value) {
  if (typeof value !== 'string' || !PROFILE_NAME_PATTERN.test(value)) throw new TypeError('Plugin profile must contain only letters, numbers, underscores, and hyphens')
  return value
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
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, path)
}

function isOfficialPackage(name) {
  return name === PRIVATE_PLUGIN_PACKAGE_NAME || name.startsWith(OFFICIAL_PACKAGE_PREFIX)
}

function isSupportedGitSpecifier(specifier) {
  if (/^git\+https:\/\//.test(specifier)) return /#([0-9a-f]{40})$/i.test(specifier)
  if (/^github:/.test(specifier)) return /#([0-9a-f]{40})$/i.test(specifier)
  return false
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
    entry = requireFromProfile.resolve(name)
  } catch (error) {
    throw new Error(`Plugin package ${name} is not installed in ${profileDir}: ${error instanceof Error ? error.message : String(error)}`)
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
  if (typeof name !== 'string' || name.trim() === '' || isOfficialPackage(name)) throw new Error(`Plugin name is not portable: ${String(name)}`)
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

/** Return the one-shot restart marker for a profile whose plugins changed. */
export function restartMarkerPath(profileDir) {
  return join(resolve(profileDir), RESTART_MARKER_FILENAME)
}

export function emptyThirdPartyManifest(profile = 'web') {
  return { schemaVersion: THIRD_PARTY_MANIFEST_SCHEMA_VERSION, profile: profileName(profile), plugins: [] }
}

export function readThirdPartyManifest(path, profile = 'web') {
  if (!existsSync(path)) return emptyThirdPartyManifest(profile)
  const value = readJson(path, 'Plugin manifest')
  if (value.schemaVersion !== THIRD_PARTY_MANIFEST_SCHEMA_VERSION) throw new Error(`Unsupported plugin manifest schema: ${String(value.schemaVersion)}`)
  if (value.profile !== undefined && value.profile !== profileName(profile)) throw new Error(`Plugin manifest profile does not match ${profile}`)
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
export function readInstalledThirdPartyPlugins(profileDir) {
  const manifest = profileManifest(profileDir)
  const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }
  return Object.entries(dependencies)
    .filter(([name]) => !isOfficialPackage(name))
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

/** Export exact portable public plugin records from the active profile. */
export function exportThirdPartyPlugins({ profileDir, repositoryPath, profile = 'web' }) {
  const installed = readInstalledThirdPartyPlugins(profileDir)
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
  const path = manifestPath(repositoryPath)
  const manifest = { schemaVersion: THIRD_PARTY_MANIFEST_SCHEMA_VERSION, profile: profileName(profile), plugins }
  writeJsonAtomically(path, manifest)
  return { manifestPath: path, ...manifest }
}

function run(command, args, { cwd, spawnCommand = spawn } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnCommand(command, args, { cwd, shell: process.platform === 'win32', windowsHide: true })
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

function restoreExactDependencySpecifiers(profileDir, plugins) {
  const path = join(resolve(profileDir), 'package.json')
  const manifest = readJson(path, 'DSH profile package.json')
  if (manifest.dependencies === null || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) throw new Error('DSH profile package.json dependencies must be an object')
  for (const plugin of plugins) {
    manifest.dependencies[plugin.name] = sourceKind(plugin.specifier) === 'github' ? plugin.specifier : plugin.version
  }
  writeJsonAtomically(path, manifest)
}

/** Install the manifest's plugins and remove stale profile plugins. */
export async function syncThirdPartyPlugins({ profileDir, repositoryPath, sourceRoot = '', profile = 'web', spawnCommand = spawn }) {
  const safeProfile = profileName(profile)
  const manifest = readThirdPartyManifest(manifestPath(repositoryPath), safeProfile)
  const installed = readInstalledThirdPartyPlugins(profileDir)
  const installedNames = new Set(installed.map(plugin => plugin.name))
  const desiredNames = new Set(manifest.plugins.map(plugin => plugin.name))
  const dshSourceRoot = resolveSourceRoot(sourceRoot)
  const commands = []
  for (const plugin of manifest.plugins) {
    const result = await run(packageManagerCommand(), ['--dir', dshSourceRoot, 'dsh', 'plugin', '--profile', safeProfile, 'add', '--save-exact', plugin.specifier], { spawnCommand })
    commands.push({ name: plugin.name, action: 'add', ...result })
    if (!result.ok) throw new Error(`安装插件 ${plugin.name} 失败：${result.output || `exit ${String(result.exitCode)}`}`)
  }
  for (const name of installedNames) {
    if (desiredNames.has(name)) continue
    const result = await run(packageManagerCommand(), ['--dir', dshSourceRoot, 'dsh', 'plugin', '--profile', safeProfile, 'remove', name], { spawnCommand })
    commands.push({ name, action: 'remove', ...result })
    if (!result.ok) throw new Error(`移除插件 ${name} 失败：${result.output || `exit ${String(result.exitCode)}`}`)
  }
  restoreExactDependencySpecifiers(profileDir, manifest.plugins)
  const lockfile = await run(packageManagerCommand(), ['--dir', profileDir, 'install', '--lockfile-only'], { spawnCommand })
  commands.push({ name: 'profile', action: 'lockfile', ...lockfile })
  if (!lockfile.ok) throw new Error(`固定插件安装来源失败：${lockfile.output || `exit ${String(lockfile.exitCode)}`}`)
  const restartMarker = restartMarkerPath(profileDir)
  writeFileSync(restartMarker, `${JSON.stringify({ profile: safeProfile, requestedAt: new Date().toISOString() })}\n`)
  return { manifestPath: manifestPath(repositoryPath), profile: safeProfile, plugins: readInstalledThirdPartyPlugins(profileDir), commands, restartRequired: true }
}

/** Read the committed manifest beside the currently installed profile plugins. */
export function inspectThirdPartyPlugins({ profileDir, repositoryPath, profile = 'web' }) {
  const safeProfile = profileName(profile)
  const path = manifestPath(repositoryPath)
  const manifest = readThirdPartyManifest(path, safeProfile)
  const installed = readInstalledThirdPartyPlugins(profileDir)
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
