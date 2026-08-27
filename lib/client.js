window.__ModuleLoader__.load({
  id: 'dsh-plugin-manager',
  factory: (require) => {
    const React = require('react')
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')

    const statusSchema = {
      parse(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('plugin manager result must be an object')
        if (!Array.isArray(value.plugins) || typeof value.restartRequired !== 'boolean' || typeof value.refreshRequired !== 'boolean') throw new TypeError('plugin manager result is invalid')
        return value
      },
    }
    const repositoryConfigSchema = {
      parse(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('plugin manager repository configuration is invalid')
        if (typeof value.dataRemoteUrl !== 'string' || typeof value.dataLocalPath !== 'string') throw new TypeError('private data repository fields must be strings')
        return value
      },
    }
    const pluginEnablementSchema = {
      parse(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || typeof value.enabled !== 'boolean') throw new TypeError('plugin enablement is invalid')
        return value
      },
    }
    const packageName = 'dsh-plugin-manager'
    const result = { mode: 'strict', typeSymbol: `${packageName}#PluginManagerStatus`, schema: statusSchema }
    const request = (typeSymbol, schema) => ({ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol, schema } })
    const remote = (method, parameters = []) => ({
      id: `${packageName}#privatePluginManager/${method}`,
      service: 'privatePluginManager',
      namespace: 'privatePluginManager',
      method,
      invocation: { kind: 'direct' },
      parameters,
      result,
    })
    const managerRemote = {
      package: packageName,
      descriptors: [
        remote('status'),
        remote('configure', [request(`${packageName}#PrivateDataRepositoryConfig`, repositoryConfigSchema)]),
        remote('setEnabled', [request(`${packageName}#PluginEnablement`, pluginEnablementSchema)]),
        remote('cloneData'),
        remote('publishData'),
        remote('syncData'),
        remote('recordThirdParty'),
        remote('syncThirdParty'),
      ],
    }

    const card = {
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '12px',
      padding: '16px',
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    const muted = { color: 'var(--dsw-alias-label-secondary)', margin: '5px 0' }
    const button = { marginRight: '8px', marginTop: '10px' }
    const input = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '9px',
      marginTop: '6px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
    }

    function unwrap(value, operation) {
      if (value?.ok) return value.value
      throw new Error(value?.error?.message ?? `privatePluginManager.${operation} failed`)
    }

    function PluginRow({ plugin, busy, setEnabled, run }) {
      const installed = plugin.installed === true
      const state = !installed ? '未安装' : plugin.enabled === false ? '已停用' : '已启用'
      return React.createElement('details', { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '10px' } },
        React.createElement('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-primary)' } },
          React.createElement('span', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' } },
            React.createElement('strong', null, plugin.name),
            React.createElement('span', { style: muted }, `${plugin.packageName} · v${plugin.localVersion ?? '未安装'} · ${state}`),
          ),
        ),
        plugin.description ? React.createElement('p', { style: muted }, plugin.description) : null,
        plugin.repository ? React.createElement('p', { style: muted }, `公开仓库：github.com/${plugin.repository}`) : null,
        installed && plugin.manageable && plugin.controlAvailable !== false
          ? React.createElement(Button, {
              variant: 'outline',
              type: 'button',
              disabled: busy !== '',
              onClick: () => { void run(`toggle-${plugin.id}`, () => setEnabled({ id: plugin.id, enabled: plugin.enabled === false })) },
              style: button,
            }, busy === `toggle-${plugin.id}` ? '正在保存…' : plugin.enabled === false ? '启用插件' : '停用插件')
          : null,
      )
    }

    function RecordedPluginRow({ plugin }) {
      const installed = plugin.installed
      const state = installed === null ? '等待安装' : installed.version === plugin.version ? '已安装' : `本机 v${installed.version ?? '未知'}`
      return React.createElement('details', { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '10px' } },
        React.createElement('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-primary)' } },
          React.createElement('span', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' } },
            React.createElement('strong', null, plugin.name),
            React.createElement('span', { style: muted }, `v${plugin.version ?? '未知'} · ${state}`),
          ),
        ),
        React.createElement('p', { style: muted }, `固定来源：${plugin.specifier}`),
      )
    }

    let cache
    function PluginManagerSection({ readStatus, configure, setEnabled, cloneData, publishData, syncData, recordPlugins, syncPlugins }) {
      const [snapshot, setSnapshot] = React.useState(() => cache)
      const [dataRemoteUrl, setDataRemoteUrl] = React.useState(() => cache?.dataRepository?.remoteUrl ?? '')
      const [dataLocalPath, setDataLocalPath] = React.useState(() => cache?.dataRepository?.localPath ?? '')
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const accept = React.useCallback(value => {
        cache = value
        setSnapshot(value)
        if (value?.dataRepository?.remoteUrl) setDataRemoteUrl(value.dataRepository.remoteUrl)
        if (value?.dataRepository?.localPath) setDataLocalPath(value.dataRepository.localPath)
      }, [])
      const run = React.useCallback(async (name, operation) => {
        setBusy(name)
        setError('')
        try { accept(await operation()) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy('') }
      }, [accept])
      React.useEffect(() => { if (cache === undefined) void run('refresh', readStatus) }, [readStatus, run])

      const dataRepository = snapshot?.dataRepository
      const environment = snapshot?.environment
      const installed = snapshot?.plugins?.filter(plugin => plugin.installed) ?? []
      const recorded = snapshot?.thirdParty?.plugins ?? []
      const operation = snapshot?.operation
      return React.createElement('div', { style: { display: 'grid', gap: '14px', padding: '8px 0' } },
        React.createElement('div', null,
          React.createElement('h2', { style: { margin: 0 } }, '我的插件'),
          React.createElement('p', { style: muted }, '每个插件使用独立公开仓库；私有仓库只保存本机之间同步的环境配置。'),
        ),
        React.createElement('section', { style: card },
          React.createElement('strong', null, '私有环境仓库'),
          React.createElement('label', { style: { display: 'block', marginTop: '12px' } }, '私有 GitHub 仓库', React.createElement('input', { value: dataRemoteUrl, onChange: event => setDataRemoteUrl(event.target.value), style: input })),
          React.createElement('label', { style: { display: 'block', marginTop: '12px' } }, '本地配置目录', React.createElement('input', { value: dataLocalPath, onChange: event => setDataLocalPath(event.target.value), style: input })),
          React.createElement(Button, { variant: 'primary', type: 'button', disabled: busy !== '', onClick: () => { void run('configure', () => configure({ dataRemoteUrl, dataLocalPath })) }, style: button }, busy === 'configure' ? '正在保存…' : '保存设置'),
        ),
        dataRepository === undefined
          ? React.createElement('section', { style: card }, '正在读取私有环境状态…')
          : React.createElement('section', { style: card },
              React.createElement('strong', null, '多电脑同步'),
              React.createElement('p', { style: { ...muted, color: dataRepository.problem ? 'var(--dsw-alias-state-error-primary)' : undefined } }, dataRepository.problem ?? '私有仓库已连接'),
              environment?.configured ? React.createElement('p', { style: muted }, `记录 ${environment.bundleCount} 个组合包、${environment.settingsNamespaceCount} 个配置命名空间；凭据${environment.credentialsEncrypted ? '已加密' : '未记录'}。`) : null,
              dataRepository.canClone ? React.createElement(Button, { variant: 'primary', type: 'button', disabled: busy !== '', onClick: () => { void run('clone-data', cloneData) }, style: button }, '克隆配置') : null,
              React.createElement(Button, { variant: 'outline', type: 'button', disabled: busy !== '' || dataRepository.isGitRepository !== true || dataRepository.changes !== 0, onClick: () => { void run('publish-data', publishData) }, style: button }, busy === 'publish-data' ? '正在上传…' : '上传当前环境'),
              React.createElement(Button, { variant: 'outline', type: 'button', disabled: busy !== '' || dataRepository.isGitRepository !== true || dataRepository.changes !== 0, onClick: () => { void run('sync-data', syncData) }, style: button }, busy === 'sync-data' ? '正在应用…' : '下载配置并拉取插件'),
              React.createElement('p', { style: muted }, '同步内容包括插件仓库与固定提交、启停状态、每个插件配置、settings、profile/home patch、AGENTS.md 和加密凭据。'),
            ),
        React.createElement('section', { style: card },
          React.createElement('strong', null, `本机已安装插件（${installed.length}）`),
          React.createElement('div', { style: { display: 'grid', gap: '8px', marginTop: '12px' } }, (snapshot?.plugins ?? []).map(plugin => React.createElement(PluginRow, { key: plugin.id, plugin, busy, setEnabled, run }))),
        ),
        React.createElement('section', { style: card },
          React.createElement('strong', null, `私有清单记录的公开插件（${recorded.length}）`),
          snapshot?.thirdParty?.problem ? React.createElement('p', { style: { ...muted, color: 'var(--dsw-alias-state-error-primary)' } }, snapshot.thirdParty.problem) : null,
          recorded.length ? React.createElement('div', { style: { display: 'grid', gap: '8px', marginTop: '12px' } }, recorded.map(plugin => React.createElement(RecordedPluginRow, { key: plugin.name, plugin }))) : React.createElement('p', { style: muted }, '尚未记录插件清单。'),
          React.createElement(Button, { variant: 'outline', type: 'button', disabled: busy !== '' || dataRepository?.isGitRepository !== true, onClick: () => { void run('record-plugins', recordPlugins) }, style: button }, busy === 'record-plugins' ? '正在记录…' : '记录本机插件'),
          React.createElement(Button, { variant: 'outline', type: 'button', disabled: busy !== '' || snapshot?.thirdParty?.configured !== true, onClick: () => { void run('sync-plugins', syncPlugins) }, style: button }, busy === 'sync-plugins' ? '正在拉取…' : '按清单拉取插件'),
        ),
        React.createElement(Button, { variant: 'ghost', size: 'sm', type: 'button', disabled: busy !== '', onClick: () => { void run('refresh', readStatus) }, style: button }, '刷新状态'),
        operation?.state && operation.state !== 'idle' ? React.createElement('p', { style: { ...muted, color: operation.state === 'failed' ? 'var(--dsw-alias-state-error-primary)' : undefined } }, operation.message) : null,
        snapshot?.restartRequired ? React.createElement('p', { style: { color: 'var(--dsw-alias-brand-primary)' } }, '插件或环境已更新；重启 DSH 后加载全部变化。') : null,
        error ? React.createElement('p', { style: { color: 'var(--dsw-alias-state-error-primary)', margin: 0 } }, `操作失败：${error}`) : null,
      )
    }

    return {
      inject: ['slots', 'remote'],
      async apply(ctx) {
        const dispose = await ctx.remote.$mount(managerRemote)
        const service = ctx.reflect.get('remote.privatePluginManager')
        if (service === undefined) throw new Error('privatePluginManager Remote did not mount')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'my-plugins',
          order: 16,
          label: () => '我的插件',
          inject: () => ({
            readStatus: async () => unwrap(await service.status(), 'status'),
            configure: async value => unwrap(await service.configure(value), 'configure'),
            setEnabled: async value => unwrap(await service.setEnabled(value), 'setEnabled'),
            cloneData: async () => unwrap(await service.cloneData(), 'cloneData'),
            publishData: async () => unwrap(await service.publishData(), 'publishData'),
            syncData: async () => unwrap(await service.syncData(), 'syncData'),
            recordPlugins: async () => unwrap(await service.recordThirdParty(), 'recordThirdParty'),
            syncPlugins: async () => unwrap(await service.syncThirdParty(), 'syncThirdParty'),
          }),
        }, PluginManagerSection))
        return dispose
      },
    }
  },
})
