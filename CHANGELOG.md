# Changelog

## 1.0.0

First release.

- The oracle subagent (`oracle:oracle`), running Amp's Oracle prompts adapted to Claude Code's tools.
- The model and effort are set in `/config` (default: `opus` at `xhigh`); a new oracle always runs on the configured model, whatever model its caller names.
- A read-only guard for the oracle and every subagent it delegates to: only reading tools, only shell commands Claude Code judges read-only (plus extra commands you allow in `/config`), and delegation only to read-only subagent types. It never loosens your permission rules.
- `read_thread`: the oracle can read the conversation that invoked it.
- `/oracle [task]` to consult it by hand; a status line while it thinks.
- A plain agent-file fallback for sessions where hooks modules are off.
