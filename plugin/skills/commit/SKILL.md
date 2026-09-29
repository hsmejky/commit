---
name: commit
description: Spawn commit:commit-worker to plan and commit the working tree, or reword the last commit; maps arguments to intent/reword only.
disable-model-invocation: true
---

Call the Agent tool with `subagent_type: commit:commit-worker` and `model: "sonnet"`; the prompt is the lines below, built from the arguments after `/commit`.

Arguments: $ARGUMENTS

Map the arguments to the prompt:

- empty: no `intent` line — every change is planned
- `reword`: `reword: true`
- `reword <text>`: `reword: <text>`, the text after `reword ` verbatim
- anything else: `intent: <text>`, the arguments joined onto one line if they span several (newlines become spaces)

Never add an `intent` of your own, whatever happened earlier in this session: a bare `/commit` plans everything in the tree, hand edits included. Edit no files until the worker's reply arrives. Follow the reply's `callerRule`.
