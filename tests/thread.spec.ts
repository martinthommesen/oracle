import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderThread } from '../plugins/oracle/hooks/thread.ts'
import type { ThreadRow } from '../plugins/oracle/hooks/thread.ts'

function user(text: string): ThreadRow {
  return { role: 'user', text, toolUses: [] }
}

function assistant(text: string, toolUses: ThreadRow['toolUses'] = []): ThreadRow {
  return { role: 'assistant', text, toolUses }
}

describe('renderThread', () => {
  it('says when there is nothing to read', () => {
    assert.match(renderThread([]), /no messages yet/)
  })

  it('renders messages with their tool calls, output on request', () => {
    const rows = [
      user('Fix the flaky login test'),
      assistant('Looking at it.', [{ tool: 'Bash', input: { command: 'git log -3' }, text: 'abc fix\ndef feat' }]),
      { role: 'user' as const, text: '', toolUses: [], toolResults: [{}] },
      assistant('Done.'),
    ]
    const brief = renderThread(rows)
    assert.match(brief, /3 messages, showing \[0\]–\[2\]/)
    assert.match(brief, /### \[0\] user\nFix the flaky login test/)
    assert.match(brief, /- Bash: git log -3/)
    assert.doesNotMatch(brief, /abc fix/)
    assert.match(brief, /include_tool_output/)

    const full = renderThread(rows, { includeToolOutput: true })
    assert.match(full, /→ abc fix def feat/)
  })

  it('skips rows that only carry tool results', () => {
    const rendered = renderThread([user('a'), { role: 'user', text: ' ', toolUses: [] }, assistant('b')])
    assert.match(rendered, /2 messages, showing \[0\]–\[1\]/)
  })

  it('keeps the newest messages within budget and always the opening request', () => {
    const rows = [user('OPENING REQUEST'), ...Array.from({ length: 50 }, (_, k) => assistant(`reply ${k} ${'x'.repeat(200)}`))]
    const rendered = renderThread(rows, {}, 2_000)
    assert.match(rendered, /OPENING REQUEST/)
    assert.match(rendered, /reply 49/)
    assert.doesNotMatch(rendered, /reply 10 /)
    assert.match(rendered, /messages omitted/)
    assert.match(rendered, /Earlier messages: call read_thread with an offset below \d+/)
  })

  it('reports no earlier messages when everything fits but the opening request', () => {
    const rows = Array.from({ length: 4 }, (_, k) => user(`m${k} ${'x'.repeat(90)}`))
    const rendered = renderThread(rows, {}, 450)
    assert.match(rendered, /showing \[0\]–\[3\]/)
    assert.doesNotMatch(rendered, /Earlier messages|messages omitted/)
  })

  it('pages from an offset', () => {
    const rows = Array.from({ length: 10 }, (_, k) => user(`message ${k}`))
    const rendered = renderThread(rows, { offset: 3, limit: 2 })
    assert.match(rendered, /showing \[3\]–\[4\]/)
    assert.match(rendered, /message 3/)
    assert.match(rendered, /message 4/)
    assert.doesNotMatch(rendered, /message 5/)
    assert.match(rendered, /Later messages: call read_thread with offset 5/)
  })

  it('clamps an offset past the end', () => {
    const rendered = renderThread([user('only')], { offset: 99 })
    assert.match(rendered, /showing \[0\]–\[0\]/)
  })

  it('shortens long messages and tool inputs', () => {
    const rendered = renderThread([user('y'.repeat(10_000)), assistant('', [{ tool: 'Read', input: { file_path: `/${'p'.repeat(500)}` } }])])
    assert.match(rendered, /more characters\]/)
    assert.ok(rendered.length < 8_000)
  })

  it('names the subagent type of an Agent call', () => {
    const rendered = renderThread([assistant('', [{ tool: 'Agent', input: { subagent_type: 'Explore', description: 'find callers' } }])])
    assert.match(rendered, /- Agent: Explore: find callers/)
  })
})

describe('renderThread limits', () => {
  const rows = Array.from({ length: 10 }, (_, k) => user(`message ${k}`))

  it('counts the pinned opening request toward the limit', () => {
    const rendered = renderThread(rows, { limit: 3 })
    assert.match(rendered, /showing \[8\]–\[9\]/)
    assert.equal(rendered.match(/^### \[/gm)?.length, 3)
    assert.match(rendered, /### \[0\] user/)
  })

  it('shows only the newest message for a limit of 1', () => {
    const rendered = renderThread(rows, { limit: 1 })
    assert.equal(rendered.match(/^### \[/gm)?.length, 1)
    assert.match(rendered, /### \[9\] user/)
  })

  it('reports the length a shortened tool output was cut from', () => {
    const output = `${'a '.repeat(400)}${' '.repeat(2000)}end`
    const rendered = renderThread([assistant('', [{ tool: 'Bash', input: { command: 'x' }, text: output }])], { includeToolOutput: true })
    assert.match(rendered, new RegExp(`cut from ${output.length} characters`))
  })
})
