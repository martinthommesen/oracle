import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { DEFAULT_MODEL, describeConfig, readConfig } from '../plugins/oracle/hooks/config.ts'

const manifest = JSON.parse(readFileSync(new URL('../plugins/oracle/.claude-plugin/plugin.json', import.meta.url), 'utf8'))

describe('readConfig', () => {
  it('reads the manifest defaults as the engine passes them', () => {
    const defaults = { model: manifest.userConfig.model.default, effort: manifest.userConfig.effort.default, extra_commands: '' }
    assert.deepEqual(readConfig(defaults), { config: { model: 'opus', effort: 'xhigh', extraCommands: [] }, warnings: [] })
  })

  it('falls back to the manifest default model', () => {
    assert.equal(DEFAULT_MODEL, manifest.userConfig.model.default)
    assert.equal(readConfig({}).config.model, DEFAULT_MODEL)
    assert.equal(readConfig({ model: '  ' }).config.model, DEFAULT_MODEL)
  })

  it('takes aliases and full model IDs', () => {
    for (const model of ['best', 'fable', 'sonnet', 'haiku', 'inherit', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5-v1:0', 'openrouter/some-model']) {
      assert.equal(readConfig({ model }).config.model, model)
    }
    assert.equal(readConfig({ model: '  sonnet ' }).config.model, 'sonnet')
  })

  it('warns about an unusable model and uses the default', () => {
    const { config, warnings } = readConfig({ model: 'opus; rm -rf /' })
    assert.equal(config.model, DEFAULT_MODEL)
    assert.equal(warnings.length, 1)
  })

  it('reads auto as no effort of its own', () => {
    assert.equal(readConfig({ effort: 'max' }).config.effort, 'max')
    assert.equal(readConfig({ effort: 'auto' }).config.effort, undefined)
  })

  it('parses extra commands', () => {
    assert.deepEqual(readConfig({ extra_commands: 'make -n, gh pr view' }).config.extraCommands, [['make', '-n'], ['gh', 'pr', 'view']])
  })

  it('describes itself for the status line', () => {
    assert.equal(describeConfig(readConfig({ model: 'opus', effort: 'xhigh' }).config), 'opus · xhigh')
    assert.equal(describeConfig(readConfig({ model: 'fable', effort: 'auto' }).config), 'fable')
  })
})
