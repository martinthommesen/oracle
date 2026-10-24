// A conservative judge of whether a shell command only reads.
//
// The oracle may run inspection commands (git history, search, listings) and
// nothing else. The judge parses the command the way bash would split it into
// simple commands, refuses every construct it cannot see through (command
// substitution, subshells, here-documents, backgrounding, redirection into a
// file), and holds each simple command to an allowlist with per-command rules.
// Anything it does not recognise is refused: a false refusal costs the oracle a
// Read call, a false approval could cost the user their work.

export type Verdict = { ok: true } | { ok: false; reason: string }

type Segment = { words: string[] }

class Refusal extends Error {}

const ALLOW: Verdict = { ok: true }

function refuse(reason: string): never {
  throw new Refusal(reason)
}

// ---------------------------------------------------------------------------
// Tokenizing

const WORD_BREAK = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')'])

/** Reads one shell word starting at `i`; returns its text with quotes removed. */
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
        if (d === '`' || (d === '$' && src[i + 1] === '(')) {
          refuse('command substitution')
        }
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

function skipBlanks(src: string, i: number): number {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i += 1
  return i
}

/** Reads the target word of a redirection operator. */
function readTarget(src: string, i: number): { text: string; end: number } {
  const at = skipBlanks(src, i)
  const word = readWord(src, at)
  if (word.end === at) refuse('a redirection without a target')
  return word
}

/**
 * Splits a command into simple commands, applying the redirection rules as it
 * goes: input from a file and output to /dev/null or another descriptor are
 * allowed; anything that would open a file for writing is refused.
 */
export function splitCommand(src: string): Segment[] {
  const segments: Segment[] = []
  let words: string[] = []
  let i = 0
  let needsCommand = false // after && || |: a command must follow

  const endSegment = (operator: string): void => {
    if (words.length === 0) {
      // A newline after && || | continues the command line, as in bash.
      if (operator === '\n') return
      refuse(`an empty command before "${operator}"`)
    }
    segments.push({ words })
    words = []
    needsCommand = operator === '&&' || operator === '||' || operator === '|' || operator === '|&'
  }

  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t') {
      i += 1
      continue
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2
      continue
    }
    if (c === '\n') {
      endSegment('\n')
      i += 1
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (c === ';') {
      if (src[i + 1] === ';') refuse('";;"')
      endSegment(';')
      i += 1
      continue
    }
    if (c === '&') {
      if (src[i + 1] === '&') {
        endSegment('&&')
        i += 2
        continue
      }
      if (src[i + 1] === '>') {
        // &> file, &>> file: both streams into a file
        const op = src[i + 2] === '>' ? 3 : 2
        const target = readTarget(src, i + op)
        if (target.text !== '/dev/null') refuse(`redirecting output into "${target.text}"`)
        i = target.end
        continue
      }
      refuse('running a command in the background ("&")')
    }
    if (c === '|') {
      if (src[i + 1] === '|') {
        endSegment('||')
        i += 2
      } else if (src[i + 1] === '&') {
        endSegment('|&')
        i += 2
      } else {
        endSegment('|')
        i += 1
      }
      continue
    }
    if (c === '(' || c === ')') refuse('subshells and grouping ("(" or ")")')
    if (c === '<' || c === '>') {
      i = readRedirect(src, i)
      continue
    }
    const word = readWord(src, i)
    i = word.end
    // A word that runs straight into a redirection and is all digits is the
    // descriptor the redirection applies to (2>/dev/null), not an argument.
    if ((src[i] === '>' || src[i] === '<') && /^\d+$/.test(word.text)) {
      i = readRedirect(src, i)
      continue
    }
    words.push(word.text)
  }
  if (words.length > 0) {
    endSegment(';')
  } else if (needsCommand) {
    refuse('a command line that ends in an operator')
  }
  return segments
}

