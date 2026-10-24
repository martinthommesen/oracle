import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { checkShellCommand, parseExtraPrefixes, splitCommand } from '../plugins/oracle/hooks/readonly.ts'

function allowed(command: string, extra: string[][] = []): void {
  const verdict = checkShellCommand(command, extra)
  assert.deepEqual(verdict, { ok: true }, `expected allowed: ${command}`)
}

function refused(command: string, pattern?: RegExp, extra: string[][] = []): void {
  const verdict = checkShellCommand(command, extra)
  assert.equal(verdict.ok, false, `expected refused: ${command}`)
  if (pattern !== undefined && !verdict.ok) assert.match(verdict.reason, pattern)
}

describe('splitCommand', () => {
  it('splits on control operators and removes quotes', () => {
    assert.deepEqual(splitCommand(`git diff --stat && git diff -- 'src/a b.ts' | head -50; ls "x y"`), [
      { words: ['git', 'diff', '--stat'] },
      { words: ['git', 'diff', '--', 'src/a b.ts'] },
      { words: ['head', '-50'] },
      { words: ['ls', 'x y'] },
    ])
  })

  it('drops allowed redirections and comments', () => {
    assert.deepEqual(splitCommand('git log 2>/dev/null >/dev/null 2>&1 # trailing comment'), [
      { words: ['git', 'log'] },
    ])
  })

  it('continues a command line after && on the next line', () => {
    assert.deepEqual(splitCommand('git status &&\n  git log -1'), [
      { words: ['git', 'status'] },
      { words: ['git', 'log', '-1'] },
    ])
  })

  it('keeps an escaped dollar and expansions as text', () => {
    assert.deepEqual(splitCommand('echo \\$HOME "$PWD" ${USER}'), [{ words: ['echo', '$HOME', '$PWD', '${USER}'] }])
  })
})

describe('checkShellCommand allows inspection', () => {
  for (const command of [
    'git diff',
    'git diff --cached --stat',
    'git diff main...HEAD -- src/',
    'git -C ../other --no-pager log --oneline -n 20',
    'git show --stat HEAD~1',
    'git log -p --follow -- src/a.ts',
    'git blame -L 10,40 src/a.ts',
    'git status --porcelain',
    'git grep -n "createAgent" -- "*.ts"',
    'git rev-parse --show-toplevel',
    'git branch -a',
    'git branch --contains abc123',
    'git branch --list "feat/*"',
    'git branch --show-current',
    'git tag',
    'git tag -l "v*"',
    'git remote -v',
    'git remote get-url origin',
    'git stash list',
    'git config --get user.name',
    'git config --list --show-origin',
    'git config get core.editor',
    'git worktree list',
    'git reflog -n 10',
    'git symbolic-ref --short HEAD',
    'git ls-files | wc -l',
    'git --version',
    'rg -n "TODO" src | head -20',
    'rg --files -g "*.ts"',
    'grep -rn "foo" . 2>/dev/null || true',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    'fd -e ts src',
    'ls -la && pwd',
    'cat package.json | jq ".dependencies"',
    'head -n 50 src/a.ts; tail -n 20 src/a.ts',
    'wc -l src/*.ts',
    'sed -n "10,40p" src/a.ts',
    "sed -n '/^export/,/^}/p' src/a.ts",
    "sed -n -e 5p -e '$p' file",
    "sed -ne '1,3p' file",
    "sed 's/foo/bar/g' file",
    "sed -E 's/(a)/\\1/' file",
    'sort file | uniq -c | sort -rn',
    'tree -L 2 src',
    'stat -c %s file',
    'file bin/tool',
    'diff -u a.txt b.txt',
    'cd packages/core && git log -1',
    'command -v node',
    'npm ls react',
    'npm view react version',
    'pnpm why typescript',
    'cargo tree -p serde',
    'go doc net/http.Client',
    'go env GOPATH',
    'pip show requests',
    'gh pr view 12 --json files',
    'gh pr diff 12',
    'gh api repos/o/r/pulls/12/comments',
    'gh api -X GET search/issues -q .total_count',
    'node --version',
    'cargo --help',
    'LC_ALL=C sort file',
    'GIT_PAGER=cat git log -1',
    'echo hi >&2',
    'cat < input.txt',
    'grep foo <<< "foo bar"',
    'git log --format="%h %s" -n 5',
  ]) {
    it(command, () => allowed(command))
  }
})

