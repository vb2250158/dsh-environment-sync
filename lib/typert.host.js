import { z } from 'zod'
const packageName = 'dsh-environment-sync'
const status = z.unknown()
const repositoryConfig = z.object({ dataRemoteUrl: z.string(), dataLocalPath: z.string() })
const pluginEnablement = z.object({ id: z.string(), enabled: z.boolean() })
const conflictChoice = z.object({ path: z.string(), side: z.enum(['local', 'remote']) })

function descriptor(method, parameters = []) {
  return {
    id: `${packageName}#privatePluginManager/${method}`,
    service: 'privatePluginManager',
    namespace: 'privatePluginManager',
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: { mode: 'strict', typeSymbol: `${packageName}#PluginManagerStatus`, create: () => (status) },
    sourceLocation: { file: 'lib/private-plugin-manager.js', line: 704, column: 3 },
  }
}
const request = (typeSymbol, schema) => [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol, create: () => (schema) } }]

/** Host Remote reflection for the DSH plugin manager. */
export const TYPERT = {
  package: packageName,
  face: 'host',
  schemas: [],
  invocations: [
    descriptor('status'),
    descriptor('configure', request(`${packageName}#PrivateDataRepositoryConfig`, repositoryConfig)),
    descriptor('setEnabled', request(`${packageName}#PluginEnablement`, pluginEnablement)),
    descriptor('cloneData'),
    descriptor('fetchData'),
    descriptor('publishData'),
    descriptor('syncData'),
    descriptor('resolveConflict', request(`${packageName}#ConflictChoice`, conflictChoice)),
    descriptor('setSyncKey', request(`${packageName}#SyncKey`, z.object({ key: z.string().min(16) }))),
    descriptor('changePlugin', request(`${packageName}#PluginChange`, z.object({ action: z.enum(['add', 'remove']), value: z.string() }))),
    descriptor('restoreEnvironment'),
    descriptor('deferRestart'),
    descriptor('restartEnvironment'),
    descriptor('recordThirdParty'),
    descriptor('syncThirdParty'),
  ],
  model: { services: [], events: [], objects: [] },
}
