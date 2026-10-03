/** Portable user presets retain their directory layout and per-file Git history. */
import { lstat, readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'

const ROOT = '.agent-presets'
export const AGENT_PRESET_BASELINE_FILENAME = '.dsh-agent-presets-sync-baseline.json'
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/
const EXCLUDED = new Set(['.git', 'node_modules', '.env', '.credentials.yaml', 'private-sync.key', 'sessions', 'attachments', 'logs'])

/** Accept only portable files inside one user preset, excluding private runtime data. */
export function isAgentPresetPath(path) {
  if (typeof path !== 'string' || path.includes('\\')) return false
  const parts = path.split('/')
  return parts.length >= 3 && parts[0] === ROOT && PRESET_ID.test(parts[1]) && parts.slice(2).every(part =>
    part !== '' && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !/^\.env(?:\.|$)/i.test(part) && !EXCLUDED.has(part.toLowerCase()))
}

/** Refuse symlinks and non-directory ancestors before reading, writing or deleting presets. */
export async function assertAgentPresetLocation(root, path) {
  if (!isAgentPresetPath(path)) throw new Error('Invalid agent preset file path')
  const parts = path.split('/')
  for (let index = 1; index <= parts.length; index++) {
    let entry
    try { entry = await lstat(join(root, ...parts.slice(0, index))) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (entry.isSymbolicLink() || (index < parts.length ? !entry.isDirectory() : !entry.isFile())) {
      throw new Error(`Agent preset file cannot use links or special files: ${path}`)
    }
  }
}

function validateInventory(inventory) {
  if (!inventory || !Array.isArray(inventory.files) || !Array.isArray(inventory.deleted)) throw new Error('Missing agent preset inventory')
  const paths = inventory.files.map(entry => entry?.path)
  if (inventory.files.some(entry => !isAgentPresetPath(entry?.path) || typeof entry.executable !== 'boolean') ||
    inventory.deleted.some(path => !isAgentPresetPath(path)) || new Set([...paths, ...inventory.deleted]).size !== paths.length + inventory.deleted.length ||
    new Set([...paths, ...inventory.deleted].map(path => path.toLowerCase())).size !== paths.length + inventory.deleted.length) {
    throw new Error('Invalid agent preset inventory')
  }
  for (const id of new Set(paths.map(path => path.split('/')[1]))) {
    if (!paths.includes(`${ROOT}/${id}/agent.cordis.yml`)) throw new Error(`Agent preset composition is missing: ${id}`)
  }
  return inventory
}

function validateDefinition(path, contents) {
  const leaf = path.split('/').at(-1)
  if (path.split('/').length !== 3 || !['agent.cordis.yml', 'preset.yml'].includes(leaf)) return
  const document = parseDocument(contents.toString('utf8'))
  if (document.errors.length) throw new Error(`Invalid agent preset YAML: ${path}`)
  const value = document.toJS()
  if (leaf === 'agent.cordis.yml' ? !Array.isArray(value) : value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid agent preset definition: ${path}`)
  }
}

/** Validate incoming preset definitions, assets and explicit deletions without changing Home. */
export async function prepareAgentPresets(home, repository, inventory) {
  validateInventory(inventory)
  const writes = []
  for (const entry of inventory.files) {
    await assertAgentPresetLocation(repository, entry.path)
    await assertAgentPresetLocation(home, entry.path)
    const contents = await readFile(join(repository, entry.path))
    validateDefinition(entry.path, contents)
    writes.push({ path: join(home, entry.path), contents, mode: entry.executable ? 0o700 : 0o600 })
  }
  for (const path of inventory.deleted) {
    await assertAgentPresetLocation(home, path)
    writes.push({ path: join(home, path), contents: null })
  }
  writes.push({ path: join(home, AGENT_PRESET_BASELINE_FILENAME), contents: JSON.stringify({ schemaVersion: 1, files: inventory.files.map(entry => entry.path) }, null, 2) + '\n', mode: 0o600 })
  return writes
}

/** Export user-authored preset files; only previously inventoried files receive deletion records. */
export async function exportAgentPresets(home, repository, previous) {
  const files = []
  const sources = new Map()
  async function scan(path) {
    await assertAgentPresetLocation(home, `${path}/placeholder`)
    for (const child of await readdir(join(home, path), { withFileTypes: true })) {
      const childPath = `${path}/${child.name}`
      if (!isAgentPresetPath(childPath)) throw new Error(`Unsupported file inside agent preset: ${childPath}`)
      if (child.isDirectory()) await scan(childPath)
      else {
        await assertAgentPresetLocation(home, childPath)
        const contents = await readFile(join(home, childPath))
        validateDefinition(childPath, contents)
        files.push({ path: childPath, executable: ((await lstat(join(home, childPath))).mode & 0o100) !== 0 })
        sources.set(childPath, contents)
      }
    }
  }
  await assertAgentPresetLocation(home, `${ROOT}/placeholder/placeholder`)
  let children
  try { children = await readdir(join(home, ROOT), { withFileTypes: true }) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    children = []
  }
  for (const child of children) {
    if (!PRESET_ID.test(child.name)) continue
    if (!child.isDirectory()) throw new Error(`Agent preset must be a regular directory: ${child.name}`)
    await scan(`${ROOT}/${child.name}`)
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const previousInventory = previous === undefined ? { files: [], deleted: [] } : validateInventory(previous)
  const localFiles = files.map(entry => entry.path)
  let baseline
  try { baseline = JSON.parse(await readFile(join(home, AGENT_PRESET_BASELINE_FILENAME), 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    baseline = { schemaVersion: 1, files: [] }
  }
  if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.files) || baseline.files.some(path => !isAgentPresetPath(path))) throw new Error('Invalid local agent preset baseline')
  const managed = new Set(baseline.files)
  // An older manager can install this version without having applied the remote presets.
  for (const entry of previousInventory.files) {
    if (sources.has(entry.path) || managed.has(entry.path)) continue
    await assertAgentPresetLocation(repository, entry.path)
    const contents = await readFile(join(repository, entry.path))
    validateDefinition(entry.path, contents)
    sources.set(entry.path, contents)
    files.push(entry)
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const deleted = [...new Set([...previousInventory.files.map(entry => entry.path), ...previousInventory.deleted])].filter(path => !sources.has(path)).sort()
  const inventory = validateInventory({ files, deleted })
  for (const path of [...files.map(entry => entry.path), ...deleted]) await assertAgentPresetLocation(repository, path)
  for (const entry of files) {
    const target = join(repository, entry.path)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.private-sync.tmp`
    await writeFile(temporary, sources.get(entry.path), { mode: entry.executable ? 0o700 : 0o600 })
    await rename(temporary, target)
  }
  for (const path of deleted) await rm(join(repository, path), { force: true })
  const baselinePath = join(home, AGENT_PRESET_BASELINE_FILENAME)
  const temporary = `${baselinePath}.${process.pid}.private-sync.tmp`
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, files: localFiles }, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, baselinePath)
  return inventory
}
