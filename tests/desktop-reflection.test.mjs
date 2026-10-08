import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('Desktop reflection loads without a Web profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reflection-'))
  try {
    const entry = new URL('../lib/typert.host.js', import.meta.url).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { TYPERT } from ${JSON.stringify(entry)};
      const status = TYPERT.invocations.find(item => item.method === 'status');
      if (status.result.create().parse({ profile: 'desktop' }).profile !== 'desktop') process.exit(1);
    `], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
