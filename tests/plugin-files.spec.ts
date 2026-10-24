import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/** The plugin's committed files that sessions load, as install.sh fetches them: everything but its tests and tsconfig. */
function pluginFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'plugins/oracle'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' })
  return listed
    .split('\0')
    .filter(Boolean)
    .map(path => path.slice('plugins/oracle/'.length))
    .filter(path => !path.startsWith('tests/') && path !== 'tsconfig.json')
}

describe('scripts/install.sh', () => {
  it('fetches every file the plugin loads, and nothing else', () => {
    const script = readFileSync(new URL('../scripts/install.sh', import.meta.url), 'utf8')
    const list = script.match(/files=\(\n([\s\S]*?)\n\)/)?.[1]
    assert.ok(list, 'the files=( ... ) list')
    const listed = list.split('\n').map(line => line.trim()).filter(Boolean)
    assert.deepEqual(listed, [...listed].sort(), 'the list is sorted')
    assert.deepEqual(listed, pluginFiles().sort())
  })
})
