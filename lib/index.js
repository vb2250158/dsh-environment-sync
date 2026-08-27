import { createProfilePrivatePluginManager } from './private-plugin-manager.js'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-environment-sync'

export const Config = z.object({
  profile: z.string().default('web'),
})

/** Register private environment synchronization and public plugin management. */
export function apply(ctx, config = {}) {
  new (createProfilePrivatePluginManager())(ctx, { profile: config.profile })
}

export { PrivatePluginManager } from './private-plugin-manager.js'