function readRedirect(src: string, i: number): number {
  const c = src[i]!
  const next = src[i + 1]
  if (next === '(') refuse('process substitution')
  if (c === '<') {
    if (next === '<') {
      if (src[i + 2] === '<') return readTarget(src, i + 3).end // here-string
      refuse('here-documents ("<<")')
    }
    if (next === '>') refuse('opening a file for reading and writing ("<>")')
    if (next === '&') {
      const target = readTarget(src, i + 2)
      if (!/^(\d+|-)$/.test(target.text)) refuse(`an unusual redirection ("<&${target.text}")`)
      return target.end
    }
    return readTarget(src, i + 1).end // input from a file: a read
  }
  // c === '>'
  if (next === '&') {
    const target = readTarget(src, i + 2)
    if (/^(\d+|-)$/.test(target.text)) return target.end // 2>&1, >&-
    if (target.text !== '/dev/null') refuse(`redirecting output into "${target.text}"`)
    return target.end
  }
  const op = next === '>' || next === '|' ? 2 : 1
  const target = readTarget(src, i + op)
  if (target.text !== '/dev/null') refuse(`redirecting output into "${target.text}"`)
  return target.end
}

// ---------------------------------------------------------------------------
// Flag helpers

/** The arguments that are not options, given the options that take a value. */
function positionals(args: readonly string[], valueFlags: ReadonlySet<string> = new Set()): string[] {
  const found: string[] = []
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k]!
    if (arg === '--') {
      found.push(...args.slice(k + 1))
      break
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (valueFlags.has(arg)) k += 1
      continue
    }
    found.push(arg)
  }
  return found
}

/**
 * Whether a short-option cluster (`-fn10`) names one of `letters`, reading it
 * as getopt does: the cluster ends at the first option that takes a value.
 */
function clusterHas(arg: string, letters: string, valueLetters = ''): boolean {
  if (!/^-[^-]/.test(arg)) return false
  for (const ch of arg.slice(1)) {
    if (letters.includes(ch)) return true
    if (valueLetters.includes(ch) || !/[A-Za-z]/.test(ch)) return false
  }
  return false
}

function hasLong(args: readonly string[], names: readonly string[]): string | undefined {
  return args.find(arg => names.some(name => arg === name || arg.startsWith(`${name}=`)))
}

/** Builds a rule refusing the given short letters and long options. */
function denyFlags(letters: string, long: readonly string[], valueLetters = ''): Rule {
  return (args, name) => {
    for (const arg of args) {
      if (arg === '--') break
      if (clusterHas(arg, letters, valueLetters)) refuse(`"${name} ${arg}" can write or run something`)
    }
    const bad = hasLong(args, long)
    if (bad !== undefined) refuse(`"${name} ${bad}" can write or run something`)
  }
}

type Rule = (args: string[], name: string) => void

const anyArgs: Rule = () => {}

// ---------------------------------------------------------------------------
// git

const GIT_ALWAYS_READ = new Set([
  'log', 'show', 'diff', 'blame', 'annotate', 'status', 'rev-parse', 'ls-files',
  'ls-tree', 'cat-file', 'grep', 'shortlog', 'describe', 'merge-base', 'rev-list',
  'name-rev', 'for-each-ref', 'show-ref', 'show-branch', 'count-objects',
  'whatchanged', 'range-diff', 'cherry', 'diff-tree', 'diff-index', 'diff-files',
  'ls-remote', 'var', 'check-ignore', 'check-attr', 'check-ref-format',
  'verify-commit', 'verify-tag', 'help', 'version',
])

const GIT_GLOBAL_FLAGS = new Set([
  '--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects', '--bare',
  '--version', '--help', '--exec-path', '--html-path', '--man-path', '--info-path',
])

const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '--git-dir', '--work-tree', '--namespace'])

