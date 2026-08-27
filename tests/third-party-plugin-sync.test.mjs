import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportThirdPartyPlugins, inspectThirdPartyPlugins, readThirdPartyManifest, syncThirdPartyPlugins } from '../scripts/sync-third-party-plugins.mjs'

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

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

function fakePnpm(profileDir, calls) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(async () => {
      try {
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

test('记录当前 DSH bundle 和 client 为精确版本，并排除官方和普通依赖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-third-party-export-'))
  const profileDir = join(root, 'dsh-home', 'profiles', 'web')
  const repository = join(root, 'private')
  try {
    await writeProfile(profileDir, {
      'dsh-environment-sync': 'link:C:/private',
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
    assert.ok(calls.every(call => call.options.shell === (process.platform === 'win32')))
    assert.deepEqual(calls.map(call => call.args), [
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'add', '--save-exact', 'example-dsh-bundle@1.2.3'],
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'add', '--save-exact', 'git+https://github.com/community/client-only-plugin.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'remove', 'obsolete-dsh-bundle'],
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'remove', 'obsolete-client-plugin'],
      ['--dir', profileDir, 'install', '--lockfile-only'],
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
    assert.deepEqual(status.extra, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('清单拒绝未固定 Git 引用和本机路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-third-party-manifest-'))
  const path = join(root, 'plugins.json')
  try {
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
