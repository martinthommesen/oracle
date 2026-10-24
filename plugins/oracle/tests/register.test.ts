// Hook-level tests, run by `claude plugin test plugins/oracle`. The hooks a
// test registers with `on` sit beneath the plugin and stand for the engine.

import type { AgentSpawnInput, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

type Spec = { name: string; model?: string; effort?: string | number; tools?: readonly string[]; prompt: string; description: string }
type Recorded = { agents: Spec[]; tools: { name: string; isDeferred?: boolean }[]; statuses: (string | undefined)[]; toasts: string[]; spawnModels: (string | undefined)[] }

/** Stands in for the engine: records registrations, answers every tool call with "ran". */
function engine(on: On, list: { id: string; type: string; parentId?: string }[] = []): Recorded {
  const recorded: Recorded = { agents: [], tools: [], statuses: [], toasts: [], spawnModels: [] }
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.register', (_, e) => {
    recorded.agents.push(e)
    return { value: { agent: `oracle:${e.name}` } }
  })
  on('tool.register', (_, e) => {
    recorded.tools.push(e)
    return { value: { tool: `mcp__oracle__${e.name}` } }
  })
  on('agent.list', () => ({
    value: list.map(agent => ({ id: agent.id, type: agent.type, parentId: agent.parentId, description: '', status: 'running' as const })),
  }))
  on('agent.spawn', (_, e) => {
    recorded.spawnModels.push(e.model)
    return { model: e.model ?? 'resolved-model', agentId: e.description }
  })
  on('ui.status', (_, e) => {
    recorded.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    recorded.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ran' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return recorded
}

/** An agent.spawn as the engine raises it; the stub above answers `description` as the agent id. */
function spawn(id: string, subagentType: string, parentAgentId?: string): AgentSpawnInput {
  return {
    tool_use_id: `toolu_${id}`,
    prompt: 'task',
    description: id,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
  }
}

async function start($: { session: { start: (e: { cwd: string; surface: 'terminal'; isInteractive: boolean }) => Promise<unknown> } }): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

describe('registration', () => {
  test('registers the oracle on the configured model and effort', { options: { model: 'sonnet', effort: 'high' } }, async ($, on) => {
    const recorded = engine(on)
    await start($)

    expect(recorded.agents.length).toBe(1)
    const [oracle] = recorded.agents
    expect(oracle?.name).toBe('oracle')
    expect(oracle?.model).toBe('sonnet')
    expect(oracle?.effort).toBe('high')
    expect(oracle?.tools).toEqual(['Read', 'Grep', 'Glob', 'LSP', 'Bash', 'WebSearch', 'WebFetch', 'Agent', 'mcp__oracle__read_thread'])
    expect(oracle?.prompt).toContain('You are the Oracle')
    expect(oracle?.prompt).toContain('read_thread')
    expect(oracle?.description).toContain('Consult the oracle')
    expect(recorded.tools).toEqual([expect.objectContaining({ name: 'read_thread', isDeferred: true })])
  })

  test('defaults to opus at xhigh', async ($, on) => {
    const recorded = engine(on)
    await start($)

    expect(recorded.agents[0]?.model).toBe('opus')
    expect(recorded.agents[0]?.effort).toBe('xhigh')
  })

  test('auto effort leaves the effort unset', { options: { effort: 'auto', model: 'claude-opus-5-5[1m]' } }, async ($, on) => {
    const recorded = engine(on)
    await start($)

    expect(recorded.agents[0]?.model).toBe('claude-opus-5-5[1m]')
    expect(recorded.agents[0]?.effort).toBe(undefined)
  })

  test('an unusable model name falls back to opus', { options: { model: 'not a model' } }, async ($, on) => {
    const recorded = engine(on)
    await start($)

    expect(recorded.agents[0]?.model).toBe('opus')
  })
})

describe('model', () => {
  test('pins a new oracle to the configured model over the call\'s own', { options: { model: 'fable' } }, async ($, on) => {
    const recorded = engine(on)
    await start($)
    await $.agent.spawn({ ...spawn('o1', 'oracle:oracle'), model: 'haiku' })
    await $.agent.spawn({ ...spawn('w1', 'general-purpose'), model: 'haiku' })

    expect(recorded.spawnModels).toEqual(['fable', 'haiku'])
  })

  test('runs an inherit oracle on the parent\'s model', { options: { model: 'inherit' } }, async ($, on) => {
    const recorded = engine(on)
    await start($)
    await $.agent.spawn({ ...spawn('o1', 'oracle:oracle'), model: 'haiku' })

    expect(recorded.spawnModels).toEqual(['claude-opus-5-5'])
  })
})

describe('read-only guard', () => {
  test('refuses writes from the oracle and lets reads through', async ($, on) => {
    engine(on)
    await start($)
    await $.agent.spawn(spawn('o1', 'oracle:oracle'))

    const write = await $.tool.call({ tool: 'Bash', command: 'rm -rf build', agentId: 'o1' })
    expect(write.deny).toContain('"rm" is not a read-only inspection command')

    const redirect = await $.tool.call({ tool: 'Bash', command: 'git diff > patch.diff', agentId: 'o1' })
    expect(redirect.deny).toContain('redirecting output')

    const read = await $.tool.call({ tool: 'Bash', command: 'git diff --stat && git log -5', agentId: 'o1' })
    expect(read.deny).toBe(undefined)
    expect(read.result).toBe('ran')

    const edit = await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b', agentId: 'o1' })
    expect(edit.deny).toContain('Edit is not available to the oracle')

    const general = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', agentId: 'o1' })
    expect(general.deny).toContain('not general-purpose')

    const explore = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'Explore', agentId: 'o1' })
    expect(explore.deny).toBe(undefined)
  })

  test('holds the subagents the oracle delegates to to the same rules', async ($, on) => {
    engine(on)
    await start($)
    await $.agent.spawn(spawn('o1', 'oracle:oracle'))
    await $.agent.spawn(spawn('e1', 'Explore', 'o1'))

    const write = await $.tool.call({ tool: 'Write', file_path: '/repo/x', content: 'x', agentId: 'e1' })
    expect(write.deny).toContain('not available to the oracle')

    const touch = await $.tool.call({ tool: 'Bash', command: 'touch x', agentId: 'e1' })
    expect(touch.deny).toContain('"touch" is not a read-only')

    const refused = await $.agent.spawn(spawn('g1', 'general-purpose', 'o1'))
    expect(refused.deny).toContain('may delegate only to')
  })

  test('leaves the main conversation and unrelated subagents alone', async ($, on) => {
    engine(on)
    await start($)
    await $.agent.spawn(spawn('o1', 'oracle:oracle'))
    await $.agent.spawn(spawn('w1', 'general-purpose'))

    const main = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    expect(main.result).toBe('ran')

    const worker = await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b', agentId: 'w1' })
    expect(worker.result).toBe('ran')

    const spawned = await $.agent.spawn(spawn('g2', 'general-purpose', 'w1'))
    expect(spawned.deny).toBe(undefined)
  })

  test('recognises an oracle it did not see start, by the agent list', async ($, on) => {
    engine(on, [
      { id: 'o9', type: 'oracle:oracle' },
      { id: 'e9', type: 'Explore', parentId: 'o9' },
    ])
    await start($)

    const write = await $.tool.call({ tool: 'Bash', command: 'git commit -m x', agentId: 'e9' })
    expect(write.deny).toContain('"git commit" is not a read-only git command')
  })

  test('honours the extra commands the user allowed', { options: { extra_commands: 'make -n' } }, async ($, on) => {
    engine(on)
    await start($)
    await $.agent.spawn(spawn('o1', 'oracle:oracle'))

    const dryRun = await $.tool.call({ tool: 'Bash', command: 'make -n test', agentId: 'o1' })
    expect(dryRun.deny).toBe(undefined)

    const real = await $.tool.call({ tool: 'Bash', command: 'make test', agentId: 'o1' })
    expect(real.deny).toContain('"make" is not a read-only')
  })
})

