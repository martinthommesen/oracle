---
name: oracle
description: Consult the oracle, a read-only expert advisor on a stronger reasoning model, about a review, a design decision, or a hard bug. Run it as /oracle followed by what you want it to look at; with nothing after it, the oracle reviews the current changes.
argument-hint: "[what the oracle should review, decide, or debug]"
disable-model-invocation: true
---

The user asked to consult the oracle: `oracle:oracle`, a read-only expert advisor subagent.

What they want it to look at: $ARGUMENTS

If that is empty, the request is a review of the current changes: the uncommitted diff, or this branch against its base when the working tree is clean, judged against the intent this conversation established.

1. Write the oracle a focused prompt. It has not seen this conversation, so put the essentials in the prompt itself:
   - the requested scope (the diff, files, or decision) and the intended behavior
   - the specific question or decision, and why it matters
   - what was already checked or tried, and the constraints or product choices already settled
   - the most relevant files, by workspace-relative path
   - what to ignore, when scope creep would make the answer less useful
   Preserve the scope the user asked for; do not narrow a requested review to a question of your own.
2. Call the Agent tool with `subagent_type: "oracle:oracle"`, a short `description`, and that prompt, and wait for the oracle's answer. Do not set `model` or `effort` unless the user named them.
3. Present the oracle's answer to the user faithfully: its conclusion first, then any blockers, the assumptions it surfaced, and its effort estimates. Do not soften or drop its findings. Say plainly where you disagree with it and why. Do not start acting on its recommendations unless the user asked you to.
