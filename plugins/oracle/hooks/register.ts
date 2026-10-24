// The oracle mod: registers the oracle subagent on the model you configure,
// keeps it (and every subagent it delegates to) read-only, and gives it the
// conversation that called it through a read_thread tool.
//
// Without this module (hooks modules switched off, an older Claude Code) the
// plugin still provides agents/oracle.md, the same prompt on fixed defaults.

import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import { describeConfig, readConfig } from './config.ts'
import { AGENT_NAME, AGENT_TYPE, ALL_FEATURES, READ_THREAD_NAME, READ_THREAD_TOOL, oracleDescription, oracleInstructions, oracleTools } from './prompts.ts'
import { matchesPrefixes } from './shell.ts'
import { renderThread } from './thread.ts'

const ORACLE_TOOLS = oracleTools(ALL_FEATURES)

/**
 * What the oracle and the subagents it delegates to may call: reads, loading
 * deferred tools, and managing their own subagents (SendMessage and TaskStop
 * only toward the family: see the guard).
 */
const FAMILY_TOOLS = new Set([...ORACLE_TOOLS, 'ToolSearch', 'TodoWrite', 'SendMessage', 'TaskStop', 'TaskOutput'])

/** The subagent types the oracle may delegate to: Claude Code's read-only ones. */
const DELEGATES = new Set(['Explore', 'Plan', 'claude-code-guide'])

const DELEGATION_REFUSAL = `oracle (read-only): the oracle may delegate only to ${[...DELEGATES].join(', ')} subagents.`

const BASH_REFUSAL =
  'oracle (read-only): Claude Code does not judge this command read-only, so the oracle may not run it. Use read-only inspection commands (git log, show, diff, blame, status, grep; rg, grep, find, ls, cat, head, tail, wc, sed -n) run from the working directory without cd, or Read, Grep, and Glob, and say in your answer what you could not check.'

const READ_THREAD_DESCRIPTION =
  "Reads the conversation that invoked the oracle: the user's request, what was said and tried, and the tool calls made. Only the oracle subagent can call it."

type Known = { isOracle: boolean; inFamily: boolean; parent: string | undefined }

/** Every agent of the session the module has seen, classified when it started. A reload empties it; $.agent.list() refills it. */
const agents = new Map<string, Known>()
/** Ids $.agent.list() did not know either (a workflow's agents), so they are not looked up again. */
const unlisted = new Set<string>()
let refreshing: Promise<void> | undefined
/** Running oracle consultations: agent id to start time. */
const consulting = new Map<string, number>()
let ticker: Timer | undefined
let ticks = 0

function remember(id: string, type: string, parent: string | undefined): void {
  const isOracle = type === AGENT_TYPE
  const inFamily = isOracle || (parent !== undefined && agents.get(parent)?.inFamily === true)
  agents.set(id, { isOracle, inFamily, parent })
  unlisted.delete(id)
}

type Started = { type: string; parentId: string | undefined }

/**
 * Finds how the agents `missing` were started, from the Agent calls in the
 * session's transcripts: the main conversation's and each known agent's, a
 * found agent's own transcript included, since it may have started another.
 */
async function findSpawns($: EngineInterface, missing: ReadonlySet<string>, known: readonly string[]): Promise<Map<string, Started>> {
  const found = new Map<string, Started>()
  const read = new Set<string>()
  let pending: (string | undefined)[] = [undefined, ...known]
  while (pending.length > 0 && found.size < missing.size) {
    const next: string[] = []
    for (const spawner of pending) {
      const key = spawner ?? ''
      if (read.has(key)) continue
      read.add(key)
      const rows = spawner === undefined ? await $.session.messages() : await $.session.messages({ agentId: spawner })
      if ('deny' in rows) continue
      for (const use of rows.flatMap(row => row.toolUses)) {
        if (use.tool !== 'Agent' || use.agentId === undefined || !missing.has(use.agentId) || found.has(use.agentId)) continue
        const type = typeof use.input.subagent_type === 'string' ? use.input.subagent_type : 'general-purpose'
        found.set(use.agentId, { type, parentId: spawner })
        next.push(use.agentId)
      }
    }
    pending = next
  }
  return found
}