const gitRule: Rule = args => {
  let k = 0
  while (k < args.length && args[k]!.startsWith('-')) {
    const arg = args[k]!
    if (GIT_GLOBAL_VALUE_FLAGS.has(arg)) {
      k += 2
      continue
    }
    if (/^--(git-dir|work-tree|namespace)=/.test(arg) || GIT_GLOBAL_FLAGS.has(arg)) {
      k += 1
      continue
    }
    if (arg === '-c' || arg.startsWith('--config-env')) refuse('"git -c" changes configuration for the command')
    if (arg === '-p' || arg === '--paginate') refuse('"git --paginate" runs a pager')
    refuse(`the git option "${arg}"`)
  }
  const sub = args[k]
  if (sub === undefined) return
  const rest = args.slice(k + 1)
  const output = hasLong(rest, ['--output', '--output-directory', '--exec'])
  if (output !== undefined) refuse(`"git ${sub} ${output}" writes files`)

  if (GIT_ALWAYS_READ.has(sub)) {
    if (sub === 'grep' && rest.some(arg => arg.startsWith('-O') || arg.startsWith('--open-files-in-pager'))) {
      refuse('"git grep --open-files-in-pager" runs a program')
    }
    return
  }
  switch (sub) {
    case 'branch':
      return gitListOnly(sub, rest, ['-d', '-D', '-m', '-M', '-c', '-C', '-f', '-u', '--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description', '--create-reflog', '--track', '--no-track'], ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'])
    case 'tag':
      return gitListOnly(sub, rest, ['-d', '-a', '-s', '-u', '-m', '-F', '-f', '-e', '--delete', '--annotate', '--sign', '--local-user', '--message', '--file', '--force', '--edit', '--create-reflog'], ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'])
    case 'remote': {
      const verb = positionals(rest)[0]
      if (verb === undefined || verb === 'show' || verb === 'get-url') return
      return refuse(`"git remote ${verb}" changes the repository`)
    }
    case 'stash': {
      const verb = rest[0]
      if (verb === 'list' || verb === 'show') return
      return refuse(`"git stash${verb === undefined ? '' : ` ${verb}`}" changes the working tree`)
    }
    case 'config': {
      const writes = hasLong(rest, ['--add', '--replace-all', '--unset', '--unset-all', '--rename-section', '--remove-section', '--edit']) ?? rest.find(arg => arg === '-e')
      if (writes !== undefined) refuse(`"git config ${writes}" changes configuration`)
      const reads = hasLong(rest, ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '--get-color', '--get-colorbool']) ?? rest.find(arg => arg === '-l')
      const verb = positionals(rest)[0]
      if (reads !== undefined || verb === 'get' || verb === 'list') return
      return refuse('"git config" without --get or --list sets configuration')
    }
    case 'worktree':
      if (rest[0] === 'list') return
      return refuse('"git worktree" other than "list" changes the repository')
    case 'notes':
      if (rest.length === 0 || rest[0] === 'list' || rest[0] === 'show') return
      return refuse(`"git notes ${rest[0]}" changes the repository`)
    case 'submodule':
      if (rest.length === 0 || rest[0] === 'status' || rest[0] === 'summary') return
      return refuse(`"git submodule ${rest[0]}" changes the repository`)
    case 'symbolic-ref':
      if (rest.some(arg => arg === '-d' || arg === '--delete') || positionals(rest, new Set(['-m'])).length > 1) {
        return refuse('"git symbolic-ref" with a new target changes a ref')
      }
      return
    case 'reflog': {
      const verb = rest[0]
      if (verb === undefined || verb === 'show' || verb === 'exists' || verb.startsWith('-')) return
      return refuse(`"git reflog ${verb}" changes the reflog`)
    }
    default:
      return refuse(`"git ${sub}" is not a read-only git command`)
  }
}

/** `git branch` / `git tag`: listing is fine, naming a new one creates it. */
function gitListOnly(sub: string, rest: readonly string[], denied: readonly string[], valueFlags: readonly string[]): void {
  for (const arg of rest) {
    if (arg === '--') break
    const flag = arg.split('=')[0]!
    if (denied.includes(flag)) refuse(`"git ${sub} ${arg}" changes the repository`)
  }
  const listing = rest.some(arg => arg === '--list' || arg === '-l' || arg === '--show-current')
  const names = positionals(rest, new Set(valueFlags))
  if (names.length > 0 && !listing) refuse(`"git ${sub} ${names[0]}" creates a ${sub === 'tag' ? 'tag' : 'branch'}`)
}

// ---------------------------------------------------------------------------
// sed: printing and substitution to stdout only

const SED_ADDRESS = String.raw`(?:\d+(?:~\d+)?|\$|/(?:[^/\\]|\\.)*/I?)`
const SED_RANGE = new RegExp(String.raw`^${SED_ADDRESS}?(?:\s*,\s*(?:${SED_ADDRESS}|[+~]\d+))?\s*!?\s*`)

function checkSedScript(script: string): void {
  for (const raw of script.split(/[;\n]/)) {
    const command = raw.trim()
    if (command === '') continue
    const rest = command.replace(SED_RANGE, '')
    if (/^[pPdDq=n]$/.test(rest) || /^[qQ]\s*\d*$/.test(rest)) continue
    if (rest.startsWith('s') && rest.length > 1) {
      checkSedSubstitution(rest)
      continue
    }
    refuse(`the sed command "${command}" (only printing and substitution to stdout are allowed; use Read with an offset to view lines)`)
  }
}

function checkSedSubstitution(command: string): void {
  const delim = command[1]!
  if (/[\s\\\n]/.test(delim)) refuse(`the sed command "${command}"`)
  let parts = 0
  let k = 2
  while (k < command.length && parts < 2) {
    if (command[k] === '\\') {
      k += 2
      continue
    }
    if (command[k] === delim) parts += 1
    k += 1
  }
  if (parts < 2) refuse(`the sed command "${command}"`)
  const flags = command.slice(k)
  if (!/^[gpiImM0-9]*$/.test(flags)) refuse(`the sed substitution flags "${flags}" (w and e write files or run commands)`)
}

const sedRule: Rule = args => {
  const scripts: string[] = []
  const files: string[] = []
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k]!
    if (arg === '--') {
      files.push(...args.slice(k + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [flag, value] = arg.split(/=(.*)/s) as [string, string | undefined]
      if (flag === '--in-place') refuse('"sed --in-place" edits files')
      if (flag === '--expression') {
        const script = value ?? args[(k += 1)]
        if (script === undefined) refuse('"sed --expression" without a script')
        scripts.push(script)
        continue
      }
      if (flag === '--file') refuse('"sed --file" runs a script this guard cannot read')
      if (['--quiet', '--silent', '--regexp-extended', '--separate', '--null-data', '--posix', '--debug', '--unbuffered', '--sandbox'].includes(flag)) continue
      if (flag === '--line-length') {
        if (value === undefined) k += 1
        continue
      }
      refuse(`the sed option "${arg}"`)
    }
    if (arg.startsWith('-') && arg !== '-') {
      for (let j = 1; j < arg.length; j += 1) {
        const ch = arg[j]!
        if ('nErsuz'.includes(ch)) continue
        if (ch === 'i') refuse('"sed -i" edits files')
        if (ch === 'f') refuse('"sed -f" runs a script this guard cannot read')
        if (ch === 'e' || ch === 'l') {
          const value = arg.slice(j + 1) || args[(k += 1)]
          if (value === undefined) refuse(`"sed -${ch}" without a value`)
          if (ch === 'e') scripts.push(value)
          break
        }
        refuse(`the sed option "-${ch}"`)
      }
      continue
    }
    files.push(arg)
  }
  if (scripts.length === 0) {
    const script = files.shift()
    if (script === undefined) refuse('sed without a script')
    scripts.push(script)
  }
  for (const script of scripts) checkSedScript(script)
}

// ---------------------------------------------------------------------------
// Other commands with rules

function subcommandRule(tool: string, allowed: readonly string[], valueFlags: readonly string[] = []): Rule {
  return args => {
    const verb = positionals(args, new Set(valueFlags))[0]
    if (verb !== undefined && allowed.includes(verb)) return
    refuse(`"${tool}${verb === undefined ? '' : ` ${verb}`}" is not a read-only ${tool} query (allowed: ${allowed.join(', ')})`)
  }
}

const ghRule: Rule = args => {
  const [group, verb] = positionals(args, new Set(['-R', '--repo', '--hostname']))
  const allowed: Record<string, readonly string[]> = {
    pr: ['view', 'diff', 'list', 'checks', 'status'],
    issue: ['view', 'list', 'status'],
    repo: ['view'],
    run: ['view', 'list'],
    release: ['view', 'list'],
    search: ['repos', 'issues', 'prs', 'code', 'commits'],
  }
  if (group === 'api') {
    for (let k = 0; k < args.length; k += 1) {
      const arg = args[k]!
      if (arg === '-X' || arg === '--method' || arg.startsWith('--method=') || /^-X./.test(arg)) {
        const method = arg.startsWith('--method=') ? arg.slice(9) : arg.length > 2 && arg.startsWith('-X') ? arg.slice(2) : args[k + 1]
        if (method?.toUpperCase() !== 'GET') refuse(`"gh api" with method ${method ?? '(none)'}`)
      }
      if (['-f', '-F', '--field', '--raw-field', '--input'].includes(arg.split('=')[0]!)) refuse(`"gh api ${arg}" sends data`)
    }
    return
  }
  if (group !== undefined && verb !== undefined && Object.hasOwn(allowed, group) && allowed[group]!.includes(verb)) return
  refuse(`"gh ${[group, verb].filter(Boolean).join(' ')}" is not a read-only gh command`)
}

const commandRule: Rule = args => {
  if (args.length > 1 && (args[0] === '-v' || args[0] === '-V')) return
  refuse('"command" runs another command; use "command -v NAME"')
}

const uniqRule: Rule = args => {
  if (positionals(args, new Set(['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'])).length > 1) {
    refuse('"uniq" with an output file writes it')
  }
}

const goRule: Rule = args => {
  const verb = positionals(args)[0]
  if (verb === 'doc' || verb === 'version') return
  if (verb === 'env' && !args.some(arg => arg === '-w' || arg === '-u')) return
  refuse(`"go ${verb ?? ''}" is not a read-only go query (allowed: doc, version, env)`)
}

const RULES: Record<string, Rule> = {
  cat: anyArgs, head: anyArgs, wc: anyArgs, ls: anyArgs, pwd: anyArgs, du: anyArgs, df: anyArgs,
  basename: anyArgs, dirname: anyArgs, realpath: anyArgs, readlink: anyArgs, echo: anyArgs,
  printf: anyArgs, true: anyArgs, false: anyArgs, nl: anyArgs, cut: anyArgs, tr: anyArgs,
  column: anyArgs, grep: anyArgs, egrep: anyArgs, fgrep: anyArgs, cmp: anyArgs, comm: anyArgs,
  diff: anyArgs, strings: anyArgs, od: anyArgs, hexdump: anyArgs, md5sum: anyArgs,
  sha1sum: anyArgs, sha256sum: anyArgs, sha512sum: anyArgs, shasum: anyArgs, cksum: anyArgs,
  which: anyArgs, whoami: anyArgs, uname: anyArgs, id: anyArgs, test: anyArgs, '[': anyArgs,
  type: anyArgs, stat: anyArgs, paste: anyArgs, rev: anyArgs, seq: anyArgs, jq: anyArgs,
  cd: anyArgs, fold: anyArgs, expand: anyArgs, unexpand: anyArgs, tac: anyArgs,
  tail: denyFlags('fF', ['--follow', '--retry'], 'cns'),
  sort: denyFlags('o', ['--output', '--compress-program'], 'ktST'),
  tree: denyFlags('oR', ['--output'], 'LPIHT'),
  file: denyFlags('C', ['--compile'], 'efFmP'),
  date: denyFlags('s', ['--set'], 'dfrI'),
  yq: denyFlags('i', ['--inplace']),
  find: (args, name) => {
    const bad = args.find(arg => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg))
    if (bad !== undefined) refuse(`"${name} ${bad}" can write or run something`)
  },
  fd: denyFlags('xX', ['--exec', '--exec-batch'], 'edtEcSj'),
  fdfind: denyFlags('xX', ['--exec', '--exec-batch'], 'edtEcSj'),
  rg: (args, name) => {
    const bad = hasLong(args, ['--pre', '--hostname-bin'])
    if (bad !== undefined) refuse(`"${name} ${bad}" runs a program`)
  },
  uniq: uniqRule,
  sed: sedRule,
  git: gitRule,
  gh: ghRule,
  command: commandRule,
  npm: subcommandRule('npm', ['ls', 'list', 'll', 'la', 'view', 'v', 'info', 'show', 'explain', 'why', 'outdated'], ['--prefix', '-w', '--workspace']),
  pnpm: subcommandRule('pnpm', ['list', 'ls', 'why', 'outdated'], ['-C', '--dir', '--filter', '-F']),
  yarn: subcommandRule('yarn', ['why', 'info', 'list']),
  cargo: subcommandRule('cargo', ['tree'], ['--manifest-path', '-p', '--package']),
  pip: subcommandRule('pip', ['show', 'list', 'freeze']),
  pip3: subcommandRule('pip3', ['show', 'list', 'freeze']),
  go: goRule,
}

