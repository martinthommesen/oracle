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
}

type ThreadPage = {
  /** Index (from 0) of the first message to show; default: the newest that fit. */
  offset?: number
  /** Most messages to show, the pinned opening request included. */
  limit?: number
  /** Include what each tool call returned, shortened. */
  includeToolOutput?: boolean
}

const THREAD_BUDGET = 60_000
const MESSAGE_LIMIT = 6_000
const TOOL_INPUT_LIMIT = 240
const TOOL_OUTPUT_LIMIT = 600

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… [${text.length - limit} more characters]`
}

/** `text` on one line, at most `limit` characters; only the head is normalized. */
function clipLine(text: string, limit: number): string {
  const line = text.slice(0, limit * 2).replace(/\s+/g, ' ').trim()
  if (line.length <= limit && text.length <= limit * 2) return line
  return `${line.slice(0, limit)}… [cut from ${text.length} characters]`
}

/** The argument that says what a call did: the command, the path, the pattern. */
function describeInput(tool: string, input: Readonly<Record<string, unknown>>): string {
  const pick = (key: string): string | undefined => {
    const value = input[key]
    return typeof value === 'string' ? value : undefined
  }
  const shown =
    pick('command') ??
    pick('file_path') ??
    pick('pattern') ??
    pick('url') ??
    pick('query') ??
    pick('description') ??
    pick('prompt') ??
    JSON.stringify(input)
  const type = tool === 'Agent' ? pick('subagent_type') : undefined
  return clipLine(type === undefined ? shown : `${type}: ${shown}`, TOOL_INPUT_LIMIT)
}

function renderRow(row: ThreadRow, index: number, includeToolOutput: boolean): string {
  const parts = [`### [${index}] ${row.role}`]
  const text = row.text.trim()
  if (text !== '') parts.push(clip(text, MESSAGE_LIMIT))
  for (const use of row.toolUses) {
    parts.push(`- ${use.tool}: ${describeInput(use.tool, use.input)}${use.isError ? ' (error)' : ''}`)
    if (includeToolOutput && use.text !== undefined && use.text.trim() !== '') {
      parts.push(`  → ${clipLine(use.text, TOOL_OUTPUT_LIMIT)}`)
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
 * message when it is not among them; with one, messages from there on. Only
 * the messages it shows are rendered.
 */
export function renderThread(rows: readonly ThreadRow[], page: ThreadPage = {}, budget = THREAD_BUDGET): string {
  const shown = rows.filter(isShown)
  const total = shown.length
  if (total === 0) return 'The conversation that invoked the oracle has no messages yet.'
  const includeToolOutput = page.includeToolOutput === true
  const limit = Math.max(1, Math.min(page.limit ?? total, total))
  const blocks = new Map<number, string>()
  const block = (index: number): string => {
    let rendered = blocks.get(index)
    if (rendered === undefined) {
      rendered = renderRow(shown[index]!, index, includeToolOutput)
      blocks.set(index, rendered)
    }
    return rendered
  }

  let first: number
  let last: number // exclusive
  if (page.offset !== undefined) {
    first = Math.min(Math.max(0, Math.floor(page.offset)), total - 1)
    last = first
    let used = 0
    while (last < total && last - first < limit && (last === first || used + block(last).length <= budget)) {
      used += block(last).length
      last += 1
    }
  } else {
    // The newest messages that fit, keeping room for the opening request, which
    // is pinned above them and counts toward the limit (unless the limit is 1).
    const tail = limit > 1 ? limit - 1 : 1
    last = total
    first = total
    let used = block(0).length
    while (first > 0 && last - first < tail && (first === total || used + block(first - 1).length <= budget)) {
      first -= 1
      if (first !== 0) used += block(first).length
    }
    if (first === 1 && limit > 1) first = 0 // the opening request is shown anyway: nothing lies between
  }

  const header = [
    `Conversation that invoked the oracle: ${total} messages, showing [${first}]–[${last - 1}].`,
    first > 0 ? `Earlier messages: call read_thread with an offset below ${first}.` : undefined,
    last < total ? `Later messages: call read_thread with offset ${last}.` : undefined,
    includeToolOutput ? undefined : 'Tool output is omitted; pass include_tool_output: true to see it.',
  ].filter(line => line !== undefined)

  const body = Array.from({ length: last - first }, (_, k) => block(first + k))
  if (first > 0 && page.offset === undefined && limit > 1) body.unshift(block(0), `… [${first - 1} messages omitted] …`)
  return [header.join('\n'), ...body].join('\n\n')
}
