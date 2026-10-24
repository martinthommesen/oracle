// Matching shell commands against the extra commands the user allowed.
//
// Claude Code judges whether a command only reads; the oracle's guard trusts
// that judgment. A user may also allow command prefixes Claude Code does not
// judge read-only, such as "make -n". A prefix must not smuggle anything else
// in, so a command matches only when it splits into simple commands that each
// start with an allowed prefix, with nothing bash would run or open on the
// side: no command substitution, subshells, here-documents, backgrounding,
// variable assignments, or redirection into anything but /dev/null.

class Refusal extends Error {}

function refuse(reason: string): never {
  throw new Refusal(reason)
}

const WORD_BREAK = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')'])
const DESCRIPTOR = /^(\d+|-)$/

/** Reads one shell word starting at `start`; returns its text with quotes removed. */
function readWord(src: string, start: number): { text: string; end: number } {
  let text = ''
  let i = start
  while (i < src.length) {
    const c = src[i]!
    if (WORD_BREAK.has(c)) break
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2
        continue
      }
      if (i + 1 >= src.length) refuse('a trailing backslash')
      text += src[i + 1]
      i += 2
      continue
    }
    if (c === "'") {
      const close = src.indexOf("'", i + 1)
      if (close === -1) refuse('an unterminated single quote')
      text += src.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (c === '"') {
      i += 1
      for (;;) {
        if (i >= src.length) refuse('an unterminated double quote')
        const d = src[i]!
        if (d === '"') {
          i += 1
          break
        }
        if (d === '`' || (d === '$' && src[i + 1] === '(')) refuse('command substitution')
        if (d === '\\' && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1]!)) {
          if (src[i + 1] !== '\n') text += src[i + 1]
          i += 2
          continue
        }
        text += d
        i += 1
      }
      continue
    }
    if (c === '`') refuse('command substitution')
    if (c === '$') {
      if (src[i + 1] === '(') refuse('command substitution')
      if (src[i + 1] === "'") refuse("ANSI-C quoting ($'...')")
    }
    text += c
    i += 1
  }
  return { text, end: i }
}

/** Reads the target word of a redirection operator that ends at `i`. */
function readTarget(src: string, i: number): { text: string; end: number } {
  let at = i
  while (src[at] === ' ' || src[at] === '\t') at += 1
  const word = readWord(src, at)
  if (word.end === at) refuse('a redirection without a target')
  return word
}

/** Reads a redirection target that may only be /dev/null. */
function readNullTarget(src: string, i: number): number {
  const target = readTarget(src, i)
  if (target.text !== '/dev/null') refuse(`redirecting output into "${target.text}"`)
  return target.end
}

/** Reads a redirection at `i`: input from a file, output to /dev/null or another descriptor. */
function readRedirect(src: string, i: number): number {
  const next = src[i + 1]
  if (next === '(') refuse('process substitution')
  if (src[i] === '<') {
    if (next === '<') {
      if (src[i + 2] === '<') return readTarget(src, i + 3).end // a here-string
      refuse('here-documents ("<<")')
    }
    if (next === '>') refuse('opening a file for reading and writing ("<>")')
    if (next === '&') {
      const target = readTarget(src, i + 2)
      if (!DESCRIPTOR.test(target.text)) refuse(`an unusual redirection ("<&${target.text}")`)
      return target.end
    }
    return readTarget(src, i + 1).end
  }
  const end = i + (next === '&' || next === '>' || next === '|' ? 2 : 1)
  if (next === '&') {
    const target = readTarget(src, end)
    if (DESCRIPTOR.test(target.text)) return target.end // 2>&1, >&-
  }
  return readNullTarget(src, end)
}

/**
 * Splits a command line into its simple commands (each a list of words, quotes
 * removed), refusing what bash would run or open beyond them.
 */
export function splitCommand(src: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let i = 0
  let needsCommand = false // after && || |, a command must follow

  const end = (operator: string): void => {
    if (words.length === 0) {
      if (operator === '\n') return // a newline after && || | continues the line
      refuse(`an empty command before "${operator}"`)
    }
    commands.push(words)
    words = []
    needsCommand = operator !== ';' && operator !== '\n'
  }

  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t') {
      i += 1
    } else if (c === '\\' && src[i + 1] === '\n') {
      i += 2
    } else if (c === '\n') {
      end('\n')
      i += 1
    } else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1
    } else if (c === ';') {
      if (src[i + 1] === ';') refuse('";;"')
      end(';')
      i += 1
    } else if (c === '&') {
      if (src[i + 1] === '&') {
        end('&&')
        i += 2
      } else if (src[i + 1] === '>') {
        i = readNullTarget(src, i + (src[i + 2] === '>' ? 3 : 2)) // &> and &>>: both streams
      } else {
        refuse('running a command in the background ("&")')
      }
    } else if (c === '|') {
      const operator = src[i + 1] === '|' ? '||' : src[i + 1] === '&' ? '|&' : '|'
      end(operator)
      i += operator.length
    } else if (c === '(' || c === ')') {
      refuse('subshells and grouping ("(" or ")")')
    } else if (c === '<' || c === '>') {
      i = readRedirect(src, i)
    } else {
      const word = readWord(src, i)
      i = word.end
      // A word of digits running straight into a redirection names its descriptor (2>/dev/null).
      if ((src[i] === '>' || src[i] === '<') && /^\d+$/.test(word.text)) {
        i = readRedirect(src, i)
      } else {
        words.push(word.text)
      }
    }
  }
  if (words.length > 0) end(';')
  else if (needsCommand) refuse('a command line that ends in an operator')
  return commands
}

/** Parses comma-separated command prefixes, such as "make -n, gh pr view". */
export function parseExtraPrefixes(value: string): string[][] {
  return value
    .split(',')
    .map(entry => entry.trim().split(/\s+/).filter(Boolean))
    .filter(prefix => prefix.length > 0)
}

/**
 * Whether every simple command of `command` starts with one of `prefixes`,
 * with nothing else run or opened beside them.
 */
export function matchesPrefixes(command: string, prefixes: readonly (readonly string[])[]): boolean {
  if (prefixes.length === 0) return false
  try {
    const commands = splitCommand(command)
    return (
      commands.length > 0 &&
      commands.every(words => prefixes.some(prefix => prefix.every((token, k) => words[k] === token)))
    )
  } catch (error) {
    if (error instanceof Refusal) return false
    throw error
  }
}
