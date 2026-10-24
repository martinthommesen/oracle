// Hook-level tests, run by `claude plugin test plugins/oracle`. The hooks a
// test registers with `on` sit beneath the plugin and stand for the engine.

import type { AgentSpawnInput, On, SessionMessage, ToolCheckResult } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

type Spec = { name: string; model?: string; effort?: string | number; tools?: readonly string[]; prompt: string; description: string }
type Recorded = {
  agents: Spec[]
  tools: { name: string; isDeferred?: boolean }[]
  statuses: (string | undefined)[]
  toasts: string[]
  spawnModels: (string | undefined)[]
}
type Listed = { id: string; type: string; parentId?: string }

/**
 * Stands in for the engine: records registrations, starts every spawn under
 * its `description` as the agent id, answers every tool call with "ran" and
 * every permission check with `verdict`.
 */
function engine(
  on: On,
  { list = [], verdict = { decision: 'allow' }, env = {} }: { list?: Listed[]; verdict?: ToolCheckResult; env?: Record<string, string> } = {},
): Recorded {
  const recorded: Recorded = { agents: [], tools: [], statuses: [], toasts: [], spawnModels: [] }
  mock.clock(on)
  mock.env(on, env)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.register', (_, e) => {
    recorded.agents.push(e)
    return { value: { agent: `oracle:${e.name}` } }
  })
  on('tool.register', (_, e) => {
    recorded.tools.push(e)
    return { value: { tool: `mcp__oracle__${e.name}` } }
  })
  on('agent.list', () => ({ value: list.map(agent => ({ ...agent, description: '', status: 'running' as const })) }))
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
  on('tool.check', () => verdict)
  on('tool.call', () => ({ result: 'ran' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return recorded
}

/** An agent.spawn as the engine raises it; the stub above answers `id` as the agent id. */
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

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

/** An assistant row whose Agent call started `agentId` as `subagentType`. */
function started(agentId: string, subagentType: string): SessionMessage {
  return {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: `toolu_${agentId}`, tool: 'Agent', input: { subagent_type: subagentType, description: agentId, prompt: 'task' }, agentId }],
  }
}

/** Starts the session with an oracle o1 and, under it, an Explore subagent e1. */
async function withOracle($: Engine): Promise<void> {
  await start($)
  await $.agent.spawn(spawn('o1', 'oracle:oracle'))
  await $.agent.spawn(spawn('e1', 'Explore', 'o1'))
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
    expect(oracle?.prompt).toContain('A guard enforces this')
    expect(oracle?.prompt).toContain('read_thread')
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

  test('environment variables override the /config rows', { options: { model: 'sonnet', effort: 'high' } }, async ($, on) => {
    const recorded = engine(on, { env: { ORACLE_MODEL: 'fable', ORACLE_EFFORT: 'max', ORACLE_EXTRA_COMMANDS: 'make -n' } })
    await start($)

    expect(recorded.agents[0]?.model).toBe('fable')
    expect(recorded.agents[0]?.effort).toBe('max')
    await $.agent.spawn(spawn('o1', 'oracle:oracle'))
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'make -n test' }, agentId: 'o1' })).decision).toBe('allow')
    expect(recorded.statuses.at(-1)).toContain('fable · max')
  })

  test('an unusable model name falls back to opus', { options: { model: 'not a model' } }, async ($, on) => {
    const recorded = engine(on)
    await start($)

    expect(recorded.agents[0]?.model).toBe('opus')
  })
})

describe('model', () => {
  test("drops the model a caller names for a new oracle, so the oracle's own applies", async ($, on) => {
    const recorded = engine(on)
    await start($)
    await $.agent.spawn({ ...spawn('o1', 'oracle:oracle'), model: 'haiku' })
    await $.agent.spawn({ ...spawn('w1', 'general-purpose'), model: 'haiku' })

    expect(recorded.spawnModels).toEqual([undefined, 'haiku'])
  })
})

