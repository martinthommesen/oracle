import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../plugins/oracle/', import.meta.url))

/** The plugin's files that sessions load: everything but its tests, its tsconfig, and what Claude Code writes beside it. */
function pluginFiles(dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    const rel = relative(root, path)
    if (rel === 'tests' || rel === 'tsconfig.json' || rel === join('.claude-plugin', 'types') || rel === '.mcpb-cache') return []
    return entry.isDirectory() ? pluginFiles(path) : [rel.split('\\').join('/')]
  })
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
