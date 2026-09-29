# Confirmation triggers

`check` sets `confirm` when any trigger for the run's mode holds:

| Trigger | `split` | `staged` | `reword` |
| --- | --- | --- | --- |
| more than one group | yes | — (one group) | — (one group) |
| a new file (status `A` or untracked) in any group | yes | no | — |
| an **included** skipped file or unit flagged for a `scanIgnore` change (when the repo config's `scanIgnore` value changed, every unit of that file, by path or old path, including one that edits only another key; when it did not change, none, [scan map](plan-hunks.md)) → `humanOnly: true` | yes | yes (the whole set is included) | — (no scan) |
| the run is `resumed` (a respawn after `edit`, `one` or `retry`), interactive only | yes | yes | yes |

A pattern hit is never a trigger: `check` keeps its unit out of every group, and `plan`
refuses a staged set with one (`staged-hit`); it shows up in `notices`. A binary new file
only changes the reason text (`new binary file logo.png`).

What each scan item does is fixed in [Q10](../decisions/q10-secret-and-local-path-scan.md).
