import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import lockfile from 'proper-lockfile'
import { parse } from 'yaml'
import { alignOfficialRuntime, exportThirdPartyPlugins, inspectThirdPartyPlugins, PLUGIN_BASELINE_FILENAME, readInstalledThirdPartyPlugins, readThirdPartyManifest, restartMarkerPath, syncThirdPartyPlugins } from '../scripts/sync-third-party-plugins.mjs'

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

test('缺失同步清单时不启动安装或卸载命令', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-missing-manifest-'))
  let invoked = false
  try {
    await assert.rejects(syncThirdPartyPlugins({ profileDir: join(root, 'profile'), repositoryPath: root, spawnCommand() { invoked = true } }), /manifest is missing/)
    assert.equal(invoked, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function writePlugin(profileDir, name, version, { bundle = true, client = false, description = undefined, author = undefined, upstreamRepository = undefined } = {}) {
  const directory = join(profileDir, 'node_modules', ...name.split('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'index.js'), 'export {}\n')
  await writeJson(join(directory, 'package.json'), {
    name,
    version,
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    ...(!bundle && !client && upstreamRepository === undefined ? {} : { dsh: {
      ...(bundle ? { bundle: { patch: './cordis.patch.yml' } } : {}),
      ...(client ? { client: { platform: 'web', inject: [] } } : {}),
      ...(upstreamRepository === undefined ? {} : { upstreamRepository }),
    } }),
  })
}

async function writeProfile(profileDir, dependencies, bundles = []) {
  await mkdir(profileDir, { recursive: true })
  await writeJson(join(profileDir, 'package.json'), {
    name: 'dsh-profile-web',
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  })
}

function desktopManager(profileDir, calls, fail = () => false) {
  return {
    async installBundle(specifier, options) {
      assert.equal(parse(await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')).saveExact, true)
      const split = specifier.lastIndexOf('@')
      const name = specifier.slice(0, split), version = specifier.slice(split + 1)
      calls.push({ action: 'add', name, version, options })
      if (fail(name, version)) return { application: 'failed', error: { code: 'operation-error' } }
      const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
      manifest.dependencies[name] = version
      await writeJson(join(profileDir, 'package.json'), manifest)
      await writePlugin(profileDir, name, version)
      return { bundle: name, application: 'restart-required' }
    },
    async removeBundle(name) {
      calls.push({ action: 'remove', name })
      const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
      delete manifest.dependencies[name]
      await writeJson(join(profileDir, 'package.json'), manifest)
      return { application: 'applied' }
    },
  }
}

test('Desktop 复用 Web 清单并使用宿主安装器，保留官方依赖和 Web profile，不使用源码 CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-sync-'))
  const profileDir = join(root, 'profiles', 'desktop'), repositoryPath = join(root, 'private')
  const calls = []
  try {
    await writeProfile(profileDir, { '@deepseek-ai/dsh-bundle-web': '0.2.1-alpha.1', 'desktop-plugin': '1.0.0' })
    await writePlugin(profileDir, 'desktop-plugin', '1.0.0')
    await writeProfile(join(root, 'profiles', 'web'), { 'web-plugin': '9.0.0' })
    await writeJson(join(repositoryPath, 'config/plugins.json'), { schemaVersion: 2, profile: 'web', plugins: [{ name: 'desktop-plugin', version: '2.0.0', specifier: 'desktop-plugin@2.0.0' }] })
    const options = { profileDir, repositoryPath, profile: 'desktop', desktopManager: desktopManager(profileDir, calls), spawnCommand() { throw new Error('Desktop must not launch source CLI') } }
    const result = await syncThirdPartyPlugins(options)
    assert.equal(result.restartRequired, true)
    assert.deepEqual(calls, [{ action: 'add', name: 'desktop-plugin', version: '2.0.0', options: { enabled: false } }])
    assert.equal(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh-bundle-web'], '0.2.1-alpha.1')
    assert.equal(JSON.parse(await readFile(join(root, 'profiles/web/package.json'), 'utf8')).dependencies['web-plugin'], '9.0.0')
    await assert.rejects(readFile(join(profileDir, 'pnpm-workspace.yaml')), { code: 'ENOENT' })
    assert.equal((await syncThirdPartyPlugins(options)).commands.length, 0)
    assert.equal(calls.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Desktop 安装失败通过同一宿主恢复旧包和原始配置，恢复只涉及本次插件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-rollback-'))
  const profileDir = join(root, 'profiles/desktop'), repositoryPath = join(root, 'private'), calls = []
  try {
    await writeProfile(profileDir, { 'desktop-plugin': '1.0.0', 'unrelated-plugin': '3.0.0' }, ['desktop-plugin'])
    await writePlugin(profileDir, 'desktop-plugin', '1.0.0')
    await writePlugin(profileDir, 'unrelated-plugin', '3.0.0')
    const before = await readFile(join(profileDir, 'package.json'), 'utf8')
    await writeJson(join(repositoryPath, 'config/plugins.json'), { schemaVersion: 2, profile: 'desktop', plugins: [
      { name: 'desktop-plugin', version: '2.0.0', specifier: 'desktop-plugin@2.0.0' },
      { name: 'failed-plugin', version: '1.0.0', specifier: 'failed-plugin@1.0.0' },
    ] })
    await assert.rejects(syncThirdPartyPlugins({ profileDir, repositoryPath, profile: 'desktop', desktopManager: desktopManager(profileDir, calls, name => name === 'failed-plugin') }), /failed-plugin failed/)
    assert.equal(await readFile(join(profileDir, 'package.json'), 'utf8'), before)
    assert.equal(JSON.parse(await readFile(join(profileDir, 'node_modules/desktop-plugin/package.json'), 'utf8')).version, '1.0.0')
    assert.deepEqual(calls.map(({ action, name, version }) => ({ action, name, version })), [
      { action: 'add', name: 'desktop-plugin', version: '2.0.0' },
      { action: 'add', name: 'failed-plugin', version: '1.0.0' },
      { action: 'add', name: 'desktop-plugin', version: '1.0.0' },
    ])
    assert.equal(JSON.parse(await readFile(join(profileDir, '.dsh-plugin-operation.json'), 'utf8')).state, 'restored')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Desktop CLI 无宿主安装器时在创建 profile 或恢复记录之前拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-reject-'))
  const profileDir = join(root, 'profiles/desktop')
  try {
    await assert.rejects(syncThirdPartyPlugins({ profileDir, repositoryPath: root, profile: 'desktop' }), /application-owned pluginManager/)
    await assert.rejects(readFile(join(profileDir, '.dsh-plugin-operation.json')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Desktop 恢复可在新管理器实例重试，失败保留记录且不接管官方包', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-recover-'))
  const profileDir = join(root, 'profiles/desktop'), repositoryPath = join(root, 'private'), calls = []
  try {
    await writeProfile(profileDir, { 'desktop-plugin': '1.0.0' })
    await writePlugin(profileDir, 'desktop-plugin', '1.0.0')
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'saveExact: false\nnodeLinker: hoisted\n')
    await writeJson(join(repositoryPath, 'config/plugins.json'), { schemaVersion: 2, profile: 'desktop', plugins: [{ name: 'desktop-plugin', version: '2.0.0', specifier: 'desktop-plugin@2.0.0' }] })
    const options = { profileDir, repositoryPath, profile: 'desktop' }
    await syncThirdPartyPlugins({ ...options, desktopManager: desktopManager(profileDir, calls) })
    assert.equal(await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8'), 'saveExact: false\nnodeLinker: hoisted\n')
    await assert.rejects(syncThirdPartyPlugins({ ...options, restoreOnly: true, desktopManager: desktopManager(profileDir, calls, (_name, version) => version === '1.0.0') }), /failed/)
    assert.equal(JSON.parse(await readFile(join(profileDir, '.dsh-plugin-operation.json'), 'utf8')).state, 'restore-failed')
    await syncThirdPartyPlugins({ ...options, restoreOnly: true, desktopManager: desktopManager(profileDir, calls) })
    assert.equal(JSON.parse(await readFile(join(profileDir, 'node_modules/desktop-plugin/package.json'), 'utf8')).version, '1.0.0')
    const path = join(profileDir, '.dsh-plugin-operation.json')
    const record = JSON.parse(await readFile(path, 'utf8'))
    record.desktopTargets = ['@deepseek-ai/dsh-bundle-web']
    await writeJson(path, record)
    const before = calls.length
    await assert.rejects(syncThirdPartyPlugins({ ...options, restoreOnly: true, desktopManager: desktopManager(profileDir, calls) }), /targets are invalid/)
    assert.equal(calls.length, before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('升级源码运行时移除已删除官方包，保留第三方覆盖并补齐新接口依赖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-align-'))
  const profileDir = join(root, 'profile'), source = join(root, 'source')
  try {
    await writeProfile(profileDir, { '@deepseek-ai/dsh-client-runtime': 'old', 'third-party': '1.0.0' })
    await writeJson(join(source, 'packages/client/ui-slots/package.json'), { name: '@deepseek-ai/dsh-client-ui-slots', version: '0.2.1-alpha.1' })
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'overrides:\n  third-party: 1.0.0\n  "@deepseek-ai/dsh-client-runtime": old\n')
    alignOfficialRuntime(profileDir, source, [{ peerDependencies: { '@deepseek-ai/dsh-client-ui-slots': '*' } }])
    const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    assert.equal(Object.hasOwn(profile.dependencies, '@deepseek-ai/dsh-client-runtime'), false)
    assert.match(profile.dependencies['@deepseek-ai/dsh-client-ui-slots'], /^link:/)
    const workspace = await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')
    assert.doesNotMatch(workspace, /dsh-client-runtime/)
    assert.match(workspace, /third-party: 1.0.0/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('首次拉取空清单保留未接管插件，已接管插件的本机修改阻止远端删除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-ownership-'))
  const profileDir = join(root, 'profiles', 'web')
  const repositoryPath = join(root, 'private')
  let calls = 0
  const spawnCommand = () => { calls++; throw new Error('Unexpected install') }
  try {
    await writeProfile(profileDir, { 'local-plugin': '2.0.0' })
    await writePlugin(profileDir, 'local-plugin', '2.0.0')
    await writeJson(join(repositoryPath, 'config', 'plugins.json'), { schemaVersion: 2, profile: 'web', plugins: [] })
    const first = await syncThirdPartyPlugins({ profileDir, repositoryPath, spawnCommand })
    assert.deepEqual(first.plugins.map(plugin => plugin.name), ['local-plugin'])
    await writeJson(join(profileDir, PLUGIN_BASELINE_FILENAME), {
      schemaVersion: 2, profile: 'web', plugins: [{ name: 'local-plugin', version: '1.0.0', specifier: 'local-plugin@1.0.0' }],
    })
    await assert.rejects(syncThirdPartyPlugins({ profileDir, repositoryPath, spawnCommand }), /本机已修改.*远端已删除/)
    assert.equal(calls, 0)
    assert.equal(JSON.parse(await readFile(join(profileDir, PLUGIN_BASELINE_FILENAME), 'utf8')).plugins[0].version, '1.0.0')
    await writeFile(join(profileDir, PLUGIN_BASELINE_FILENAME), '{broken')
    await assert.rejects(syncThirdPartyPlugins({ profileDir, repositoryPath, spawnCommand }), /not valid JSON/)
    assert.equal(calls, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function fakePnpm(profileDir, calls) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(async () => {
      try {
        if (command === 'git') {
          if (args.includes('show')) child.stdout.emit('data', JSON.stringify({ name: 'client-only-plugin', version: '2.0.0' }))
          child.emit('close', 0, null)
          return
        }
        calls.push({ command, args, options })
        const actionIndex = args.findIndex(value => value === 'add' || value === 'remove' || value === 'install')
        const action = args[actionIndex]
        const target = args.at(-1)
        const manifestPath = join(profileDir, 'package.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        if (action === 'install') {
          child.stdout.emit('data', 'lockfile updated')
          child.emit('close', 0, null)
          return
        }
        if (action === 'add') {
          const [name, version, bundle] = target === 'example-dsh-bundle@1.2.3'
            ? ['example-dsh-bundle', '1.2.3', true]
            : target === 'git+https://github.com/community/client-only-plugin.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
              ? ['client-only-plugin', '2.0.0', false]
              : (() => { throw new Error(`Unexpected add target: ${target}`) })()
          manifest.dependencies[name] = target.startsWith('git+https:') ? target.replace(/#[0-9a-f]{40}$/i, '') : version
          if (bundle) manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles.filter(value => value !== name), name]
        } else if (action === 'remove') {
          delete manifest.dependencies[target]
          manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(value => value !== target)
        } else {
          throw new Error(`Unexpected pnpm action: ${String(action)}`)
        }
        await writeJson(manifestPath, manifest)
        child.stdout.emit('data', 'done')
        child.emit('close', 0, null)
      } catch (error) {
        child.stderr.emit('data', error instanceof Error ? error.message : String(error))
        child.emit('close', 1, null)
      }
    })
    return child
  }
}

test('安装失败恢复原 profile，恢复记录支持重试，并拒绝并发安装', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-rollback-'))
  const profileDir = join(root, 'profiles', 'web')
  const repositoryPath = join(root, 'private')
  const sourceRoot = join(root, 'official')
  const calls = []
  try {
    await writeProfile(profileDir, {})
    const original = await readFile(join(profileDir, 'package.json'), 'utf8')
    await mkdir(join(sourceRoot, 'apps', 'cli', 'src'), { recursive: true })
    await writeFile(join(sourceRoot, 'apps', 'cli', 'src', 'bin.ts'), '')
    await writeJson(join(repositoryPath, 'config', 'plugins.json'), {
      schemaVersion: 2, profile: 'web', plugins: [{ name: 'failed-plugin', version: '1.0.0', specifier: 'failed-plugin@1.0.0' }],
    })
    const options = { profileDir, repositoryPath, sourceRoot, spawnCommand: fakePnpm(profileDir, calls) }
    const release = await lockfile.lock(profileDir, { lockfilePath: join(profileDir, '.dsh-plugin-sync.lock') })
    try {
      await assert.rejects(syncThirdPartyPlugins(options), error => error.code === 'ELOCKED')
      assert.equal(calls.length, 0)
    } finally { await release() }
    await assert.rejects(syncThirdPartyPlugins(options), /安装插件 failed-plugin 失败/)
    assert.equal(await readFile(join(profileDir, 'package.json'), 'utf8'), original)
    const journalPath = join(profileDir, '.dsh-plugin-operation.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    assert.equal(journal.state, 'restored')
    assert.ok(calls.some(call => call.args.includes('--no-frozen-lockfile')))
    // Replay a process interruption with partially modified profile metadata.
    await writeJson(journalPath, { ...journal, state: 'applying' })
    await writeProfile(profileDir, { 'broken-partial-install': '1.0.0' })
    await writeJson(join(repositoryPath, 'config', 'plugins.json'), { schemaVersion: 2, profile: 'web', plugins: [] })
    await syncThirdPartyPlugins(options)
    assert.equal(await readFile(join(profileDir, 'package.json'), 'utf8'), original)
    assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).state, 'succeeded')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('安装列表识别没有根模块入口的 bundle，并支持隐藏清单的普通入口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bundle-exports-'))
  try {
    await writeProfile(root, { 'bundle-only': '1.0.0', 'hidden-manifest': '1.0.0' })
    for (const name of ['bundle-only', 'hidden-manifest']) {
      await writePlugin(root, name, '1.0.0')
      const path = join(root, 'node_modules', name, 'package.json')
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      manifest.exports = name === 'bundle-only' ? { './package.json': './package.json' } : { '.': './index.js' }
      await writeJson(path, manifest)
    }
    assert.deepEqual(readInstalledThirdPartyPlugins(root).map(plugin => plugin.name), ['bundle-only', 'hidden-manifest'])
    await writeProfile(root, { 'missing-bundle': '1.0.0' })
    assert.throws(() => readInstalledThirdPartyPlugins(root), /missing-bundle.*not installed/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('记录管理器、DSH bundle 和 client 为精确版本，并排除官方和普通依赖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-third-party-export-'))
  const profileDir = join(root, 'dsh-home', 'profiles', 'web')
  const repository = join(root, 'private')
  try {
    await writeProfile(profileDir, {
      'dsh-environment-sync': 'github:owner/manager#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '@deepseek-ai/dsh-extra': '0.1.0',
      'example-dsh-bundle': '^1.2.0',
      'client-only-plugin': 'github:community/client-only-plugin#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'ordinary-library': '^2.0.0',
    }, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-environment-sync', 'example-dsh-bundle'])
    await writePlugin(profileDir, 'dsh-environment-sync', '0.1.0')
    await writePlugin(profileDir, '@deepseek-ai/dsh-extra', '0.1.0')
    await writePlugin(profileDir, 'example-dsh-bundle', '1.2.3')
    await writePlugin(profileDir, 'client-only-plugin', '2.0.0', { bundle: false, client: true, description: 'Client contribution', author: 'original-author', upstreamRepository: 'original-author/client-only-plugin' })
    await writePlugin(profileDir, 'ordinary-library', '2.0.0', { bundle: false })

    const recorded = exportThirdPartyPlugins({ profileDir, repositoryPath: repository })
    assert.deepEqual(recorded.plugins, [{
      name: 'dsh-environment-sync',
      specifier: 'github:owner/manager#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      version: '0.1.0', source: 'github', repositoryOwner: 'owner', author: 'owner', description: '',
    }, {
      name: 'example-dsh-bundle',
      specifier: 'example-dsh-bundle@1.2.3',
      version: '1.2.3',
      source: 'registry',
      description: '',
    }, {
      name: 'client-only-plugin',
      specifier: 'github:community/client-only-plugin#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      version: '2.0.0',
      source: 'github',
      repositoryOwner: 'community',
      author: 'original-author',
      upstreamRepository: 'original-author/client-only-plugin',
      description: 'Client contribution',
    }])
    assert.deepEqual(JSON.parse(await readFile(recorded.manifestPath, 'utf8')).plugins, recorded.plugins)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('记录拒绝本机 link 插件，避免写入不能跨电脑安装的清单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-third-party-link-'))
  const profileDir = join(root, 'dsh-home', 'profiles', 'web')
  try {
    await writeProfile(profileDir, { 'local-bundle': 'link:C:/local-bundle' }, ['local-bundle'])
    await writePlugin(profileDir, 'local-bundle', '1.0.0')
    assert.throws(() => exportThirdPartyPlugins({ profileDir, repositoryPath: join(root, 'private') }), /local-only specifier/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('同步按清单调用官方插件入口，并对齐已安装插件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-third-party-import-'))
  const profileDir = join(root, 'dsh-home', 'profiles', 'web')
  const repository = join(root, 'private')
  const sourceRoot = join(root, 'official')
  const calls = []
  try {
    await writeProfile(profileDir, {
      'dsh-environment-sync': 'link:C:/private',
      'obsolete-dsh-bundle': '1.0.0',
      'obsolete-client-plugin': '1.0.0',
    }, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-environment-sync', 'obsolete-dsh-bundle'])
    await writePlugin(profileDir, 'dsh-environment-sync', '0.1.0')
    await writePlugin(profileDir, 'obsolete-dsh-bundle', '1.0.0')
    await writePlugin(profileDir, 'obsolete-client-plugin', '1.0.0', { bundle: false, client: true })
    await writeJson(join(profileDir, PLUGIN_BASELINE_FILENAME), {
      schemaVersion: 2, profile: 'web', plugins: ['obsolete-dsh-bundle', 'obsolete-client-plugin'].map(name => ({ name, version: '1.0.0', specifier: `${name}@1.0.0` })),
    })
    await writePlugin(profileDir, 'example-dsh-bundle', '1.2.3')
    await writePlugin(profileDir, 'client-only-plugin', '2.0.0', { bundle: false, client: true })
    await mkdir(join(sourceRoot, 'apps', 'cli', 'src'), { recursive: true })
    await writeFile(join(sourceRoot, 'apps', 'cli', 'src', 'bin.ts'), '')
    await writeJson(join(repository, 'config', 'plugins.json'), {
      schemaVersion: 2,
      profile: 'web',
      plugins: [{
        name: 'example-dsh-bundle',
        specifier: 'example-dsh-bundle@1.2.3',
        version: '1.2.3',
        source: 'registry',
        description: '',
      }, {
        name: 'client-only-plugin',
        specifier: 'git+https://github.com/community/client-only-plugin.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        version: '2.0.0',
        source: 'github',
        repositoryOwner: 'community',
        author: 'original-author',
        upstreamRepository: 'original-author/client-only-plugin',
        description: '',
      }],
    })

    const result = await syncThirdPartyPlugins({ profileDir, repositoryPath: repository, sourceRoot, spawnCommand: fakePnpm(profileDir, calls) })
    assert.ok(calls.every(call => call.command === 'pnpm'))
    assert.ok(calls.every(call => call.options.shell === false))
    assert.deepEqual(calls.map(call => call.args), [
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'add', '--lockfile-only', '--modules-dir', '.dsh-resolution-modules', '--save-exact', 'example-dsh-bundle@1.2.3'],
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'add', '--lockfile-only', '--modules-dir', '.dsh-resolution-modules', '--save-exact', 'git+https://github.com/community/client-only-plugin.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'remove', '--lockfile-only', '--config.modules-dir=.dsh-resolution-modules', 'obsolete-dsh-bundle'],
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'remove', '--lockfile-only', '--config.modules-dir=.dsh-resolution-modules', 'obsolete-client-plugin'],
      ['--dir', profileDir, 'install', '--lockfile-only', '--modules-dir', '.dsh-resolution-modules'],
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'install', '--frozen-lockfile'],
    ])
    const restoredProfile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    assert.equal(restoredProfile.dependencies['client-only-plugin'], 'git+https://github.com/community/client-only-plugin.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    assert.deepEqual(result.plugins.map(plugin => plugin.name), ['example-dsh-bundle', 'client-only-plugin'])
    const status = inspectThirdPartyPlugins({ profileDir, repositoryPath: repository })
    assert.equal(status.plugins[0].installed.version, '1.2.3')
    assert.equal(status.plugins[1].repositoryOwner, 'community')
    assert.equal(status.plugins[1].author, 'original-author')
    assert.equal(status.plugins[1].upstreamRepository, 'original-author/client-only-plugin')
    assert.equal(status.plugins[1].installed.client, true)
    assert.deepEqual(status.extra.map(plugin => plugin.name), ['dsh-environment-sync'])
    assert.equal(result.restartRequired, true)
    const marker = JSON.parse(await readFile(restartMarkerPath(profileDir), 'utf8'))
    assert.equal(marker.profile, 'web')
    assert.match(marker.requestedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(calls.filter(call => call.args.includes('dsh')).every(call => call.options.env.DSH_HOME === join(root, 'dsh-home')))
    const secondCalls = []
    await syncThirdPartyPlugins({ profileDir, repositoryPath: repository, sourceRoot, spawnCommand: fakePnpm(profileDir, secondCalls) })
    assert.deepEqual(secondCalls, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('清单拒绝未固定 Git 引用和本机路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-third-party-manifest-'))
  const path = join(root, 'plugins.json')
  try {
    await writeJson(path, { schemaVersion: 2, profile: 'web', plugins: [{ name: 'git-plugin', specifier: 'github:owner/repo & echo injected#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }] })
    assert.throws(() => readThirdPartyManifest(path), /40-character commit/)
    await writeJson(path, { schemaVersion: 2, profile: 'web', plugins: [{ name: 'registry-plugin', version: '1.0.0', specifier: 'registry-plugin@1.0.0 & echo injected' }] })
    assert.throws(() => readThirdPartyManifest(path), /exact recorded name and version/)
    await writeJson(path, { schemaVersion: 2, profile: 'web', plugins: [{ name: 'git-plugin', specifier: 'github:owner/repo#main' }] })
    assert.throws(() => readThirdPartyManifest(path), /40-character commit/)
    await writeJson(path, { schemaVersion: 2, profile: 'web', plugins: [{ name: 'git-plugin', specifier: 'github:owner/repo#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', repositoryOwner: 'someone-else' }] })
    assert.throws(() => readThirdPartyManifest(path), /repository owner does not match/)
    await writeJson(path, { schemaVersion: 2, profile: 'web', plugins: [{ name: 'local-plugin', specifier: 'file:C:/plugin' }] })
    assert.throws(() => readThirdPartyManifest(path), /local-only specifier/)
    await writeJson(path, { schemaVersion: 2, profile: 'web', plugins: [{ name: 'fork', specifier: 'github:owner/fork#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', upstreamRepository: 'original/repository' }] })
    assert.throws(() => readThirdPartyManifest(path), /must record its original author/)
    await writeJson(path, { schemaVersion: 2, profile: 'web', plugins: [{ name: 'fork', specifier: 'github:owner/fork#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', author: 'original', upstreamRepository: 'not-a-repository' }] })
    assert.throws(() => readThirdPartyManifest(path), /owner\/repository/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
