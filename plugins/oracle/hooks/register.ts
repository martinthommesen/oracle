// The oracle mod: registers the oracle subagent on the model you configure,
// keeps it (and every subagent it delegates to) read-only, and gives it the
// conversation that called it through a read_thread tool.
//
// Without this module (hooks modules switched off, an older Claude Code) the
// plugin still provides agents/oracle.md, the same prompt on fixed defaults.

import type { EngineInterface, Register, Timer, ToolCallInput } from 'claude-code'

import { describeConfig, readConfig } from './config.ts'
import type { OracleConfig } from './config.ts'
import { AGENT_NAME, AGENT_TYPE, ALL_FEATURES, READ_THREAD_TOOL, oracleDescription, oracleInstructions } from './prompts.ts'
import { ALLOWED_SUMMARY, checkShellCommand } from './readonly.ts'
import { renderThread } from './thread.ts'

/** What the oracle may call. */
const ORACLE_TOOLS = ['Read', 'Grep', 'Glob', 'LSP', 'Bash', 'WebSearch', 'WebFetch', 'Agent', READ_THREAD_TOOL]

/** What the oracle and the subagents it delegates to may call: reads, and managing their own subagents. */
const FAMILY_TOOLS = new Set([...ORACLE_TOOLS, 'TodoWrite', 'SendMessage', 'TaskStop', 'TaskOutput'])

/** The subagent types the oracle may delegate to: Claude Code's read-only ones. */
const DELEGATES = new Set(['Explore', 'Plan', 'claude-code-guide'])

const READ_THREAD_DESCRIPTION =
  "Reads the conversation that invoked the oracle: the user's request, what was said and tried, and the tool calls made. Only the oracle subagent can call it."

type Known = { type: string; parent: string | undefined }

/** Every agent this session spawned that the module has seen, by id. A reload empties it; $.agent.list() refills it. */
const agents = new Map<string, Known>()
/** Ids $.agent.list() did not know either (a workflow's agents), so they are not looked up again. */
const unknown = new Set<string>()
/** Running oracle consultations: agent id to start time. */
const consulting = new Map<string, number>()
let ticker: Timer | undefined

async function lookUp($: EngineInterface, agentId: string): Promise<Known | undefined> {
  const known = agents.get(agentId)
  if (known !== undefined || unknown.has(agentId)) return known
  for (const info of await $.agent.list()) {
    if (!agents.has(info.id)) agents.set(info.id, { type: info.type, parent: info.parentId })
  }
  const found = agents.get(agentId)
  if (found === undefined) unknown.add(agentId)
  return found
}

/** Whether `agentId` is an oracle, or a subagent an oracle started (at any depth). */
async function isInFamily($: EngineInterface, agentId: string): Promise<boolean> {
  const seen = new Set<string>()
  let id: string | undefined = agentId
  while (id !== undefined && !seen.has(id)) {
    seen.add(id)
    const known = await lookUp($, id)
    if (known === undefined) return false
    if (known.type === AGENT_TYPE) return true
    id = known.parent
  }
  return false
}

/** The same question from what the module already holds, with no `$` call: for failure handlers. */
function isKnownFamily(agentId: string): boolean {
  let known = agents.get(agentId)
  for (let depth = 0; known !== undefined && depth < 16; depth += 1) {
    if (known.type === AGENT_TYPE) return true
    known = known.parent === undefined ? undefined : agents.get(known.parent)
  }
  return false
}

function bashCommand(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('command' in input)) return undefined
  return typeof input.command === 'string' ? input.command : undefined
}

/** Why the oracle's family may not make this call, or undefined when it may. */
function refusalFor(e: ToolCallInput, config: OracleConfig): string | undefined {
  const tool = String(e.tool)
  if (!FAMILY_TOOLS.has(tool)) {
    return `${tool} is not available to the oracle, which only reads. Use Read, Grep, Glob, read-only Bash, WebSearch, or WebFetch.`
  }
  if (e.tool === 'Bash') {
    if (e.dangerouslyDisableSandbox === true) return 'the oracle runs commands inside the sandbox only.'
    const verdict = checkShellCommand(e.command, config.extraCommands)
    if (!verdict.ok) {
      return `${verdict.reason}. The oracle only runs read-only inspection commands: ${ALLOWED_SUMMARY}. Use Read, Grep, or Glob instead, or say in your answer what you could not check.`
    }
  }
  if (e.tool === 'Agent') {
    const type = e.subagent_type ?? 'general-purpose'
    if (!DELEGATES.has(type)) {
      return `the oracle may delegate only to read-only subagents (${[...DELEGATES].join(', ')}), not ${type}.`
    }
    if (e.isolation !== undefined) return 'the oracle delegates without isolation; its subagents only read.'
  }
  return undefined
}

