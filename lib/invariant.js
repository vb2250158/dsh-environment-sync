const PACKAGE_NAME = 'dsh-environment-sync'

export const name = 'dsh-environment-sync-invariant'
export const inject = ['invariants']

const install = () => {}

export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
