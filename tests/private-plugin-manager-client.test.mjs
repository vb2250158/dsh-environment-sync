import assert from 'node:assert/strict'
import test from 'node:test'

const clientBundleUrl = new URL('../lib/client.js', import.meta.url).href
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useCallback: value => value,
  useRef: value => ({ current: value }),
  useEffect: () => {},
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
}

async function loadClientBundle() {
  let loaded
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: value => { loaded = value } } }
  try {
    await import(`${clientBundleUrl}?test=${Date.now()}-${Math.random()}`)
    assert.equal(loaded.id, 'dsh-environment-sync')
    return loaded.factory(id => {
      if (id === 'react') return fakeReact
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button: 'DshButton' }
      throw new Error(`Unexpected dependency ${id}`)
    })
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
}

function context() {
  const registered = []
  const mounted = []
  const status = {
    plugins: [{ id: 'theme', name: '主题', packageName: 'dsh-theme-blue', repository: 'vb2250158/dsh-theme-blue', author: 'vb2250158', localVersion: '1.0.0', installed: true, manageable: true, controlAvailable: true, enabled: true }],
    dataRepository: { remoteUrl: 'https://github.com/example/private', localPath: 'C:/Private', isGitRepository: true, changes: 0, canClone: false },
    environment: { configured: true, bundleCount: 3, settingsNamespaceCount: 5, credentialsEncrypted: true },
    thirdParty: { configured: true, plugins: [{ name: 'community-plugin', version: '1.0.0', specifier: 'github:private-owner/community-plugin#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', repositoryOwner: 'private-owner', author: 'community', upstreamRepository: 'community/community-plugin', installed: null }] },
    operation: { state: 'idle', action: null, message: '' },
    restartRequired: false,
    refreshRequired: false,
  }
  const response = async () => ({ ok: true, value: status })
  const ctx = {
    remote: { $mount: async value => { mounted.push(value); return () => {} } },
    reflect: { get: () => ({ status: response, configure: response, setEnabled: response, cloneData: response, fetchData: response, publishData: response, syncData: response, recordThirdParty: response, syncThirdParty: response }) },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
  }
  return { ctx, mounted, registered }
}

test('客户端只配置私有仓库，并提供按清单拉取插件的操作', async () => {
  const client = await loadClientBundle()
  const { ctx, mounted, registered } = context()
  await client.apply(ctx)
  assert.equal(mounted[0].package, 'dsh-environment-sync')
  assert.deepEqual(mounted[0].descriptors.map(item => item.method), ['status', 'configure', 'setEnabled', 'cloneData', 'fetchData', 'publishData', 'syncData', 'recordThirdParty', 'syncThirdParty'])
  const configure = mounted[0].descriptors.find(item => item.method === 'configure')
  assert.deepEqual(configure.parameters[0].codec.schema.parse({ dataRemoteUrl: 'x', dataLocalPath: 'y' }), { dataRemoteUrl: 'x', dataLocalPath: 'y' })
  assert.throws(() => configure.parameters[0].codec.schema.parse({ remoteUrl: 'x', localPath: 'y' }), /private data repository/)
  assert.deepEqual(registered.map(item => item.options.id), ['my-plugins'])
  const rendered = registered[0].component(registered[0].options.inject())
  assert.equal(rendered.type, 'div')
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  assert.match(source, /第三方修改版使用标明原作者和上游的私有 fork/)
  assert.match(source, /拉取并应用/)
  assert.match(source, /作者：/)
  assert.match(source, /原作者/)
  assert.match(source, /私有 fork/)
  assert.match(source, /原始上游/)
  assert.match(source, /私有清单记录的插件/)
  assert.match(source, /固定来源/)
  assert.doesNotMatch(source, /私有清单记录的公开插件/)
  assert.doesNotMatch(source, /本地源码目录|同步源码|克隆公开源码/)
})

test('预取与页面请求合并，首次等待不显示零数量或空配置', async () => {
  const client = await loadClientBundle()
  const { ctx, registered } = context()
  const service = ctx.reflect.get()
  const ready = await service.status()
  let resolveStatus
  let calls = 0
  service.status = () => { calls++; return new Promise(resolve => { resolveStatus = resolve }) }
  ctx.reflect.get = () => service
  await client.apply(ctx)
  const { component, options } = registered[0]
  const actions = options.inject()
  const first = actions.readStatus()
  assert.equal(first, actions.readStatus())
  assert.equal(calls, 1)
  const pending = JSON.stringify(component(actions))
  assert.match(pending, /正在读取配置和插件清单/)
  assert.doesNotMatch(pending, /本机已安装插件|尚未记录插件清单|私有 GitHub 仓库/)
  resolveStatus(ready)
  await first
  const loaded = JSON.stringify(component(actions))
  assert.match(loaded, /本机已安装插件（1）/)
  assert.match(loaded, /C:\/Private/)
  service.status = async () => { throw new Error('offline') }
  await assert.rejects(actions.readStatus(), /offline/)
  assert.match(JSON.stringify(component(actions)), /本机已安装插件（1）/)
  service.status = async () => ready
  await actions.readStatus()
})
