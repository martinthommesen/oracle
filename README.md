# Oracle for Claude Code

<img src="plugins/oracle/assets/icon.png" alt="" width="96" align="right">

A read-only expert advisor for Claude Code. The oracle is a subagent on a stronger reasoning model that Claude consults for the reviews you ask for and for the high-impact judgment calls it cannot settle alone: choosing between real alternatives, checking a suspected invariant violation, or cracking a cross-file bug. It reads the code and git history, reasons deeply, and answers with a recommendation you can act on: blockers first, evidence cited as `file:line`, assumptions surfaced, effort estimated.

It runs the prompts of Amp's Oracle, adapted to Claude Code, and you choose the model it runs on.

- **Configurable model and effort**, from `/config`. The default is Opus at `xhigh` effort.
- **Read-only, enforced**: the oracle and every subagent it delegates to may run only the shell commands Claude Code itself judges read-only, with no file-editing tools.
- **No surprise prompts**: read-only commands run without asking, as they do for Claude; anything else is refused rather than put to you, and your own rules always apply.
- **Knows the conversation**: a `read_thread` tool lets it read the conversation that called it, so it can recover your original request and constraints.
- **Follow-ups keep context**: Claude continues the same oracle with SendMessage instead of starting over.
- **`/oracle`** to consult it yourself; a status line shows it thinking.
- Works in the **Claude Code CLI and desktop app** on any platform, and in **cloud sessions** on the web, with nothing else to install.

## Install

In a Claude Code session in your terminal:

```
/plugin install oracle --marketplace martinthommesen/oracle
```

Answer `y` to add the marketplace, then pick the user scope so the oracle is there in every project.

Or add the marketplace first and install from it:

```
/plugin marketplace add martinthommesen/oracle
/plugin install oracle@oracle
```

From a shell: `claude plugin install oracle --marketplace martinthommesen/oracle`.

**Desktop app:** click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `martinthommesen/oracle`, then **Add plugin** for Oracle. A plugin installed from the terminal at the user scope loads in the desktop app's local sessions too.

