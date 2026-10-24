import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ALL_FEATURES, FALLBACK_FEATURES, oracleDescription, oracleInstructions, oracleTools } from '../plugins/oracle/hooks/prompts.ts'

const variants = [
  ['mod', ALL_FEATURES],
  ['fallback', FALLBACK_FEATURES],
] as const

describe('oracle prompts', () => {
  for (const [name, features] of variants) {
    const instructions = oracleInstructions(features)
    const description = oracleDescription(features)

    it(`${name}: keeps the oracle's sections`, () => {
      for (const heading of ['## Read before you advise', '## Work quickly', '## Review stance', '## Engineering judgment', '## Debugging', '## Read-only mode', '## Tool use', '## Shape the response', '## Communication']) {
        assert.ok(instructions.includes(heading), heading)
      }
    })

    it(`${name}: speaks Claude Code's tools, not Amp's`, () => {
      for (const text of [instructions, description]) {
        for (const amp of ['shell_command', 'read_web_page', 'find_thread', 'Task subagent', 'file:///', 'Parent thread']) {
          assert.ok(!text.includes(amp), `${amp} in ${name}`)
        }
      }
    })

    it(`${name}: fits the 4096 characters Claude Code keeps of a description, with room to spare`, () => {
      assert.ok(description.length <= 3900, `${description.length} characters`)
    })
  }

  it('mentions the guard, read_thread and delegation only where they exist', () => {
    const mod = oracleInstructions(ALL_FEATURES)
    const fallback = oracleInstructions(FALLBACK_FEATURES)
    assert.match(mod, /A guard enforces this/)
    assert.match(mod, /`read_thread` tool/)
    assert.match(mod, /`Explore` subagents/)
    assert.doesNotMatch(fallback, /\bguard\b/)
    assert.doesNotMatch(fallback, /read_thread/)
    assert.doesNotMatch(fallback, /Explore/)
    assert.doesNotMatch(oracleDescription(FALLBACK_FEATURES), /read_thread/)
  })

  it('gives each variant the tools its prompt speaks of', () => {
    assert.deepEqual(oracleTools(ALL_FEATURES), ['Read', 'Grep', 'Glob', 'LSP', 'Bash', 'WebSearch', 'WebFetch', 'Agent', 'mcp__oracle__read_thread'])
    assert.deepEqual(oracleTools(FALLBACK_FEATURES), ['Read', 'Grep', 'Glob', 'LSP', 'Bash', 'WebSearch', 'WebFetch'])
  })
})
