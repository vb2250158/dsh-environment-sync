/** Synchronize one DSH environment through a separate private data directory. */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument, stringify } from 'yaml'

export const PRIVATE_ENVIRONMENT_SCHEMA_VERSION = 1
export const PRIVATE_SYNC_KEY_FILENAME = 'private-sync.key'
export const PRIVATE_SYNC_LOCAL_SETTINGS_FILENAME = 'private-sync.local.yaml'
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function parseMapping(source, description) {
  const document = parseDocument(source)
  if (document.errors.length > 0) throw new Error(`${description} is not valid YAML: ${document.errors[0].message}`)
  const value = document.toJS()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${description} must contain a top-level YAML mapping`)
  }
  return value
}

function requireProfile(profile) {
  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)) {
    throw new TypeError('Private environment profile must contain only letters, numbers, underscores, and hyphens')
  }
  return profile
}

function isInside(parent, candidate) {
  const value = relative(parent, candidate)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

/** Resolve a private data directory and reject the public plugin source tree. */
export function resolvePrivateDataRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('Private data directory is required')
  if (!isAbsolute(value)) throw new TypeError('Private data directory must be an absolute path')
  const path = resolve(value)
  if (isInside(PACKAGE_ROOT, path)) throw new Error('Private data directory must be outside the public plugin repository')
  return path
}

/** Return every synchronized file for one profile. */
export function privateEnvironmentPaths(dataRootPath, profile = 'web') {
  const root = resolvePrivateDataRoot(dataRootPath)
  const safeProfile = requireProfile(profile)
  return Object.freeze({
    root,
    manifest: join(root, 'environment.json'),
    settings: join(root, 'settings.yaml'),
    instructions: join(root, 'AGENTS.md'),
    homePatch: join(root, 'cordis.patch.yml'),
    profilePatch: join(root, 'profiles', safeProfile, 'cordis.patch.yml'),
    credentials: join(root, 'credentials.enc.json'),
    thirdParty: join(root, 'config', 'plugins.json'),
  })
}

async function readText(path, required = false) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return ''
    throw error
  }
}

async function writeAtomic(path, contents, mode) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.private-sync.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) })
  await rename(temporary, path)
}

async function copyOptional(source, target) {
  const contents = await readText(source)
  if (contents === '') return false
  await writeAtomic(target, contents)
  return true
}

function deepMerge(base, overlay) {
  if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) return overlay
  const result = base !== null && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(overlay)) result[key] = deepMerge(result[key], value)
  return result
}

function encryptionKey(dshHomePath, supplied) {
  if (typeof supplied === 'string' && supplied !== '') return supplied
  if (typeof process.env.DSH_PRIVATE_SYNC_KEY === 'string' && process.env.DSH_PRIVATE_SYNC_KEY !== '') return process.env.DSH_PRIVATE_SYNC_KEY
  const path = join(resolve(dshHomePath), PRIVATE_SYNC_KEY_FILENAME)
  if (existsSync(path)) return readFileSyncText(path).trim()
  const generated = randomBytes(32).toString('base64url')
  writeFileSync(path, `${generated}\n`, { encoding: 'utf8', mode: 0o600 })
  return generated
}

function readFileSyncText(path) {
  return readFileSync(path, 'utf8')
}

/** Encrypt a credentials document for storage in the private data repository. */
export function encryptCredentials(contents, secret) {
  if (typeof secret !== 'string' || secret === '') throw new TypeError('Private sync encryption key is required')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(secret, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(contents, 'utf8'), cipher.final()])
  return {
    schemaVersion: 1,
    algorithm: 'aes-256-gcm+scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

/** Decrypt a credentials document from the private data repository. */
export function decryptCredentials(payload, secret) {
  if (payload?.schemaVersion !== 1 || payload?.algorithm !== 'aes-256-gcm+scrypt') throw new TypeError('Unsupported private credentials document')
  if (typeof secret !== 'string' || secret === '') throw new TypeError('Private sync encryption key is required')
  const key = scryptSync(secret, Buffer.from(payload.salt, 'base64'), 32)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

function profileInventory(manifest) {
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const dependencies = manifest?.dependencies !== null && typeof manifest?.dependencies === 'object'
    ? Object.entries(manifest.dependencies).map(([name, specifier]) => ({ name, specifier }))
    : []
  return { bundles, dependencies }
}

/** Export complete portable DSH configuration into a separate private data directory. */
export async function exportPrivateEnvironment({ dshHomePath, dataRootPath, profile = 'web', encryptionSecret } = {}) {
  const dshHome = resolve(dshHomePath || join(homedir(), '.dsh'))
  const safeProfile = requireProfile(profile)
  const paths = privateEnvironmentPaths(dataRootPath, safeProfile)
  const profileDir = join(dshHome, 'profiles', safeProfile)
  const settingsSource = await readText(join(dshHome, 'settings.yaml'), true)
  parseMapping(settingsSource, 'DSH settings')
  const profileManifest = JSON.parse(await readText(join(profileDir, 'package.json'), true))
  const inventory = profileInventory(profileManifest)

  await writeAtomic(paths.settings, settingsSource)
  const included = {
    instructions: await copyOptional(join(dshHome, 'AGENTS.md'), paths.instructions),
    homePatch: await copyOptional(join(dshHome, 'cordis.patch.yml'), paths.homePatch),
    profilePatch: await copyOptional(join(profileDir, 'cordis.patch.yml'), paths.profilePatch),
  }

  const credentialsSource = await readText(join(dshHome, '.credentials.yaml'))
  let credentials = false
  if (credentialsSource !== '') {
    const secret = encryptionKey(dshHome, encryptionSecret)
    let unchanged = false
    if (existsSync(paths.credentials)) {
      const existing = JSON.parse(await readText(paths.credentials, true))
      unchanged = decryptCredentials(existing, secret) === credentialsSource
    }
    if (!unchanged) await writeAtomic(paths.credentials, `${JSON.stringify(encryptCredentials(credentialsSource, secret), null, 2)}
`, 0o600)
    credentials = true
  }

  const manifest = {
    schemaVersion: PRIVATE_ENVIRONMENT_SCHEMA_VERSION,
    profile: safeProfile,
    bundles: inventory.bundles,
    dependencies: inventory.dependencies,
    settingsNamespaces: Object.keys(parseMapping(settingsSource, 'DSH settings')).sort(),
    included: { settings: true, credentials, ...included },
  }
  await writeAtomic(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
  return { action: 'exported', paths, manifest }
}

/** Import complete DSH configuration and then apply an optional machine-local settings overlay. */
export async function importPrivateEnvironment({ dshHomePath, dataRootPath, profile = 'web', encryptionSecret } = {}) {
  const dshHome = resolve(dshHomePath || join(homedir(), '.dsh'))
  const safeProfile = requireProfile(profile)
  const paths = privateEnvironmentPaths(dataRootPath, safeProfile)
  const profileDir = join(dshHome, 'profiles', safeProfile)
  const manifest = JSON.parse(await readText(paths.manifest, true))
  if (manifest.schemaVersion !== PRIVATE_ENVIRONMENT_SCHEMA_VERSION || manifest.profile !== safeProfile) {
    throw new TypeError('Private environment manifest does not match the requested profile')
  }

  const snapshotSettings = parseMapping(await readText(paths.settings, true), 'Private DSH settings')
  const localOverlaySource = await readText(join(dshHome, PRIVATE_SYNC_LOCAL_SETTINGS_FILENAME))
  const localOverlay = localOverlaySource === '' ? {} : parseMapping(localOverlaySource, 'Machine-local DSH settings overlay')
  await writeAtomic(join(dshHome, 'settings.yaml'), stringify(deepMerge(snapshotSettings, localOverlay)))

  const imported = {
    instructions: await copyOptional(paths.instructions, join(dshHome, 'AGENTS.md')),
    homePatch: await copyOptional(paths.homePatch, join(dshHome, 'cordis.patch.yml')),
    profilePatch: await copyOptional(paths.profilePatch, join(profileDir, 'cordis.patch.yml')),
  }

  let credentials = false
  if (existsSync(paths.credentials)) {
    const payload = JSON.parse(await readText(paths.credentials, true))
    const secret = encryptionKey(dshHome, encryptionSecret)
    await writeAtomic(join(dshHome, '.credentials.yaml'), decryptCredentials(payload, secret), 0o600)
    credentials = true
  }
  return { action: 'imported', paths, manifest, imported: { settings: true, credentials, ...imported } }
}

/** Export or import a private DSH environment. */
export async function synchronizePrivateEnvironment(options) {
  if (options?.mode === 'Export') return exportPrivateEnvironment(options)
  if (options?.mode === 'Import') return importPrivateEnvironment(options)
  throw new TypeError(`Unsupported private environment synchronization mode: ${String(options?.mode)}`)
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await synchronizePrivateEnvironment({
    mode: argument('--mode'),
    dshHomePath: argument('--dsh-home'),
    dataRootPath: argument('--data-root'),
    profile: argument('--profile') ?? 'web',
  })
  console.log(JSON.stringify(result))
}
