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

test('私有数据目录不能位于公开插件仓库内', () => {
  assert.throws(() => resolvePrivateDataRoot(join(process.cwd(), 'config', 'private-data')), /outside the public plugin repository/)
  const external = join(tmpdir(), 'dsh-private-data')
  assert.equal(resolvePrivateDataRoot(external), external)
  assert.equal(privateEnvironmentPaths(external, 'web').thirdParty, join(external, 'config', 'plugins.json'))
})
