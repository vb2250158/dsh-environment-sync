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

async function writeBundle(profileDir, name, version, { bundle = true } = {}) {
  const directory = join(profileDir, 'node_modules', ...name.split('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'index.js'), 'export {}\n')
  await writeJson(join(directory, 'package.json'), {
    name,
    version,
    ...(bundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
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
  return (command, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(async () => {
      try {
        calls.push({ command, args })
        const actionIndex = args.findIndex(value => value === 'add' || value === 'remove')
        const action = args[actionIndex]
        const target = args.at(-1)
        const manifestPath = join(profileDir, 'package.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        if (action === 'add') {
          const [name, version] = target === 'example-dsh-bundle@1.2.3'
            ? ['example-dsh-bundle', '1.2.3']
            : (() => { throw new Error(`Unexpected add target: ${target}`) })()
          manifest.dependencies[name] = version
          manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles.filter(value => value !== name), name]
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

test('记录当前公开 DSH bundle 为精确版本，并排除官方和普通依赖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-third-party-export-'))
  const profileDir = join(root, 'dsh-home', 'profiles', 'web')
  const repository = join(root, 'private')
  try {
    await writeProfile(profileDir, {
      'dsh-plugin-manager': 'link:C:/private',
      '@deepseek-ai/dsh-extra': '0.1.0',
      'example-dsh-bundle': '^1.2.0',
      'ordinary-library': '^2.0.0',
    }, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-manager', 'example-dsh-bundle'])
    await writeBundle(profileDir, 'dsh-plugin-manager', '0.1.0')
    await writeBundle(profileDir, '@deepseek-ai/dsh-extra', '0.1.0')
    await writeBundle(profileDir, 'example-dsh-bundle', '1.2.3')
    await writeBundle(profileDir, 'ordinary-library', '2.0.0', { bundle: false })

    const recorded = exportThirdPartyPlugins({ profileDir, repositoryPath: repository })
    assert.deepEqual(recorded.plugins, [{
      name: 'example-dsh-bundle',
      specifier: 'example-dsh-bundle@1.2.3',
      version: '1.2.3',
      source: 'registry',
      description: '',
    }])
    assert.deepEqual(JSON.parse(await readFile(recorded.manifestPath, 'utf8')).plugins, recorded.plugins)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('记录拒绝本机 link 公开 bundle，避免写入不能跨电脑安装的清单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-third-party-link-'))
  const profileDir = join(root, 'dsh-home', 'profiles', 'web')
  try {
    await writeProfile(profileDir, { 'local-bundle': 'link:C:/local-bundle' }, ['local-bundle'])
    await writeBundle(profileDir, 'local-bundle', '1.0.0')
    assert.throws(() => exportThirdPartyPlugins({ profileDir, repositoryPath: join(root, 'private') }), /local-only specifier/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('同步按清单调用官方插件入口，并对齐已安装公开 bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-third-party-import-'))
  const profileDir = join(root, 'dsh-home', 'profiles', 'web')
  const repository = join(root, 'private')
  const sourceRoot = join(root, 'official')
  const calls = []
  try {
    await writeProfile(profileDir, {
      'dsh-plugin-manager': 'link:C:/private',
      'obsolete-dsh-bundle': '1.0.0',
    }, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-manager', 'obsolete-dsh-bundle'])
    await writeBundle(profileDir, 'dsh-plugin-manager', '0.1.0')
    await writeBundle(profileDir, 'obsolete-dsh-bundle', '1.0.0')
    await writeBundle(profileDir, 'example-dsh-bundle', '1.2.3')
    await mkdir(join(sourceRoot, 'apps', 'cli', 'src'), { recursive: true })
    await writeFile(join(sourceRoot, 'apps', 'cli', 'src', 'bin.ts'), '')
    await writeJson(join(repository, 'config', 'plugins.json'), {
      schemaVersion: 1,
      profile: 'web',
      plugins: [{
        name: 'example-dsh-bundle',
        specifier: 'example-dsh-bundle@1.2.3',
        version: '1.2.3',
        source: 'registry',
        description: '',
      }],
    })

    const result = await syncThirdPartyPlugins({ profileDir, repositoryPath: repository, sourceRoot, spawnCommand: fakePnpm(profileDir, calls) })
    assert.deepEqual(calls.map(call => call.args), [
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'add', '--save-exact', 'example-dsh-bundle@1.2.3'],
      ['--dir', sourceRoot, 'dsh', 'plugin', '--profile', 'web', 'remove', 'obsolete-dsh-bundle'],
    ])
    assert.deepEqual(result.plugins.map(plugin => plugin.name), ['example-dsh-bundle'])
    const status = inspectThirdPartyPlugins({ profileDir, repositoryPath: repository })
    assert.equal(status.plugins[0].installed.version, '1.2.3')
    assert.deepEqual(status.extra, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('清单拒绝未固定 Git 引用和本机路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-third-party-manifest-'))
  const path = join(root, 'plugins.json')
  try {
    await writeJson(path, { schemaVersion: 1, profile: 'web', plugins: [{ name: 'git-plugin', specifier: 'github:owner/repo#main' }] })
    assert.throws(() => readThirdPartyManifest(path), /40-character commit/)
    await writeJson(path, { schemaVersion: 1, profile: 'web', plugins: [{ name: 'local-plugin', specifier: 'file:C:/plugin' }] })
    assert.throws(() => readThirdPartyManifest(path), /local-only specifier/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