describe('checkShellCommand refuses writes and escapes', () => {
  const cases: [string, RegExp?][] = [
    ['rm -rf build', /"rm" is not a read-only/],
    ['touch x'],
    ['mkdir -p a'],
    ['mv a b'],
    ['cp a b'],
    ['echo hi > out.txt', /redirecting output into "out.txt"/],
    ['echo hi >> out.txt', /redirecting output/],
    ['git log &> log.txt', /redirecting output/],
    ['git log >| log.txt', /redirecting output/],
    ['git log 2> err.txt', /redirecting output/],
    ['cat <<EOF\nhello\nEOF', /here-documents/],
    ['echo $(rm -rf /)', /command substitution/],
    ['echo "$(whoami)"', /command substitution/],
    ['echo `whoami`', /command substitution/],
    ['diff <(ls a) <(ls b)', /process substitution/],
    ['(cd a && rm b)', /subshells/],
    ['git log &', /background/],
    ['git commit -m x', /"git commit" is not a read-only git command/],
    ['git push'],
    ['git checkout main'],
    ['git switch -c x'],
    ['git reset --hard'],
    ['git restore .'],
    ['git clean -fd'],
    ['git add .'],
    ['git stash', /changes the working tree/],
    ['git stash pop'],
    ['git branch feature', /creates a branch/],
    ['git branch -D old'],
    ['git tag v1.0', /creates a tag/],
    ['git tag -d v1'],
    ['git remote add up url'],
    ['git config user.name x', /sets configuration/],
    ['git config --unset user.name'],
    ['git -c core.pager=sh log', /changes configuration/],
    ['git -p log', /pager/],
    ['git diff --output=patch.diff', /writes files/],
    ['git log --output patch'],
    ['git format-patch -1'],
    ['git grep -O foo', /runs a program/],
    ['git worktree add ../x'],
    ['git fetch'],
    ['git co main', /not a read-only git command/],
    ['sed -i "s/a/b/" file', /edits files/],
    ['sed --in-place=.bak s/a/b/ file', /edits files/],
    ['sed -n "1w out" file', /sed command/],
    ['sed "s/a/b/w out" file', /flags/],
    ['sed "s/a/b/e" file', /flags/],
    ['sed -f script.sed file', /cannot read/],
    ['sed "1e rm -rf /" file'],
    ['find . -delete', /can write or run/],
    ['find . -exec rm {} ;'],
    ['find . -name x -fprint out'],
    ['fd -x rm', /can write or run/],
    ['rg --pre ./evil foo', /runs a program/],
    ['rg --pre=evil foo'],
    ['sort -o out file', /can write/],
    ['sort -rno out file'],
    ['uniq in out', /output file/],
    ['tail -f log', /can write or run/],
    ['tail -n5 -F log'],
    ['tree -o out.txt'],
    ['file -C -m magic'],
    ['date -s "2020-01-01"'],
    ['xargs rm', /"xargs" is not/],
    ['ls | xargs rm'],
    ['bash -c "ls"'],
    ['sh script.sh'],
    ['eval ls'],
    ['./script.sh', /by path/],
    ['/bin/rm -rf x', /by path/],
    ['npm install', /not a read-only npm query/],
    ['npm run build'],
    ['npx something'],
    ['pnpm add x'],
    ['yarn'],
    ['pip install x'],
    ['go build ./...'],
    ['go env -w GOFLAGS=x'],
    ['cargo build'],
    ['make'],
    ['python -c "print(1)"'],
    ['node -e "1"'],
    ['curl -o out https://x'],
    ['tee out'],
    ['gh pr merge 1', /not a read-only gh command/],
    ['gh pr checkout 1'],
    ['gh api -X POST repos/o/r/issues', /method POST/],
    ['gh api --method=DELETE repos/o/r'],
    ['gh api repos/o/r/issues -f title=x', /sends data/],
    ['command rm x'],
    ['GIT_EXTERNAL_DIFF=evil git diff', /setting "GIT_EXTERNAL_DIFF"/],
    ['PAGER=sh git log'],
    ['FOO=1 ls'],
    ['git log &&', /ends in an operator/],
    ['&& ls'],
    ["echo 'unterminated", /unterminated/],
    ["echo $'\\x41'", /ANSI-C/],
    ['constructor'],
    ['toString'],
    ['__proto__'],
    ['', /empty/],
    ['cat <> file', /reading and writing/],
    ['true;; ls'],
  ]
  for (const [command, pattern] of cases) {
    it(JSON.stringify(command), () => refused(command, pattern))
  }
})

describe('extra prefixes', () => {
  it('parses a comma-separated list', () => {
    assert.deepEqual(parseExtraPrefixes(' make -n, bazel query ,, '), [['make', '-n'], ['bazel', 'query']])
  })

  it('allows a configured prefix but still refuses its redirections', () => {
    const extra = parseExtraPrefixes('make -n')
    allowed('make -n build', extra)
    refused('make build', /not a read-only/, extra)
    refused('make -n build > out', /redirecting output/, extra)
  })
})
