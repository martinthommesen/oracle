// Type-checks the repository: the tooling and tests against Node's types, and
// the hooks module against the Claude Code API declarations.
//
// Claude Code writes those declarations beside a plugin it loads from a folder
// it hot-reloads (`claude --plugin-dir plugins/oracle`, interactive), at
// plugins/oracle/.claude-plugin/types/. Or point CLAUDE_CODE_TYPES at a
// claude-code.d.ts (the plugin-authoring skill writes one) and this copies it there.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const laid = join(root, 'plugins', 'oracle', '.claude-plugin', 'types', 'claude-code', 'index.d.ts')

function run(project) {
  console.log(`tsc -p ${project}`)
  execFileSync(process.execPath, [tsc, '-p', join(root, project)], { stdio: 'inherit' })
}

run('tsconfig.json')

const given = process.env.CLAUDE_CODE_TYPES
if (given) {
  mkdirSync(dirname(laid), { recursive: true })
  copyFileSync(given, laid)
}
if (existsSync(laid)) {
  run('plugins/oracle/tsconfig.json')
} else if (process.env.CI) {
  console.log('Skipping the hooks module: no Claude Code API declarations (set CLAUDE_CODE_TYPES).')
} else {
  console.error('No Claude Code API declarations at plugins/oracle/.claude-plugin/types/. Set CLAUDE_CODE_TYPES to a claude-code.d.ts.')
  process.exit(1)
}
