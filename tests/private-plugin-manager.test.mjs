import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  PRIVATE_PLUGIN_PACKAGE_NAME,
  PrivatePluginManager,
  normalizeRepositoryConfig,
  privatePluginEnablement,
  readPrivatePluginStatus,
  readRepositoryConfig,
  resolvePrivatePluginProfileDir,
  runProcess,
  validateProfileName,
  writePrivatePluginEnabled,
  writeRepositoryConfig,
} from '../lib/private-plugin-manager.js'

function temporaryHome() { return mkdtempSync(join(tmpdir(), 'dsh-environment-sync-')) }
function writePackage(profileDir, name, version) {
  const directory = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
}
function profile(home) {
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: {
      [PRIVATE_PLUGIN_PACKAGE_NAME]: 'github:vb2250158/dsh-environment-sync#1111111111111111111111111111111111111111',
      'dsh-theme-blue': 'github:vb2250158/dsh-theme-blue#2222222222222222222222222222222222222222',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PRIVATE_PLUGIN_PACKAGE_NAME, 'dsh-theme-blue'] } },
  }))
  writePackage(dir, PRIVATE_PLUGIN_PACKAGE_NAME, '0.3.0')
  writePackage(dir, 'dsh-theme-blue', '0.1.0-rc.8.6')
  return dir
}

test('私有仓库配置只保存数据仓库和本地配置目录', () => {
  const home = temporaryHome()
  try {
    profile(home)
    const value = writeRepositoryConfig(home, 'web', {
      dataRemoteUrl: 'https://github.com/example/dsh-private-data',
      dataLocalPath: 'C:/Data/Private Data',
      remoteUrl: 'https://github.com/example/ignored-source',
      localPath: 'C:/ignored',
    })
    assert.deepEqual(value, {
      dataRemoteUrl: 'https://github.com/example/dsh-private-data',
      dataLocalPath: resolve('C:/Data/Private Data'),
    })
    assert.deepEqual(readRepositoryConfig(home), value)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'profiles', 'web', 'private-plugin-repository.json'), 'utf8')), value)
    assert.throws(() => normalizeRepositoryConfig({ dataRemoteUrl: 'git@example.com:x/y', dataLocalPath: 'C:/Data' }), /valid HTTPS URL/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('状态从 profile 已安装包读取每个独立插件版本', () => {
  const home = temporaryHome()
  try {
    profile(home)
    const status = readPrivatePluginStatus({ dshHome: home })
    assert.equal(status.package.name, 'dsh-environment-sync')
    assert.equal(status.package.installedVersion, '0.3.0')
    assert.equal(status.plugins.length, 12)
    assert.equal(status.plugins.find(plugin => plugin.packageName === 'dsh-theme-blue').localVersion, '0.1.0-rc.8.6')
    assert.equal(status.plugins.find(plugin => plugin.packageName === 'dsh-theme-blue').author, 'vb2250158')
    assert.equal(status.plugins.find(plugin => plugin.packageName === 'dsh-gpt-web-search').installed, false)
    assert.equal(status.plugins.find(plugin => plugin.packageName === 'dsh-environment-sync').manageable, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('启停状态只写 profile 管理区块', () => {
  const home = temporaryHome()
  try {
    profile(home)
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
    writePrivatePluginEnabled(home, 'web', 'ui-theme-blue', false)
    const state = privatePluginEnablement(home, 'web', 'ui-theme-blue')
    assert.equal(state.enabled, false)
    assert.equal(state.overrideSource, 'private-manager')
    assert.match(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), /id: ui-theme-blue[\s\S]*disabled: true/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('Host Remote 只暴露配置、启停和私有环境同步操作', () => {
  const manager = new PrivatePluginManager(new Context())
  assert.deepEqual(remoteMethods(manager).map(item => item.method), [
    'status', 'configure', 'setEnabled', 'cloneData', 'publishData', 'syncData', 'recordThirdParty', 'syncThirdParty',
  ])
})

test('profile 名称不能穿越 DSH home', () => {
  assert.throws(() => validateProfileName('../web'), TypeError)
  assert.equal(resolvePrivatePluginProfileDir('C:/dsh-home', 'web'), join('C:/dsh-home', 'profiles', 'web'))
})

test('子进程输出会裁剪为可显示的诊断摘要', async () => {
  const spawnCommand = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      child.stdout.emit('data', `prefix-${'x'.repeat(1300)}`)
      child.stderr.emit('data', '-tail')
      child.emit('close', 0, null)
    })
    return child
  }
  const result = await runProcess('example', [], { spawnCommand })
  assert.equal(result.ok, true)
  assert.equal(result.output.length, 1202)
  assert.match(result.output, /-tail\n…$/)
})
