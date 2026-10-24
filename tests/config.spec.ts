import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeConfig, readConfig } from '../plugins/oracle/hooks/config.ts'

describe('readConfig', () => {
  it('defaults to opus at xhigh with no extra commands', () => {
    assert.deepEqual(readConfig({}), { config: { model: 'opus', effort: 'xhigh', extraCommands: [] }, warnings: [] })
  })

  it('takes aliases and full model IDs', () => {
    for (const model of ['best', 'fable', 'sonnet', 'haiku', 'inherit', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5-v1:0', 'openrouter/some-model']) {
      assert.equal(readConfig({ model }).config.model, model)
    }
  })

  it('trims, and treats an empty model as the default', () => {
    assert.equal(readConfig({ model: '  sonnet ' }).config.model, 'sonnet')
    assert.equal(readConfig({ model: '' }).config.model, 'opus')
  })

  it('warns about an unusable model and uses the default', () => {
    const { config, warnings } = readConfig({ model: 'opus; rm -rf /' })
    assert.equal(config.model, 'opus')
    assert.equal(warnings.length, 1)
  })

  it('reads effort levels, auto, and junk', () => {
    assert.equal(readConfig({ effort: 'max' }).config.effort, 'max')
    assert.equal(readConfig({ effort: 'LOW' }).config.effort, 'low')
    assert.equal(readConfig({ effort: 'auto' }).config.effort, undefined)
    const junk = readConfig({ effort: 'ultra' })
    assert.equal(junk.config.effort, 'xhigh')
    assert.equal(junk.warnings.length, 1)
  })

  it('parses extra commands', () => {
    assert.deepEqual(readConfig({ extra_commands: 'make -n, bazel query' }).config.extraCommands, [['make', '-n'], ['bazel', 'query']])
  })

  it('describes itself for the status line', () => {
    assert.equal(describeConfig(readConfig({}).config), 'opus · xhigh')
    assert.equal(describeConfig(readConfig({ model: 'fable', effort: 'auto' }).config), 'fable')
  })
})