/** Commands the guard names when it refuses one, so the oracle knows the set. */
export const ALLOWED_SUMMARY =
  'git (log, show, diff, blame, status, grep, ls-files, rev-parse, branch/tag listing, …), rg, grep, find, fd, ls, tree, cat, head, tail, wc, sed -n, sort, uniq, cut, jq, diff, stat, file, gh (pr/issue view, api GET), npm/pnpm/yarn ls·why·view, and any command with only --version or --help'

// Variables a command may be prefixed with: they change formatting, never what runs.
const FORMATTING_VARIABLES = new Set(['LC_ALL', 'LANG', 'LC_MESSAGES', 'LC_CTYPE', 'NO_COLOR', 'TERM', 'COLUMNS'])
const PAGER_VARIABLES = new Set(['GIT_PAGER', 'PAGER'])

function isSafeAssignment(word: string): boolean {
  const [name, value] = word.split(/=(.*)/s) as [string, string]
  if (FORMATTING_VARIABLES.has(name)) return true
  return PAGER_VARIABLES.has(name) && (value === '' || value === 'cat')
}

function checkSimpleCommand(words: readonly string[], extra: readonly (readonly string[])[]): void {
  let k = 0
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!)) {
    if (!isSafeAssignment(words[k]!)) refuse(`setting "${words[k]!.split('=')[0]}" for the command`)
    k += 1
  }
  const command = words.slice(k)
  const name = command[0]
  if (name === undefined) return // a bare assignment only sets a shell variable
  if (extra.some(prefix => prefix.length > 0 && prefix.every((token, j) => command[j] === token))) return
  if (name.includes('/')) refuse(`running "${name}" by path`)
  const args = command.slice(1)
  if (args.length === 1 && (args[0] === '--version' || args[0] === '--help')) return
  if (!Object.hasOwn(RULES, name)) refuse(`"${name}" is not a read-only inspection command`)
  RULES[name]!(args, name)
}

/** Parses comma-separated extra command prefixes, such as "make -n, bazel query". */
export function parseExtraPrefixes(value: string): string[][] {
  return value
    .split(',')
    .map(entry => entry.trim().split(/\s+/).filter(Boolean))
    .filter(prefix => prefix.length > 0)
}

/**
 * Judges a shell command: `{ ok: true }` when every part of it only reads, else
 * the first reason it does not, phrased for the oracle to read.
 *
 * @param extra command prefixes the user allowed on top of the built-in set
 */
export function checkShellCommand(command: string, extra: readonly (readonly string[])[] = []): Verdict {
  try {
    if (command.trim() === '') refuse('an empty command')
    for (const segment of splitCommand(command)) checkSimpleCommand(segment.words, extra)
    return ALLOW
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message }
    throw error
  }
}
