const PACKAGE_NAME = 'dsh-plugin-manager'

export const name = 'dsh-plugin-manager-invariant'
export const inject = ['invariants']

const install = () => {}

export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
