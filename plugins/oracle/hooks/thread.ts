// Renders the conversation that invoked the oracle for its read_thread tool.
//
// The oracle starts with only its task. read_thread lets it read the calling
// conversation the way Amp's read_thread did: the newest messages that fit,
// the opening request always included, and a pointer to page further back.

/** The part of a session transcript row (SessionMessage) this reads. */
export type ThreadRow = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly {
    tool: string
    input: Readonly<Record<string, unknown>>
    text?: string
    isError?: true
  }[]
  toolResults?: readonly unknown[]
}

export type ThreadPage = {
  /** Index (from 0) of the first message to show; default: the newest that fit. */
  offset?: number
  /** Most messages to show. */
  limit?: number
  /** Include what each tool call returned, shortened. */
  includeToolOutput?: boolean
}

export const THREAD_BUDGET = 60_000
const MESSAGE_LIMIT = 6_000
const TOOL_INPUT_LIMIT = 240
const TOOL_OUTPUT_LIMIT = 600

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… [${text.length - limit} more characters]`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The argument that says what a call did: the command, the path, the pattern. */
function describeInput(tool: string, input: Readonly<Record<string, unknown>>): string {
  const pick = (key: string): string | undefined => {
    const value = input[key]
    return typeof value === 'string' ? value : undefined
  }
  const primary =
    pick('command') ??
    pick('file_path') ??
    pick('pattern') ??
    pick('url') ??
    pick('query') ??
    pick('description') ??
    pick('prompt')
  const shown = primary ?? JSON.stringify(input)
  return clip(oneLine(`${tool === 'Agent' && pick('subagent_type') ? `${pick('subagent_type')}: ` : ''}${shown}`), TOOL_INPUT_LIMIT)
}

function renderRow(row: ThreadRow, index: number, includeToolOutput: boolean): string {
  const parts = [`### [${index}] ${row.role}`]
  if (row.text.trim() !== '') parts.push(clip(row.text.trim(), MESSAGE_LIMIT))
  for (const use of row.toolUses) {
    parts.push(`- ${use.tool}: ${describeInput(use.tool, use.input)}${use.isError ? ' (error)' : ''}`)
    if (includeToolOutput && use.text !== undefined && use.text.trim() !== '') {
      parts.push(`  → ${clip(oneLine(use.text), TOOL_OUTPUT_LIMIT)}`)
    }
  }
  return parts.join('\n')
}

/** Rows a reader needs: tool-result carriers are shown under their tool calls. */
function isShown(row: ThreadRow): boolean {
  return row.text.trim() !== '' || row.toolUses.length > 0
}

/**
 * Renders a page of the thread as Markdown, within `budget` characters.
 *
 * Without an offset it shows the newest messages that fit, plus the first
 * message when it is not among them; with one, messages from there on.
 */
export function renderThread(rows: readonly ThreadRow[], page: ThreadPage = {}, budget = THREAD_BUDGET): string {
  const shown = rows.map((row, index) => ({ row, index })).filter(({ row }) => isShown(row))
  const total = shown.length
  if (total === 0) return 'The conversation that invoked the oracle has no messages yet.'
  const includeToolOutput = page.includeToolOutput === true
  const limit = Math.max(1, Math.min(page.limit ?? total, total))
  const blocks = shown.map(({ row }, position) => renderRow(row, position, includeToolOutput))

  let first: number
  let last: number // exclusive
  if (page.offset !== undefined) {
    first = Math.min(Math.max(0, Math.floor(page.offset)), total - 1)
    last = first
    let used = 0
    while (last < total && last - first < limit && (last === first || used + blocks[last]!.length <= budget)) {
      used += blocks[last]!.length
      last += 1
    }
  } else {
    last = total
    first = total
    let used = blocks[0]!.length // room kept for the opening request
    while (first > 0 && last - first < limit && (first === total || used + blocks[first - 1]!.length <= budget)) {
      first -= 1
      if (first !== 0) used += blocks[first]!.length
    }
  }

  const header = [
    `Conversation that invoked the oracle: ${total} messages, showing [${first}]–[${last - 1}].`,
    first > 0 ? `Earlier messages: call read_thread with an offset below ${first}.` : undefined,
    last < total ? `Later messages: call read_thread with offset ${last}.` : undefined,
    includeToolOutput ? undefined : 'Tool output is omitted; pass include_tool_output: true to see it.',
  ].filter(line => line !== undefined)

  const body = blocks.slice(first, last)
  if (first > 0 && page.offset === undefined) body.unshift(blocks[0]!, `… [${first - 1} messages omitted] …`)
  return [header.join('\n'), ...body].join('\n\n')
}
