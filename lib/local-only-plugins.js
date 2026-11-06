/** Machine declarations stay in private-sync.local.yaml and never enter shared snapshots. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

/** Read local package/entry ownership together with the existing machine settings mask. */
export function readMachineLocalSettings(home) {
  const path = join(home, 'private-sync.local.yaml')
  const source = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const document = parseDocument(source === '' ? '{}' : source)
  const value = document.toJS()
  if (document.errors.length || value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Machine-local DSH settings overlay must be a YAML mapping')
  const { localOnlyPlugins = [], ...settings } = value
  if (!Array.isArray(localOnlyPlugins)) throw new TypeError('private-sync.local.yaml localOnlyPlugins must be an array')
  const names = new Set(), entryIds = new Set()
  const plugins = localOnlyPlugins.map(row => {
    if (row === null || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => key !== 'name' && key !== 'entryIds') ||
      typeof row.name !== 'string' || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/.test(row.name) || row.name.startsWith('@deepseek-ai/') || row.name === 'dsh-environment-sync' || names.has(row.name) ||
      !Array.isArray(row.entryIds) || row.entryIds.some(id => typeof id !== 'string' || id.trim() === '' || id !== id.trim()) || new Set(row.entryIds).size !== row.entryIds.length) {
      throw new TypeError('private-sync.local.yaml localOnlyPlugins needs unique nonofficial package names and explicit entryIds arrays')
    }
    names.add(row.name)
    for (const id of row.entryIds) entryIds.add(id)
    return { name: row.name, entryIds: [...row.entryIds] }
  })
  const settingsMask = { ...settings, localOnlyPlugins: null, ...Object.fromEntries([...entryIds].map(id => [id, null])) }
  return { plugins, names, entryIds, settings, settingsMask }
}

/** Keep or remove explicitly declared entry IDs, including rows inside insert patches. */
export function selectLocalPatchRows(rows, localOnly, local) {
  if (!Array.isArray(rows)) throw new TypeError('Profile patch must be an array')
  return rows.flatMap(row => {
    if (localOnly.entryIds.has(row?.id) || (typeof row?.name === 'string' && [...localOnly.names].some(name => row.name === name || row.name.startsWith(name + '/')))) return local ? [row] : []
    if (Array.isArray(row?.insert)) {
      const insert = selectLocalPatchRows(row.insert, localOnly, local)
      return insert.length ? [{ ...row, insert }] : []
    }
    return local ? [] : [row]
  })
}
