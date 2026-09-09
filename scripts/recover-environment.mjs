/** Restore from the local environment journal without requiring a working DSH page. */
import { applyEnvironment } from '../lib/environment-apply.js'
const argument = name => process.argv[process.argv.indexOf(name) + 1]
for (const name of ['--dsh-home', '--repository', '--source-root']) {
  if (!process.argv.includes(name)) throw new Error(`Missing ${name}`)
}
await applyEnvironment({ dshHomePath: argument('--dsh-home'), dataRootPath: argument('--repository'), sourceRoot: argument('--source-root'), profile: 'web', restoreOnly: true })
console.log('Previous DSH environment restored.')