/** Classifies the listed agents, parents before children. */
async function classify($: EngineInterface, list: readonly AgentInfo[]): Promise<void> {
  const started = new Map<string, Started>(list.map(info => [info.id, { type: info.type, parentId: info.parentId }]))
  // A parent the list no longer holds (a finished agent) is found by the call that started it.
  const missing = new Set(list.flatMap(info => (info.parentId !== undefined && !started.has(info.parentId) && !agents.has(info.parentId) ? [info.parentId] : [])))
  if (missing.size > 0) {
    for (const [id, how] of await findSpawns($, missing, [...started.keys()])) started.set(id, how)
  }
  const visit = (id: string, seen: Set<string>): void => {
    if (agents.has(id) || seen.has(id)) return
    seen.add(id)
    const how = started.get(id)
    if (how === undefined) {
      // Started by an agent no transcript accounts for: it may be an oracle, so its subagents stay guarded.
      agents.set(id, { isOracle: false, inFamily: true, parent: undefined })
      return
    }
    if (how.parentId !== undefined) visit(how.parentId, seen)
    remember(id, how.type, how.parentId)
  }
  for (const info of list) visit(info.id, new Set())
}

/** Fills in the agents started before this module loaded; concurrent callers share one listing. */
function refresh($: EngineInterface): Promise<void> {
  refreshing ??= $.agent
    .list()
    .then(list => classify($, list))
    .finally(() => {
      refreshing = undefined
    })
  return refreshing
}

async function lookUp($: EngineInterface, id: string): Promise<Known | undefined> {
  if (!agents.has(id) && !unlisted.has(id)) {
    const shared = refreshing !== undefined
    await refresh($)
    // A listing already under way may predate this agent: ask once more before caching the miss.
    if (!agents.has(id) && shared) await refresh($)
    if (!agents.has(id)) unlisted.add(id)
  }
  return agents.get(id)
}

/**
 * Whether an agent may be an oracle, or a subagent one started, from what the
 * module holds: for failure handlers. An agent not yet classified (the listing
 * failed or overran) counts, so the guard fails closed for it.
 */
function mayBeFamily(id: string | undefined): boolean {
  return id !== undefined && (agents.get(id)?.inFamily ?? !unlisted.has(id))
}

/** The ids of the session's agents that a SendMessage `to` or TaskStop `task_id` addresses, by id or name. */
async function addressed($: EngineInterface, to: unknown): Promise<string[]> {
  if (typeof to !== 'string') return []
  const name = to.replace(/ \[[^\]]*\]$/, '')
  const list = await $.agent.list()
  return list.filter(info => info.id === to || info.name === name).map(info => info.id)
}

/** Whether every id is the oracle's family (an empty list is not). */
async function allFamily($: EngineInterface, ids: readonly string[]): Promise<boolean> {
  for (const id of ids) if ((await lookUp($, id))?.inFamily !== true) return false
  return true
}

function bashCommand(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('command' in input)) return undefined
  return typeof input.command === 'string' ? input.command : undefined
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** Shows the running consultations in the status line, ticking each second while there are any. */
function showStatus($: EngineInterface, label: string): void {
  if (consulting.size === 0) {
    $.ui.status(undefined)
    ticker?.cancel()
    ticker = undefined
    return
  }
  const who = consulting.size === 1 ? 'oracle' : `${consulting.size} oracles`
  $.ui.status(`🔮 ${who} thinking · ${label} · ${formatDuration(Date.now() - Math.min(...consulting.values()))}`)
  ticker ??= $.clock.every(1000, () => tick($, label))
}