function elapsed(since: number): string {
  const seconds = Math.round((Date.now() - since) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

function showStatus($: EngineInterface, config: OracleConfig): void {
  if (consulting.size === 0) {
    $.ui.status(undefined)
    ticker?.cancel()
    ticker = undefined
    return
  }
  const oldest = Math.min(...consulting.values())
  const who = consulting.size === 1 ? 'oracle' : `${consulting.size} oracles`
  $.ui.status(`🔮 ${who} thinking · ${describeConfig(config)} · ${elapsed(oldest)}`)
  ticker ??= $.clock.every(1000, () => showStatus($, config))
}

export const register: Register = (on, options) => {
  const { config, warnings } = readConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    showStatus($, config) // a reload starts with no consultation in view
    for (const warning of warnings) $.ui.log(`oracle: ${warning}`)
    try {
      await $.tool.register({
        name: 'read_thread',
        description: READ_THREAD_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            offset: {
              type: 'integer',
              minimum: 0,
              description: 'Index of the first message to read. Leave it out for the most recent messages (with the opening request).',
            },
            limit: { type: 'integer', minimum: 1, description: 'The most messages to return.' },
            include_tool_output: {
              type: 'boolean',
              description: 'Also show what each tool call returned, shortened. Default false.',
            },
          },
          additionalProperties: false,
        },
        isDeferred: true,
      })
    } catch (error) {
      $.ui.log(`oracle: read_thread is unavailable: ${String(error)}`)
    }
    try {
      await $.agent.register({
        name: AGENT_NAME,
        description: oracleDescription(ALL_FEATURES),
        prompt: oracleInstructions(ALL_FEATURES),
        tools: ORACLE_TOOLS,
        model: config.model,
        ...(config.effort === undefined ? {} : { effort: config.effort }),
      })
      $.ui.log(`oracle: ready on ${describeConfig(config)}`, { to: 'debug' })
    } catch (error) {
      $.ui.log(`oracle: could not register the oracle on ${describeConfig(config)} (${String(error)}); the plugin's default oracle stays in use`)
    }
    return started
  })

  // Every spawn is remembered, so a tool call can be traced to the oracle that
  // started its agent; the oracle's own family may only start read-only agents.
  // A new oracle always runs on the configured model: the Agent tool's own
  // model parameter would otherwise let the calling model pick a weaker one.
  on('agent.spawn', async ($, e, next) => {
    if (e.parentAgentId !== undefined && e.resume === undefined && !DELEGATES.has(e.subagentType)) {
      if (await isInFamily($, e.parentAgentId)) {
        return { deny: `oracle (read-only): the oracle may delegate only to ${[...DELEGATES].join(', ')} subagents.` }
      }
    }
    const isNewOracle = e.subagentType === AGENT_TYPE && e.resume === undefined && e.workflow === undefined
    const started = await next(isNewOracle ? { ...e, model: config.model === 'inherit' ? e.parentModel : config.model } : e)
    if (started.agentId !== undefined) {
      agents.set(started.agentId, { type: e.subagentType, parent: e.parentAgentId })
      unknown.delete(started.agentId)
      if (e.subagentType === AGENT_TYPE) {
        $.ui.log(`oracle: consulting on ${started.model}`, { to: 'debug' })
        consulting.set(started.agentId, Date.now())
        showStatus($, config)
      }
    }
    return started
  }).catch(($, e, next) =>
    next.called || e.parentAgentId === undefined || !isKnownFamily(e.parentAgentId) || DELEGATES.has(e.subagentType)
      ? next(e)
      : { deny: 'oracle (read-only): the delegation guard failed, so the spawn was refused.' },
  )

  on('turn.complete', ($, e, next) => {
    const since = e.agentId === undefined ? undefined : consulting.get(e.agentId)
    if (e.agentId !== undefined && since !== undefined) {
      consulting.delete(e.agentId)
      showStatus($, config)
      if (e.reason === 'answer') $.ui.toast(`🔮 The oracle answered after ${elapsed(since)}`)
    }
    return next(e)
  })

  // The guard: the oracle and its subagents only read. Calls from the main
  // conversation and from unrelated subagents pass through untouched.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined || !(await isInFamily($, e.agentId))) return next(e)
    const refusal = refusalFor(e, config)
    return refusal === undefined ? next(e) : { deny: `oracle (read-only): ${refusal}` }
  }).catch(($, e, next) =>
    next.called || e.agentId === undefined || !isKnownFamily(e.agentId)
      ? next(e)
      : { deny: 'oracle (read-only): the read-only guard failed, so the call was refused.' },
  )

  // Commands the guard has judged read-only need no prompt: they would only
  // interrupt the person for a call that cannot change anything. Deny and ask
  // rules, hooks, and settings that decided the verdict keep their word.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.agentId === undefined) return verdict
    if (verdict.rule !== undefined || verdict.hook !== undefined || verdict.plugin !== undefined || verdict.setting !== undefined) {
      return verdict
    }
    if (!(await isInFamily($, e.agentId))) return verdict
    if (e.tool === READ_THREAD_TOOL) return { decision: 'allow', reason: 'oracle: reads its own conversation' }
    const command = e.tool === 'Bash' ? bashCommand(e.input) : undefined
    if (command !== undefined && checkShellCommand(command, config.extraCommands).ok) {
      return { decision: 'allow', reason: 'oracle: read-only inspection command' }
    }
    return verdict
  })

  on('tool.call', { tool: 'mcp__oracle__read_thread' }, async ($, e) => {
    const known = e.agentId === undefined ? undefined : await lookUp($, e.agentId)
    if (known?.type !== AGENT_TYPE) return { deny: 'read_thread belongs to the oracle subagent; it reads the conversation that invoked it.' }
    const rows = known.parent === undefined ? await $.session.messages() : await $.session.messages({ agentId: known.parent })
    if ('deny' in rows) return { deny: `read_thread: ${rows.deny}` }
    return {
      result: renderThread(rows, {
        offset: typeof e.offset === 'number' ? e.offset : undefined,
        limit: typeof e.limit === 'number' ? e.limit : undefined,
        includeToolOutput: e.include_tool_output === true,
      }),
    }
  })
}
