import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import {
  decryptCredentials,
  encryptCredentials,
  exportPrivateEnvironment,
  importPrivateEnvironment,
  privateEnvironmentPaths,
  resolvePrivateDataRoot,
} from '../scripts/private-environment-sync.mjs'

async function write(path, contents) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents)
}

for (const [from, to] of [['web', 'desktop'], ['desktop', 'web']]) {
  test(`${from} 设置可导入 ${to}：主题和模型共用，目标端口、会话及来源文件保持不变`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cross-profile-'))
    const source = join(root, 'source'), target = join(root, 'target'), data = join(root, 'data')
    try {
      await write(join(source, `profiles/${from}/package.json`), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
      await write(join(source, `profiles/${from}/cordis.patch.yml`), '- id: ui-theme\n  config:\n    preference: dark\n- id: agent-default-model\n  config:\n    model: fixture-model\n- id: webserver\n  config:\n    port: 3180\n')
      await exportPrivateEnvironment({ dshHomePath: source, dataRootPath: data, profile: from, encryptionSecret: 'fixture-key' })
      const original = await readFile(join(data, `profiles/${from}/cordis.patch.yml`), 'utf8')
      await write(join(target, `profiles/${to}/cordis.patch.yml`), '- id: webserver\n  config:\n    port: 0\n')
      await write(join(target, 'sessions/fixture.json'), '{"id":"original-session"}\n')
      await importPrivateEnvironment({ dshHomePath: target, dataRootPath: data, profile: to, encryptionSecret: 'fixture-key' })
      const patch = parse(await readFile(join(target, `profiles/${to}/cordis.patch.yml`), 'utf8'))
      assert.equal(patch.find(row => row.id === 'ui-theme').config.preference, 'dark')
      assert.equal(patch.find(row => row.id === 'agent-default-model').config.model, 'fixture-model')
      assert.equal(patch.find(row => row.id === 'webserver').config.port, 0)
      assert.equal(await readFile(join(data, `profiles/${from}/cordis.patch.yml`), 'utf8'), original)
      assert.equal(await readFile(join(target, 'sessions/fixture.json'), 'utf8'), '{"id":"original-session"}\n')
      await assert.rejects(readFile(join(target, 'settings.yaml')), { code: 'ENOENT' })
      await assert.rejects(importPrivateEnvironment({ dshHomePath: target, dataRootPath: data, profile: 'headless', encryptionSecret: 'fixture-key' }), /does not match/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('新版配置从 profile 导出并保留本机路径，不重新创建 settings.yaml', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-config-'))
  const home = join(root, 'home'), target = join(root, 'target'), data = join(root, 'data')
  try {
    await write(join(home, 'profiles/web/package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
    await write(join(home, 'profiles/web/cordis.patch.yml'), '- id: chat-enhancement\n  config:\n    language: zh\n- id: nas-workspace-support\n  config:\n    openPluginsRoot: C:/source-machine\n')
    const exported = await exportPrivateEnvironment({ dshHomePath: home, dataRootPath: data, encryptionSecret: 'test-key' })
    assert.equal(exported.manifest.settingsStorage, 'profile-config')
    assert.doesNotMatch(await readFile(join(data, 'profiles/web/cordis.patch.yml'), 'utf8'), /source-machine/)
    await write(join(target, 'profiles/web/cordis.patch.yml'), '- id: nas-workspace-support\n  config:\n    openPluginsRoot: C:/target-machine\n- id: webserver\n  config:\n    port: 3199\n')
    await importPrivateEnvironment({ dshHomePath: target, dataRootPath: data, encryptionSecret: 'test-key' })
    const patch = parse(await readFile(join(target, 'profiles/web/cordis.patch.yml'), 'utf8'))
    assert.equal(patch.find(row => row.id === 'chat-enhancement').config.language, 'zh')
    assert.equal(patch.find(row => row.id === 'nas-workspace-support').config.openPluginsRoot, 'C:/target-machine')
    assert.equal(patch.find(row => row.id === 'webserver').config.port, 3199)
    await assert.rejects(readFile(join(target, 'settings.yaml')), { code: 'ENOENT' })
    await write(join(data, 'settings.yaml'), 'llm-provider-visibility:\n  hiddenProviders: [legacy]\nagent-presets:\n  default: coding\nui-onboarding:\n  welcomeNoticeVersion: 1\njev-context-gate:\n  enabled: false\nprivate-theme-blue:\n  selected: blue\n')
    await importPrivateEnvironment({ dshHomePath: target, dataRootPath: data, encryptionSecret: 'test-key' })
    const migrated = parse(await readFile(join(target, 'profiles/web/cordis.patch.yml'), 'utf8'))
    assert.deepEqual(migrated.find(row => row.id === 'provider-visibility').config.hiddenProviders, ['legacy'])
    assert.equal(migrated.find(row => row.id === 'agent-preset-registry').config.selectedDefault, 'coding')
    assert.equal(migrated.some(row => row.id === 'agent-presets'), false)
    assert.equal(migrated.find(row => row.id === 'ui-settings-general').config.welcomeNoticeVersion, 1)
    assert.equal(migrated.find(row => row.id === 'dsh-jev-context-gate').config.enabled, false)
    assert.equal(migrated.some(row => row.id === 'private-theme-blue'), false)
    await write(join(home, 'profiles/web/cordis.patch.yml'), 'invalid: mapping\n')
    await assert.rejects(exportPrivateEnvironment({ dshHomePath: home, dataRootPath: data, encryptionSecret: 'test-key' }), /Profile patch must be an array/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('私有环境导出记录完整设置、插件组合、启停补丁和加密凭据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-private-environment-'))
  const home = join(root, 'home')
  const data = join(root, 'data')
  try {
    await write(join(home, 'settings.yaml'), 'plugin-a:\n  enabled: true\n  endpoint: https://private.example\nplugin-b:\n  mode: full\n')
    await write(join(home, 'AGENTS.md'), '# 私有环境规则\n')
    await write(join(home, 'cordis.patch.yml'), '- id: global\n  config:\n    enabled: true\n')
    await write(join(home, '.credentials.yaml'), 'credential:\n  kind: api-key\n  key: secret-value\n')
    await write(join(home, 'profiles', 'web', 'cordis.patch.yml'), '- id: plugin-a\n  disabled: false\n')
    await write(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { 'dsh-private-plugins': 'github:owner/plugins#0123456789012345678901234567890123456789', 'third-party-bundle': '1.2.3' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-private-plugins', 'third-party-bundle'] } },
    }))

    const result = await exportPrivateEnvironment({ dshHomePath: home, dataRootPath: data, profile: 'web', encryptionSecret: 'test-key' })
    assert.deepEqual(result.manifest.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-private-plugins', 'third-party-bundle'])
    assert.equal(result.manifest.dependencies.length, 2)
    assert.deepEqual(result.manifest.settingsNamespaces, ['plugin-a', 'plugin-b'])
    assert.equal(result.manifest.included.credentials, true)
    assert.equal(await readFile(join(data, 'settings.yaml'), 'utf8'), await readFile(join(home, 'settings.yaml'), 'utf8'))
    const firstCredentials = await readFile(join(data, 'credentials.enc.json'), 'utf8')
    assert.doesNotMatch(firstCredentials, /secret-value/)
    await exportPrivateEnvironment({ dshHomePath: home, dataRootPath: data, profile: 'web', encryptionSecret: 'test-key' })
    assert.equal(await readFile(join(data, 'credentials.enc.json'), 'utf8'), firstCredentials)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('私有环境导入恢复完整配置并保留本机覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-private-environment-import-'))
  const source = join(root, 'source')
  const target = join(root, 'target')
  const data = join(root, 'data')
  try {
    await write(join(source, 'settings.yaml'), 'plugin-a:\n  enabled: true\n  path: C:/shared\nplugin-b:\n  mode: full\n')
    await write(join(source, 'AGENTS.md'), '# 同步规则\n')
    await write(join(source, '.credentials.yaml'), 'credential:\n  key: secret-value\n')
    await write(join(source, 'profiles', 'web', 'cordis.patch.yml'), '- id: plugin-a\n  disabled: true\n')
    await write(join(source, 'profiles', 'web', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-private-plugins'] } }, dependencies: {} }))
    await exportPrivateEnvironment({ dshHomePath: source, dataRootPath: data, encryptionSecret: 'test-key' })

    await write(join(target, 'private-sync.local.yaml'), 'plugin-a:\n  path: D:/this-machine\n')
    await write(join(target, 'profiles', 'web', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-private-plugins'] } }, dependencies: {} }))
    const result = await importPrivateEnvironment({ dshHomePath: target, dataRootPath: data, encryptionSecret: 'test-key' })
    assert.deepEqual(parse(await readFile(join(target, 'settings.yaml'), 'utf8')), {
      'plugin-a': { enabled: true, path: 'D:/this-machine' },
      'plugin-b': { mode: 'full' },
    })
    assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), '# 同步规则\n')
    assert.equal(await readFile(join(target, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), '- id: plugin-a\n  disabled: true\n')
    assert.match(await readFile(join(target, '.credentials.yaml'), 'utf8'), /secret-value/)
    assert.equal(result.imported.credentials, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('凭据密文需要同一个同步密钥', () => {
  const payload = encryptCredentials('secret', 'correct')
  assert.equal(decryptCredentials(payload, 'correct'), 'secret')
  assert.throws(() => decryptCredentials(payload, 'wrong'))
})

test('错误密钥不会覆盖已有设置或提示词', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preflight-'))
  const source = join(root, 'source')
  const target = join(root, 'target')
  const data = join(root, 'data')
  try {
    await write(join(source, 'settings.yaml'), 'plugin: remote\n')
    await write(join(source, 'AGENTS.md'), 'remote instructions\n')
    await write(join(source, '.credentials.yaml'), 'credential: synthetic\n')
    await write(join(source, 'profiles', 'web', 'package.json'), '{}')
    await exportPrivateEnvironment({ dshHomePath: source, dataRootPath: data, encryptionSecret: 'correct' })
    await write(join(target, 'settings.yaml'), 'plugin: local\n')
    await write(join(target, 'AGENTS.md'), 'local instructions\n')
    await assert.rejects(importPrivateEnvironment({ dshHomePath: target, dataRootPath: data, encryptionSecret: 'wrong' }))
    assert.equal(await readFile(join(target, 'settings.yaml'), 'utf8'), 'plugin: local\n')
    assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), 'local instructions\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('未包含凭据的快照不会恢复残留密文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stale-credentials-'))
  const source = join(root, 'source')
  const target = join(root, 'target')
  const data = join(root, 'data')
  try {
    await write(join(source, 'settings.yaml'), 'plugin: remote\n')
    await write(join(source, 'profiles', 'web', 'package.json'), '{}')
    await exportPrivateEnvironment({ dshHomePath: source, dataRootPath: data })
    const manifestPath = join(data, 'environment.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.included.credentials = false
    await write(manifestPath, JSON.stringify(manifest))
    await write(join(data, 'credentials.enc.json'), JSON.stringify(encryptCredentials('credential: old\n', 'key')))
    const result = await importPrivateEnvironment({ dshHomePath: target, dataRootPath: data })
    assert.equal(result.imported.credentials, false)
    await assert.rejects(readFile(join(target, '.credentials.yaml')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('订阅凭据加密恢复，删除后同步不会复活，机器资料配置保留在目标电脑', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-account-sync-'))
  const source = join(root, 'source'), target = join(root, 'target'), data = join(root, 'data')
  const options = { dshHomePath: source, dataRootPath: data, encryptionSecret: 'fixture-key' }
  try {
    await write(join(source, 'profiles', 'web', 'package.json'), '{}')
    await write(join(source, 'settings.yaml'), 'emotional-chat-workbench:\n  libraryRoot: A:/private\n  bindings: [private-session]\nui-theme:\n  preference: blue\n')
    await write(join(source, 'plugins', 'subscriptions', 'auth.json'), '{"codex":{"accessToken":"fixture-token"}}')
    await write(join(target, 'settings.yaml'), 'emotional-chat-workbench:\n  libraryRoot: B:/private\n')
    await exportPrivateEnvironment(options)
    assert.equal((await readFile(join(data, 'credentials.enc.json'), 'utf8')).includes('fixture-token'), false)
    assert.equal((await readFile(join(data, 'settings.yaml'), 'utf8')).includes('private-session'), false)
    await importPrivateEnvironment({ ...options, dshHomePath: target })
    assert.equal(JSON.parse(await readFile(join(target, 'plugins', 'subscriptions', 'auth.json'), 'utf8')).codex.accessToken, 'fixture-token')
    assert.equal(parse(await readFile(join(target, 'settings.yaml'), 'utf8'))['emotional-chat-workbench'].libraryRoot, 'B:/private')
    await rm(join(source, 'plugins', 'subscriptions', 'auth.json'))
    await exportPrivateEnvironment(options)
    await importPrivateEnvironment({ ...options, dshHomePath: target })
    await assert.rejects(readFile(join(target, 'plugins', 'subscriptions', 'auth.json')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('私有数据目录不能位于公开插件仓库内', () => {
  assert.throws(() => resolvePrivateDataRoot(join(process.cwd(), 'config', 'private-data')), /outside the public plugin repository/)
  const external = join(tmpdir(), 'dsh-private-data')
  assert.equal(resolvePrivateDataRoot(external), external)
  assert.equal(privateEnvironmentPaths(external, 'web').thirdParty, join(external, 'config', 'plugins.json'))
})

test('本机覆盖字段不会再次进入共享快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-export-'))
  const home = join(root, 'home')
  const data = join(root, 'data')
  try {
    await write(join(home, 'settings.yaml'), 'plugin:\n  path: D:/local\n  enabled: true\n')
    await write(join(home, 'private-sync.local.yaml'), 'plugin:\n  path: D:/local\n')
    await write(join(home, 'profiles', 'web', 'package.json'), '{}')
    await exportPrivateEnvironment({ dshHomePath: home, dataRootPath: data })
    assert.deepEqual(parse(await readFile(join(data, 'settings.yaml'), 'utf8')), { plugin: { enabled: true } })
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), 'plugin:\n  path: D:/local\n  enabled: true\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
