import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const dshHome = resolve(process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh'))
const profileRequire = createRequire(join(dshHome, 'profiles', 'web', 'package.json'))
const { validateTypertManifest } = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-typert-loader')).href)
const { TYPERT } = await import(new URL('../lib/typert.host.js', import.meta.url))

test('插件管理器提供 DSH 网关可发现的 Host Remote 描述', () => {
  const manifest = validateTypertManifest('dsh-plugin-manager', TYPERT)
  assert.deepEqual(manifest.invocations.map(item => item.method), ['status', 'configure', 'setEnabled', 'cloneData', 'publishData', 'syncData', 'recordThirdParty', 'syncThirdParty'])
  assert.ok(manifest.invocations.every(item => item.service === 'privatePluginManager'))
})