**Cloud sessions** (Claude Code on the web, `claude --cloud`, and the apps' cloud sessions) don't load plugins installed on your machine: see [Cloud sessions](#cloud-sessions).

**Requirements:** Claude Code v2.1.271 or later (tested on v2.1.308 and v2.1.310). The configurable model, the read-only guard, `read_thread`, and the status line come from the plugin's hooks module (a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview)). Where hooks modules are switched off, the plugin falls back to a plain agent file: the same oracle prompts on Opus at `xhigh` effort, without those extras.

## Use it

- **Ask for it.** "Ask the oracle to review my changes." "Get the oracle's take on whether to use a queue or a cron job here." When you ask for the oracle, Claude uses it for exactly that, including general or final code review.
- **`/oracle [what to look at]`.** With nothing after it, the oracle reviews the current changes: the uncommitted diff, or the branch against its base when the tree is clean. You can also @-mention `oracle:oracle` in a prompt.
- **Let Claude decide.** Without being asked, Claude consults the oracle only after its own review, planning, or debugging leaves a specific question whose answer would change a high-impact decision. It doesn't use the oracle for reassurance, routine self-review, searches, or edits.
- **Follow up.** "Ask the oracle whether the fix addresses its first finding." Claude continues the same oracle, which keeps everything it read.

While the oracle works, the status line reads `🔮 oracle thinking · opus · xhigh · 1m 12s`, and a toast says when it answers. `/tasks` shows its transcript and the model it ran on. Its answer goes to Claude, which relays it to you faithfully, blockers and all; after `/oracle`, Claude waits for you before acting on it.

## Configure

Run `/config` and find the Oracle rows, or run `/plugin configure oracle@oracle`. A change reloads the plugin's module, so the next consultation uses it, with no restart. Unset options use their defaults; to set them at install time, pass `--config`, as in `claude plugin install oracle@oracle --config model=fable`.

| Setting | Default | Values |
| :-- | :-- | :-- |
| **Oracle model** | `opus` | `opus`, `best` (Fable where your plan has it, else Opus), `fable`, `sonnet`, `haiku`, `inherit` (the main conversation's model), or any full model ID `--model` accepts: `claude-opus-5-5[1m]`, a Bedrock or Vertex model ID, a gateway's model name |
| **Oracle effort** | `xhigh` | `xhigh`, `max`, `high`, `medium`, `low`, or `auto` (the model's own default). A model without the level you pick uses the nearest lower one |
| **Extra read-only commands** | none | Comma-separated command prefixes the oracle may also run although Claude Code doesn't judge them read-only, such as `gh pr view, gh pr diff, npm ls, make -n`. A command qualifies when every part of it (split at `\|`, `&&`, `;`) starts with one of them. Add only commands that cannot change anything |

The same values in your user settings (`~/.claude/settings.json`):

```json
{
  "pluginConfigs": {
    "oracle@oracle": {
      "options": { "model": "fable", "effort": "max" }
    }
  }
}
```

Environment variables override all three, in any session that has them. They are how you configure the oracle in a [cloud session](#cloud-sessions), which doesn't read your `/config` options:

| Variable | Overrides | Example |
| :-- | :-- | :-- |
| `ORACLE_MODEL` | Oracle model | `ORACLE_MODEL=fable` |
| `ORACLE_EFFORT` | Oracle effort | `ORACLE_EFFORT=max` |
| `ORACLE_EXTRA_COMMANDS` | Extra read-only commands | `ORACLE_EXTRA_COMMANDS=npm ls, make -n` |

An unusable value is ignored with a warning in the transcript, and the `/config` value stays in force.

The configured model always wins: if Claude names a model when it calls the oracle, the plugin drops it, so the oracle runs on yours. On some plans Fable bills to usage credits; see [Fable and usage credits](https://code.claude.com/docs/en/model-config#fable-and-usage-credits).

## Cloud sessions

A cloud session (Claude Code on the web at [claude.ai/code](https://claude.ai/code), `claude --cloud`, or a cloud session in the desktop or mobile app) runs in a fresh virtual machine. It doesn't load the plugins you installed on your own machine or the ones a repository's `.claude/settings.json` turns on, and it doesn't read your `/config` options. Give it the oracle in one of two ways, then configure it with environment variables.

### Add it to your claude.ai account (recommended)

Plugins on your claude.ai account sync into every Claude Code session you start signed in to that account, cloud sessions included.

1. Open [**Customize > Plugins**](https://claude.ai/customize/plugins) on claude.ai or in the desktop app.
2. Select **Add > Add marketplace** and enter `martinthommesen/oracle`.
3. Add **Oracle** from that marketplace. To get new versions without checking, turn on **Sync automatically** for the marketplace.

Your next cloud session loads it as `oracle@synced`. It also reaches your terminal sessions signed in to the same account, so you don't need to install it there separately.

### Or install it from the environment's setup script

To give the oracle to everyone who uses a cloud environment, such as a team's shared environment, install it from the environment instead of your account.

1. At [claude.ai/code](https://claude.ai/code), open the environment selector under the message box, hover over your environment, and select its settings icon. In a running session, select the caret after the session title, then **Edit cloud environment**.
2. Select **Setup script** and add:

   ```bash
   #!/bin/bash
   curl -fsSL https://raw.githubusercontent.com/martinthommesen/oracle/main/scripts/install.sh | bash
   ```

3. Select **Save changes**, then start a new session.

The script installs the plugin into `~/.claude/skills/oracle`, which Claude Code loads as `oracle@skills-dir`. It fetches the files from `raw.githubusercontent.com`, which the default **Trusted** network access allows; cloning the repository instead can fail, because a cloud session's GitHub proxy serves only the repositories attached to the session. To pin a version, put `ORACLE_REF=<commit or tag>` before `bash`. The environment caches what the setup script installs for about seven days, so a new version arrives when the cache is rebuilt, or right away when you edit the script. If your claude.ai account also has the plugin, the environment's copy is the one that loads.

### Configure it

In the same environment dialog, select **Environment variables** and set any of the [oracle's variables](#configure), one per line:

```text
ORACLE_MODEL=fable
ORACLE_EFFORT=max
ORACLE_EXTRA_COMMANDS=npm ls, make -n
```

New sessions use them. A session already running picks up a change the next time its VM starts, after it has been idle.

To check the setup, ask Claude in a cloud session to run `claude plugin list` and look for `oracle@synced` or `oracle@skills-dir`, then run `/oracle`. As on your own machine, the configurable model, the guard, and `read_thread` need hooks modules; without them the oracle runs on its defaults, and the variables have no effect.

Leave `gh pr` and `gh issue` out of `ORACLE_EXTRA_COMMANDS` in a cloud environment: they don't work there, because the session's GitHub proxy refuses the GraphQL API they use.

## How it works

The plugin is one Claude Code plugin with two layers:

```
plugins/oracle/
├── hooks/register.ts     the mod: registers oracle:oracle on your model, guards it, serves read_thread
├── hooks/prompts.ts      the oracle's system prompt and "when to consult" guidance (one source)
├── hooks/shell.ts        matches commands against your extra read-only commands
├── hooks/thread.ts       renders the calling conversation for read_thread
├── agents/oracle.md      the fallback oracle, generated from prompts.ts
└── skills/oracle/        the /oracle command
```

**The oracle.** `oracle:oracle` is a Claude Code subagent type, so Claude starts it with the Agent tool like any other subagent: in the background by default, visible in `/tasks`, resumable with SendMessage. Its description carries Amp's guidance on when to consult the oracle and how to write its task; its system prompt is Amp's Oracle prompt with the tools renamed to Claude Code's.

**Read-only, in three layers.**
1. **Tools.** The oracle has Read, Grep, Glob, LSP, Bash, WebSearch, WebFetch, Agent, and `read_thread`. No Edit, Write, or NotebookEdit.
2. **The guard.** Every tool call from the oracle, and from any subagent it started at any depth, is checked before it runs:
   - only reading tools pass;
   - a Bash command runs only when Claude Code's own permission check judges it read-only: the same judgment that lets Claude run `git log` or `rg` without asking you. So `git diff`, `git log -p`, `rg`, `find -name`, `sed -n`, and the like run; `rm`, `git commit`, `sed -i`, `find -delete`, `curl`, `env`, and redirection into a file are refused. Commands you list as extra read-only commands also run, when nothing else is smuggled in beside them (command substitution, subshells, here-documents, backgrounding, variable assignments, or redirection into anything but `/dev/null`);
   - the oracle may delegate only to Claude Code's read-only subagent types: Explore, Plan, and claude-code-guide;
   - SendMessage and TaskStop reach only the subagents the oracle started, so it cannot ask the main conversation or another agent to write for it;
   - when the guard itself fails before it could tell whose call it is, the call is refused.
3. **The prompt.** The oracle is told it is read-only, and why.

A refused call returns its reason to the oracle, which then reads the file another way or says what it could not check. The guard is defense in depth, not a sandbox: an allowed command still does what it normally does (`git diff` runs the external diff driver your git config names, for example). For hard isolation, use Claude Code's [sandbox](https://code.claude.com/docs/en/sandboxing).

**Permission prompts.** The guard never loosens your permissions: deny and ask rules, hooks, and settings such as `blockReadsOutsideWorkingDirectories` keep their word, so reading a file outside the project still asks you. It answers only two kinds of prompt itself, both for things you already allowed by installing or configuring the plugin: the oracle's `read_thread` calls, and your extra read-only commands.

**`read_thread`.** The oracle starts with only the task Claude wrote. When that isn't enough, `read_thread` shows it the conversation that called it, newest messages first within about 60,000 characters, always with your opening request, and with paging for earlier messages. Only the oracle can call it.

**What changed from Amp's oracle.**

| Amp | Claude Code |
| :-- | :-- |
| `shell_command` | Bash, limited to what Claude Code judges read-only, plus Read, Grep, and Glob |
| `Task` subagents | The Agent tool with read-only `Explore` subagents |
| `web_search`, `read_web_page` | WebSearch, WebFetch |
| `read_thread` with a parent thread ID | `read_thread`, which knows its caller |
| `find_thread` | Dropped: Claude Code has no thread search |
| `[text](file:///path#L10-L20)` links | `path/to/file.ts:10-20`, which Claude Code makes clickable |
| Zero-shot: no follow-ups | Still no clarifying questions, but follow-ups resume the same oracle |
| A fixed `oracle` tool on GPT at `xhigh` | A subagent type on the model you choose, Opus at `xhigh` by default |

## Develop

```sh
npm ci
npm test                 # unit tests: extra-command matching, read_thread, config, prompts
npm run build            # regenerate agents/oracle.md from hooks/prompts.ts
npm run typecheck        # needs Claude Code's API declarations, see below
npm run validate         # claude plugin validate, the marketplace and the plugin
npm run test:plugin      # hook-level tests against the engine
claude --plugin-dir plugins/oracle  # try it in a session, reloading as you edit
```

`npm run typecheck` checks the hooks module against the API declarations Claude Code writes to `plugins/oracle/.claude-plugin/types/` when it loads the plugin with `--plugin-dir` in an interactive session. Elsewhere, point `CLAUDE_CODE_TYPES` at a `claude-code.d.ts`.

Options for a plugin loaded with `--plugin-dir` live under `pluginConfigs["oracle"]` in your user settings, or pass them with `--settings`.

CI runs all of the above except the live session, with `claude plugin validate` and `claude plugin test` on the stable Claude Code release. The workflow is kept at `ci/github-actions.yml`; enable it with `git mv ci/github-actions.yml .github/workflows/ci.yml`.

## Credits

The oracle's prompts are adapted from Amp's Oracle as published in [this gist](https://gist.github.com/nicolaygerold/34118c466c725aca482cb07edc6c8063).

## License

[MIT](LICENSE)
