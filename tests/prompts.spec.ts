import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ALL_FEATURES, FALLBACK_FEATURES, oracleDescription, oracleInstructions } from '../plugins/oracle/hooks/prompts.ts'

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
      assert.match(instructions, /code-judo move/)
      assert.match(instructions, /No blockers/)
      assert.match(instructions, /S <1h, M 1–3h, L 1–2d, XL >2d/)
    })

    it(`${name}: speaks Claude Code's tools, not Amp's`, () => {
      for (const text of [instructions, description]) {
        for (const amp of ['shell_command', 'read_web_page', 'find_thread', 'Task subagent', 'file:///', 'Parent thread']) {
          assert.ok(!text.includes(amp), `${amp} in ${name}`)
        }
      }
      assert.match(instructions, /Read, Grep, and Glob/)
      assert.match(instructions, /WebSearch and WebFetch/)
      assert.match(instructions, /path\/to\/file\.ts:42/)
    })

    it(`${name}: keeps the guidance on when to consult`, () => {
      assert.match(description, /When the user explicitly asks for the oracle/)
      assert.match(description, /do NOT consult the oracle for/)
      assert.match(description, /Write the prompt well/)
      assert.match(description, /SendMessage/)
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
})

describe('agent description', () => {
  it('fits the 4096 characters Claude Code keeps, with room to spare', () => {
    for (const features of [ALL_FEATURES, FALLBACK_FEATURES]) {
      assert.ok(oracleDescription(features).length <= 3900, `${oracleDescription(features).length} characters`)
    }
  })
})