describe('permission prompts', () => {
  test("approves the oracle's read-only commands that would only prompt", async ($, on) => {
    engine(on)
    on('tool.check', () => ({ decision: 'ask' as const }))
    await start($)
    await $.agent.spawn(spawn('o1', 'oracle:oracle'))

    const read = await $.tool.check({ tool: 'Bash', input: { command: 'git log -5' }, agentId: 'o1' })
    expect(read.decision).toBe('allow')

    const write = await $.tool.check({ tool: 'Bash', input: { command: 'npm install' }, agentId: 'o1' })
    expect(write.decision).toBe('ask')

    const main = await $.tool.check({ tool: 'Bash', input: { command: 'git log -5' } })
    expect(main.decision).toBe('ask')
  })

  test("keeps the person's own ask rules and denials", async ($, on) => {
    engine(on)
    on('tool.check', (_, e) =>
      String((e.input as { command?: string }).command).startsWith('git log')
        ? { decision: 'ask' as const, rule: 'Bash(git log:*)' }
        : { decision: 'deny' as const, reason: 'denied by rule' },
    )
    await start($)
    await $.agent.spawn(spawn('o1', 'oracle:oracle'))

    const asked = await $.tool.check({ tool: 'Bash', input: { command: 'git log -5' }, agentId: 'o1' })
    expect(asked.decision).toBe('ask')

    const denied = await $.tool.check({ tool: 'Bash', input: { command: 'git diff' }, agentId: 'o1' })
    expect(denied.decision).toBe('deny')
  })
})

describe('read_thread', () => {
  test('gives the oracle the conversation that invoked it', async ($, on) => {
    engine(on)
    on('session.messages', () => ({
      value: [
        { role: 'user' as const, text: 'Why does checkout double-charge?', toolUses: [] },
        { role: 'assistant' as const, text: 'Asking the oracle.', toolUses: [{ tool_use_id: 't1', tool: 'Agent', input: { subagent_type: 'oracle:oracle', description: 'o1', prompt: 'trace it' } }] },
      ],
    }))
    await start($)
    await $.agent.spawn(spawn('o1', 'oracle:oracle'))

    const read = await $.tool.call({ tool: 'mcp__oracle__read_thread', agentId: 'o1' })
    expect(String(read.result)).toContain('Why does checkout double-charge?')
    expect(String(read.result)).toContain('- Agent: oracle:oracle: o1')

    const other = await $.tool.call({ tool: 'mcp__oracle__read_thread' })
    expect(other.deny).toContain('belongs to the oracle')
  })
})

describe('status', () => {
  test('shows a running consultation and clears it when the oracle answers', async ($, on) => {
    const recorded = engine(on)
    await start($)
    await $.agent.spawn(spawn('o1', 'oracle:oracle'))

    expect(recorded.statuses.at(-1)).toContain('oracle thinking · opus · xhigh')

    await $.turn.complete({ answer: 'No blockers.', durationMs: 1000, isAborted: false, turnId: 't', agentId: 'o1', reason: 'answer' })
    expect(recorded.statuses.at(-1)).toBe(undefined)
    expect(recorded.toasts.at(-1)).toContain('The oracle answered')
  })
})