describe('tools the oracle may call', () => {
  test('refuses tools that write, for the oracle and the subagents it started', async ($, on) => {
    engine(on)
    await withOracle($)

    expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b', agentId: 'o1' })).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'Write', file_path: '/repo/x', content: 'x', agentId: 'e1' })).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'Explore', isolation: 'worktree', agentId: 'o1' })).deny).toBeDefined()

    const read = await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts', agentId: 'o1' })
    expect(read.result).toBe('ran')
    const explore = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'Explore', agentId: 'o1' })
    expect(explore.result).toBe('ran')
  })

  test('leaves the main conversation and unrelated subagents alone', async ($, on) => {
    engine(on)
    await withOracle($)
    await $.agent.spawn(spawn('w1', 'general-purpose'))

    expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })).result).toBe('ran')
    expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b', agentId: 'w1' })).result).toBe('ran')
  })

  test('lets the oracle message and stop only the subagents it started', async ($, on) => {
    engine(on, {
      list: [
        { id: 'o1', type: 'oracle:oracle' },
        { id: 'e1', type: 'Explore', parentId: 'o1' },
        { id: 'w1', type: 'general-purpose' },
      ],
    })
    await withOracle($)
    await $.agent.spawn(spawn('w1', 'general-purpose'))

    expect((await $.tool.call({ tool: 'SendMessage', to: 'e1', message: 'go on', agentId: 'o1' })).result).toBe('ran')
    expect((await $.tool.call({ tool: 'SendMessage', to: 'main', message: 'edit a.ts', agentId: 'o1' })).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'SendMessage', to: 'w1', message: 'edit a.ts', agentId: 'e1' })).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'TaskStop', task_id: 'e1', agentId: 'o1' })).result).toBe('ran')
    expect((await $.tool.call({ tool: 'TaskStop', task_id: 'w1', agentId: 'o1' })).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'TaskStop', task_id: 'b7x2k', agentId: 'o1' })).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'SendMessage', to: 'w1', message: 'hi' })).result).toBe('ran')
  })

  test('lets the oracle delegate only to read-only subagent types', async ($, on) => {
    engine(on)
    await withOracle($)
    await $.agent.spawn(spawn('w1', 'general-purpose'))

    expect((await $.agent.spawn(spawn('g1', 'general-purpose', 'o1'))).deny).toBeDefined()
    expect((await $.agent.spawn(spawn('g2', 'general-purpose', 'e1'))).deny).toBeDefined()
    expect((await $.agent.spawn(spawn('p1', 'Plan', 'o1'))).deny).toBe(undefined)
    expect((await $.agent.spawn(spawn('g3', 'general-purpose', 'w1'))).deny).toBe(undefined)
  })

  test('lets the oracle resume only its own subagents, which stay guarded', async ($, on) => {
    engine(on)
    await withOracle($)
    await $.agent.spawn(spawn('x1', 'Explore'))

    expect((await $.agent.spawn({ ...spawn('x1', 'Explore', 'o1'), resume: { agentId: 'x1' } })).deny).toBeDefined()
    expect((await $.agent.spawn({ ...spawn('e1', 'Explore', 'o1'), resume: { agentId: 'e1' } })).deny).toBe(undefined)
    // The main conversation resuming the oracle's subagent leaves it the oracle's.
    expect((await $.agent.spawn({ ...spawn('e1', 'Explore'), resume: { agentId: 'e1' } })).deny).toBe(undefined)
    expect((await $.tool.call({ tool: 'Write', file_path: '/repo/x', content: 'x', agentId: 'e1' })).deny).toBeDefined()
  })
})

