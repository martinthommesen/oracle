import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { matchesPrefixes, parseExtraPrefixes, splitCommand } from '../plugins/oracle/hooks/shell.ts'

describe('splitCommand', () => {
  it('splits on control operators and removes quotes', () => {
    assert.deepEqual(splitCommand(`make -n test && make -n 'a b' | head -50; ls "x y"`), [
      ['make', '-n', 'test'],
      ['make', '-n', 'a b'],
      ['head', '-50'],
      ['ls', 'x y'],
    ])
  })

  it('drops allowed redirections and comments', () => {
    assert.deepEqual(splitCommand('make -n 2>/dev/null >/dev/null 2>&1 &>/dev/null < in.txt # note'), [['make', '-n']])
  })

  it('continues a command line after && on the next line', () => {
    assert.deepEqual(splitCommand('make -n a &&\n  make -n b'), [
      ['make', '-n', 'a'],
      ['make', '-n', 'b'],
    ])
  })

  it('keeps an escaped dollar and expansions as text', () => {
    assert.deepEqual(splitCommand('echo \\$HOME "$PWD" ${USER}'), [['echo', '$HOME', '$PWD', '${USER}']])
  })

  const refusals: [string, RegExp][] = [
    ['make -n > out.txt', /redirecting output into "out.txt"/],
    ['make -n >> out.txt', /redirecting output/],
    ['make -n &> out.txt', /redirecting output/],
    ['make -n >| out.txt', /redirecting output/],
    ['make -n 2> err.txt', /redirecting output/],
    ['make -n >& out.txt', /redirecting output/],
    ['cat <<EOF\nhi\nEOF', /here-documents/],
    ['cat <> f', /reading and writing/],
    ['make -n $(rm -rf /)', /command substitution/],
    ['make -n "$(whoami)"', /command substitution/],
    ['make -n `whoami`', /command substitution/],
    ["make -n $'\\x41'", /ANSI-C/],
    ['make -n "$\\\n(touch pwned)"', /command substitution/],
    ['make -n $\\\n\\\n(touch pwned)', /command substitution/],
    ["make -n $\\\n'\\'' ; touch pwned ; #'", /ANSI-C/],
    ['diff <(ls a) <(ls b)', /process substitution/],
    ['(make -n)', /subshells/],
    ['make -n &', /background/],
    ['make -n &&', /ends in an operator/],
    ['&& make -n', /empty command/],
    ['true;; ls', /";;"/],
    ["echo 'open", /unterminated/],
  ]
  for (const [command, reason] of refusals) {
    it(`refuses ${JSON.stringify(command)}`, () => assert.throws(() => splitCommand(command), reason))
  }
})

describe('parseExtraPrefixes', () => {
  it('parses a comma-separated list', () => {
    assert.deepEqual(parseExtraPrefixes(' make -n, gh pr view ,, '), [['make', '-n'], ['gh', 'pr', 'view']])
    assert.deepEqual(parseExtraPrefixes(''), [])
    assert.deepEqual(parseExtraPrefixes(`git log --format='%h %s', make -n; rm`), [['git', 'log', '--format=%h %s']])
  })
})

describe('matchesPrefixes', () => {
  const prefixes = parseExtraPrefixes('make -n, gh pr view, head')

  for (const command of ['make -n test', "make '-n' test", 'gh pr view 12 --json files', 'make -n test | head -20', 'make -n a && make -n b', 'make -n 2>/dev/null']) {
    it(`matches ${JSON.stringify(command)}`, () => assert.equal(matchesPrefixes(command, prefixes), true))
  }

  for (const command of [
    'make test',
    'make',
    'gh pr merge 12',
    'make -n test | tee out',
    'make -n test; rm -rf build',
    'make -n test > out',
    'make -n $(rm -rf build)',
    'FOO=1 make -n test',
    'make -n test &',
    '',
  ]) {
    it(`does not match ${JSON.stringify(command)}`, () => assert.equal(matchesPrefixes(command, prefixes), false))
  }

  it('matches nothing without prefixes', () => {
    assert.equal(matchesPrefixes('make -n', []), false)
  })
})
