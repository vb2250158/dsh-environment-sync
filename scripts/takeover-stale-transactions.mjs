/** Explicit local-only maintenance entry. Never infer Home from the running process. */
import { takeoverStaleTransactions } from '../lib/stale-takeover.js'
const usage = 'Usage: node scripts/takeover-stale-transactions.mjs --dsh-home <absolute> --profile <name> --repository <absolute> --backup-directory <absolute Home/backups/.../round> --confirm-preserve-current --acknowledge-unverified-installation --confirm-exclusive-maintenance'
try {
  const args = process.argv.slice(2), values = {}, flags = new Set()
  const names = { '--dsh-home': 'home', '--profile': 'profile', '--repository': 'repository', '--backup-directory': 'backupDirectory' }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (Object.hasOwn(names, key)) {
      if (values[names[key]] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error()
      values[names[key]] = args[++i]
    } else if (['--confirm-preserve-current', '--acknowledge-unverified-installation', '--confirm-exclusive-maintenance'].includes(key) && !flags.has(key)) flags.add(key)
    else throw new Error()
  }
  if (Object.keys(values).length !== 4 || flags.size !== 3) throw new Error()
  if (!flags.has('--confirm-exclusive-maintenance')) throw new Error()
   const result = await takeoverStaleTransactions({ ...values, confirmPreserveCurrent: true, acknowledgeUnverifiedInstallation: true, confirmExclusiveMaintenance: true })
  console.log(JSON.stringify(result))
} catch {
  console.error('Takeover not completed. Preserve all records; review prerequisites and retry only with the same backup directory. No installation or synchronization success is claimed.\n' + usage)
  process.exitCode = 1
}