describe('shell commands', () => {
  test("runs a command Claude Code judges read-only, and refuses one it doesn't", async ($, on) => {
    engine(on)
    await withOracle($)

    const read = await $.tool.check({ tool: 'Bash', input: { command: 'git log -5' }, agentId: 'o1', isReadOnly: true })
    expect(read.decision).toBe('allow')

    for (const agentId of ['o1', 'e1']) {
      const write = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, agentId })
      expect(write.decision).toBe('deny')
      expect(write.reason).toContain('read-only')
    }
  })

  test('leaves the main conversation and unrelated subagents to the person', async ($, on) => {
    engine(on, { verdict: { decision: 'ask' } })
    await start($)
    await $.agent.spawn(spawn('w1', 'general-purpose'))

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })).decision).toBe('ask')
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, agentId: 'w1' })).decision).toBe('ask')
  })

  test("keeps the person's own rules, read-only or not", async ($, on) => {
    engine(on, { verdict: { decision: 'ask', rule: 'Bash(git log:*)' } })
    await withOracle($)

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git log -5' }, agentId: 'o1', isReadOnly: true })).decision).toBe('ask')
  })

  test("keeps the engine's refusal", async ($, on) => {
    engine(on, { verdict: { decision: 'deny', reason: 'denied by rule' } })
    await withOracle($)

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git log' }, agentId: 'o1', isReadOnly: true })).reason).toBe('denied by rule')
  })

  test('runs the extra commands the user allowed, without a prompt', { options: { extra_commands: 'make -n, gh pr view' } }, async ($, on) => {
    engine(on, { verdict: { decision: 'ask' } })
    await withOracle($)

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'make -n test | head' }, agentId: 'o1' })).decision).toBe('deny')
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'gh pr view 12 && make -n test' }, agentId: 'o1' })).decision).toBe('allow')
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'make test' }, agentId: 'o1' })).decision).toBe('deny')
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'make -n $(rm -rf build)' }, agentId: 'o1' })).decision).toBe('deny')
  })

  test('recognises an oracle it did not see start, by the agent list', async ($, on) => {
    engine(on, {
      list: [
        { id: 'o9', type: 'oracle:oracle' },
        { id: 'e9', type: 'Explore', parentId: 'o9' },
      ],
    })
    await start($)

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git commit -m x' }, agentId: 'e9' })).decision).toBe('deny')
    expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b', agentId: 'e9' })).deny).toBeDefined()
  })

  test('traces a subagent whose oracle has left the agent list, by the call that started it', async ($, on) => {
    engine(on, { list: [{ id: 'e9', type: 'Explore', parentId: 'o9' }, { id: 'e8', type: 'Explore', parentId: 'g8' }] })
    on('session.messages', (_, e) => ({ value: e.agentId === undefined ? [started('o9', 'oracle:oracle'), started('g8', 'general-purpose')] : [] }))
    await start($)

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git commit -m x' }, agentId: 'e9' })).decision).toBe('deny')
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git commit -m x' }, agentId: 'e8' })).decision).toBe('allow')
  })

  test('keeps a subagent guarded when no transcript says who started it', async ($, on) => {
    engine(on, { list: [{ id: 'e9', type: 'Explore', parentId: 'gone' }] })
    on('session.messages', () => ({ value: [] }))
    await start($)

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git commit -m x' }, agentId: 'e9' })).decision).toBe('deny')
  })
})

describe('read_thread', () => {
  test('gives the oracle the conversation that invoked it, without a prompt', async ($, on) => {
    engine(on, { verdict: { decision: 'ask' } })
    on('session.messages', () => ({
      value: [
        { role: 'user' as const, text: 'Why does checkout double-charge?', toolUses: [] },
        { role: 'assistant' as const, text: 'Asking the oracle.', toolUses: [{ tool_use_id: 't1', tool: 'Agent', input: { subagent_type: 'oracle:oracle', description: 'o1', prompt: 'trace it' } }] },
      ],
    }))
    await withOracle($)

    expect((await $.tool.check({ tool: 'mcp__oracle__read_thread', input: {}, agentId: 'o1' })).decision).toBe('allow')
    const read = await $.tool.call({ tool: 'mcp__oracle__read_thread', agentId: 'o1' })
    expect(String(read.result)).toContain('Why does checkout double-charge?')
    expect(String(read.result)).toContain('- Agent: oracle:oracle: o1')

    expect((await $.tool.call({ tool: 'mcp__oracle__read_thread' })).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'mcp__oracle__read_thread', agentId: 'e1' })).deny).toBeDefined()
  })
})

describe('status', () => {
  test('shows a running consultation and clears it when the oracle answers', async ($, on) => {
    const recorded = engine(on)
    await start($)
    await $.agent.spawn(spawn('o1', 'oracle:oracle'))

    expect(recorded.statuses.at(-1)).toContain('oracle thinking · opus · xhigh')

    await $.turn.complete({ answer: 'No blockers.', durationMs: 125_000, isAborted: false, turnId: 't', agentId: 'o1', reason: 'answer' })
    expect(recorded.statuses.at(-1)).toBe(undefined)
    expect(recorded.toasts.at(-1)).toContain('answered after 2m 05s')
  })
})
