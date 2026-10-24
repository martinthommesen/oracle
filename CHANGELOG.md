# Changelog

## 1.0.0

First release.

- The oracle subagent (`oracle:oracle`), running Amp's Oracle prompts adapted to Claude Code's tools.
- The model and effort are set in `/config` (default: `opus` at `xhigh`); a new oracle always runs on the configured model.
- A read-only guard for the oracle and every subagent it delegates to: a shell-command allowlist, no file-editing tools, delegation only to read-only subagent types.
- Validated read-only commands from the oracle skip permission prompts; deny and ask rules still apply.
- `read_thread`: the oracle can read the conversation that invoked it.
- `/oracle [task]` to consult it by hand; a status line while it thinks.
- A plain agent-file fallback for sessions where hooks modules are off.