/** Redraws the status each second, and every fifteenth drops consultations whose oracle no longer runs. */
function tick($: EngineInterface, label: string): void {
  ticks += 1
  if (ticks % 15 === 0) void dropFinished($, label).catch(() => showStatus($, label))
  else showStatus($, label)
}

/** A safety net for an oracle whose end no turn.complete reported. */
async function dropFinished($: EngineInterface, label: string): Promise<void> {
  const running = new Set(
    (await $.agent.list()).filter(info => info.status === 'pending' || info.status === 'running' || info.status === 'waiting').map(info => info.id),
  )
  for (const id of consulting.keys()) if (!running.has(id)) consulting.delete(id)
  showStatus($, label)
}

export const register: Register = (on, options) => {
  // Settled at session start, where the environment can be read; nothing below runs before it.
  let config = readConfig(options).config
  let label = describeConfig(config)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const [model, effort, extraCommands] = await Promise.all([
      $.env.get('ORACLE_MODEL'),
      $.env.get('ORACLE_EFFORT'),
      $.env.get('ORACLE_EXTRA_COMMANDS'),
    ])
    const read = readConfig(options, { model, effort, extraCommands })
    config = read.config
    label = describeConfig(config)
    // A running ticker captured the old label: restart it on the new one.
    ticker?.cancel()
    ticker = undefined
    showStatus($, label) // a reload starts with no consultation in view
    for (const warning of read.warnings) $.ui.log(`oracle: ${warning}`)
    const [tool, agent] = await Promise.allSettled([
      $.tool.register({
        name: READ_THREAD_NAME,
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
      }),
      $.agent.register({
        name: AGENT_NAME,
        description: oracleDescription(ALL_FEATURES),
        prompt: oracleInstructions(ALL_FEATURES),
        tools: ORACLE_TOOLS,
        model: config.model,
        ...(config.effort === undefined ? {} : { effort: config.effort }),
      }),
    ])
    if (tool.status === 'rejected') $.ui.log(`oracle: read_thread is unavailable: ${String(tool.reason)}`)
    if (agent.status === 'rejected') {
      $.ui.log(`oracle: could not register the oracle on ${label} (${String(agent.reason)}); the plugin's default oracle stays in use`)
    } else {
      $.ui.log(`oracle: ready on ${label}`, { to: 'debug' })
    }
    return started
  })

  // Every spawn is classified, so a tool call can be traced to the oracle that
  // started its agent, and the oracle's family may only start read-only agents.
  // A new oracle runs on its own definition's model: the Agent tool's model
  // parameter would otherwise let the calling model pick a weaker one.
  on('agent.spawn', async ($, e, next) => {
    const parent = e.parentAgentId === undefined ? undefined : await lookUp($, e.parentAgentId)
    if (parent?.inFamily === true) {
      if (e.resume === undefined && !DELEGATES.has(e.subagentType)) return { deny: DELEGATION_REFUSAL }
      if (e.resume !== undefined && (await lookUp($, e.resume.agentId))?.inFamily !== true) {
        return { deny: 'oracle (read-only): the oracle may resume only the subagents it started.' }
      }
    }
    const isNewOracle = e.subagentType === AGENT_TYPE && e.resume === undefined && e.workflow === undefined
    const started = await next(isNewOracle ? { ...e, model: undefined } : e)
    if (started.agentId !== undefined) {
      // A resumed agent keeps the parent that started it; only a new one is classified here.
      if (e.resume === undefined || !agents.has(started.agentId)) remember(started.agentId, e.subagentType, e.parentAgentId)
      if (e.subagentType === AGENT_TYPE) {
        $.ui.log(`oracle: consulting on ${started.model}`, { to: 'debug' })
        consulting.set(started.agentId, Date.now())
        showStatus($, label)
      }
    }
    return started
  }).catch(($, e, next) =>
    next.called || !mayBeFamily(e.parentAgentId) || DELEGATES.has(e.subagentType) ? next(e) : { deny: DELEGATION_REFUSAL },
  )

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined || !consulting.delete(e.agentId)) return next(e)
    showStatus($, label)
    if (e.reason === 'answer') $.ui.toast(`🔮 The oracle answered after ${formatDuration(e.durationMs)}`)
    return next(e)
  })

  // The guard, part one: the oracle and its subagents only call reading tools.
  // Calls from the main conversation and from unrelated subagents pass through.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined || (await lookUp($, e.agentId))?.inFamily !== true) return next(e)
    if (!FAMILY_TOOLS.has(e.tool)) {
      return { deny: `oracle (read-only): ${e.tool} is not available to the oracle, which only reads. Use Read, Grep, Glob, read-only Bash, WebSearch, or WebFetch.` }
    }
    if (e.tool === 'Bash' && e.dangerouslyDisableSandbox === true) {
      return { deny: 'oracle (read-only): the oracle runs commands inside the sandbox only.' }
    }
    if (e.tool === 'Agent' && e.isolation !== undefined) {
      return { deny: 'oracle (read-only): the oracle delegates without isolation; its subagents only read.' }
    }
    // Messages may reach only the oracle's own subagents: the main conversation
    // or an unrelated agent could be asked to write in its place.
    if (e.tool === 'SendMessage') {
      const ids = await addressed($, e.to)
      if (ids.length === 0 || !(await allFamily($, ids))) {
        return { deny: 'oracle (read-only): the oracle may message only the subagents it started.' }
      }
    }
    if (e.tool === 'TaskStop') {
      const ids = await addressed($, e.task_id ?? e.shell_id)
      if (ids.length === 0 || !(await allFamily($, ids))) {
        return { deny: 'oracle (read-only): the oracle may stop only the subagents it started.' }
      }
    }
    return next(e)
  }).catch(($, e, next) =>
    next.called || !mayBeFamily(e.agentId) ? next(e) : { deny: 'oracle (read-only): the read-only guard failed, so the call was refused.' },
  )

  // The guard, part two: a Bash command runs only when Claude Code judges it
  // read-only, or when it is one of the extra commands the user allowed. The
  // person's own rules keep their word; the only prompts the guard answers are
  // for read_thread and those extra commands, which the person already allowed.
  // (Matchers name tools literally: the validator reads no imported constant.)
  on('tool.check', { tool: ['Bash', 'mcp__oracle__read_thread'] }, async ($, e, next) => {
    const verdict = await next(e)
    if (e.agentId === undefined || verdict.decision === 'deny') return verdict
    if ((await lookUp($, e.agentId))?.inFamily !== true) return verdict
    const onlyPrompts =
      verdict.decision === 'ask' && verdict.rule === undefined && verdict.hook === undefined && verdict.plugin === undefined && verdict.setting === undefined
    if (e.tool === READ_THREAD_TOOL) {
      return onlyPrompts ? { decision: 'allow', reason: 'oracle: reads its own conversation' } : verdict
    }
    if (e.isReadOnly === true) return verdict
    const command = bashCommand(e.input)
    if (command !== undefined && matchesPrefixes(command, config.extraCommands)) {
      return onlyPrompts ? { decision: 'allow', reason: 'oracle: an extra command allowed in /config' } : verdict
    }
    return { decision: 'deny', reason: BASH_REFUSAL }
  }).catch(($, e, next) =>
    mayBeFamily(e.agentId) ? { decision: 'deny', reason: 'oracle (read-only): the read-only guard failed, so the call was refused.' } : next(e),
  )

  on('tool.call', { tool: 'mcp__oracle__read_thread' }, async ($, e) => {
    const known = e.agentId === undefined ? undefined : await lookUp($, e.agentId)
    if (known?.isOracle !== true) return { deny: 'read_thread belongs to the oracle subagent; it reads the conversation that invoked it.' }
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
