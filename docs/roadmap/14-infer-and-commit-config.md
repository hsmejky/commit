# 14 Infer and commit-config

M19, history inference (pure `infer` and `configFor`), the read-only `infer` subcommand
(M18: M3 history read, M19, M4 `readLayers`, M19 `configFor`), and the user-only
`/commit-config` skill that writes one layer's validated text verbatim. `infer` is tested at
Seam 1 from C:infer; the skill by the CI size test and a manual hand-test. Main sources: M19,
M18 `infer`, Q6, Q7, Q14, C:infer, prompt-only blocks (`/commit-config`), stories 128-134.

## INF-01: `infer` with too few commits (tracer)

**What to build:** `commit.cjs infer` end to end: M3 reads the last 200 non-merge messages,
M19 counts them, and under 20 the output is `outcome: too-few-commits` with `commitCount`,
`ccShare`, `nonConventional`, `proposal: null`, `wouldFail: null`, `configJson: null`.
Read-only, no lock, no run folder.

**Blocked by:** MSG-01, RPL-02, INT-01, GIT-09.

**Status:** done

**Sources:** C:infer, M19, M18 `infer`, Q7, stories 128, 134.

- [x] Seam 1: a repo with 5 conventional commits → `ok: true`, `outcome:
      "too-few-commits"`, `commitCount: 5`, `ccShare` over the 5 read, `proposal: null`,
      `wouldFail: null`, exit 0.
- [x] Seam 1: an unborn repo → `too-few-commits`, `commitCount: 0`, `ccShare: null`.
- [x] Seam 1: no `.commit-plan/` exists after the call.
- [x] Seam 1: `infer` outside a repo or in a bare repo → exit 6 `state`, the same text
      family as `plan` (C:infer).


## INF-02: Conventional Commits share and `not-conventional`

**What to build:** a commit counts as Conventional Commits only when its header matches
M6's header grammar; `ccShare` over all commits read (merges excluded, at most 200); under
0.5 → `not-conventional`.

**Blocked by:** INF-01.

**Status:** done

**Sources:** Q7, C:infer, stories 128, 134.

- [x] Seam 1: `WIP: x` and `Update: x` do not count; merge commits are not read; 230
      commits → `commitCount: 200`.
- [x] Seam 1: 49% conventional → `not-conventional`, `proposal: null`; 50% → a proposal.
- [x] A static test asserts M19's module imports `parse` from M6 (no duplicate header
      grammar).

**Notes (from the INF-01 review):**
- The 20-commit boundary (`too-few-commits` vs. going on) is pinned on one side only by
  INF-01's tests: a 19-message case passes whether the guard is `>= MIN_COMMITS` or
  `> MIN_COMMITS`. Include a 20-commit case that is not `too-few-commits`, e.g. as part of
  the "50% → a proposal" criterion above, to pin the other side.
- INF-01's seam tests only cover a history where every commit is conventional
  (`ccShare: 1`), which does not show that `ccShare`'s denominator is the commit count read
  through the real git path. Close this with a seam case over a mixed history (e.g. `WIP: x`
  at 49%/50%), alongside the criterion above.

**Note (from the INF-02 review):** INF-02 ships `outcome: proposal` with `proposal: {}`,
`wouldFail: null`, `configJson: null`, no `droppedTypes`; INF-03..05 fill the object, INF-06
`wouldFail`, INF-07 `configJson`.


## INF-03: Scope and body proposal

**What to build:** scope `required` at 90% or more, `optional` at 10% or more, else
`forbidden`; body `optional` at 10% or more, else `forbidden`, where a footer-only last
paragraph is not a body; shares over the Conventional Commits ones only, in `evidence`.

**Blocked by:** INF-02, MSG-04.

**Status:** done

**Sources:** Q7, C:infer (`scope`, `body`, evidence), story 129.

- [x] Seam 1: boundary histories at 90% and 10% scope give `required` and `optional`;
      9% gives `forbidden`.
- [x] Seam 1: commits whose only extra paragraph is `Closes #n` do not count as bodies.
- [x] Seam 1: a history mixing conventional and non-conventional commits computes `scope`
      and `body` shares over the Conventional Commits ones only, excluding the rest from the
      denominator.
- [x] Seam 1: a history at exactly 10% with-body share gives `body: optional`; 9% gives
      `forbidden`.


## INF-04: Case and subject length proposal

**What to build:** `subjectCase: lower` when 90% or more pass M6's lowercase function;
`maxSubjectLength` from the p95 header length in code points: up to 72 → 72, up to 100 →
100, above 100 → next multiple of 10 and flagged, above 200 → 200 and flagged.

**Blocked by:** INF-02, MSG-03.

**Status:** done

**Sources:** Q7, C:infer (`maxSubjectLength.evidence.flagged`), story 129.

- [x] Seam 1: `API change` headers count as lower; 89% lower → `any`.
- [x] Seam 1: exactly 90% lowercase headers → `subjectCase: lower`.
- [x] Seam 1: p95 64 → 72, 90 → 100, 113 → 120 flagged, 230 → 200 flagged.
- [x] A static test asserts M19 imports the case-check function MSG-03 exports separately
      from `lint` (no duplicate implementation).


## INF-05: Types and dropped types

**What to build:** `types.value` = all 11 standard types plus each non-standard type at 5%
or more (with its share in `evidence`); non-standard types under 5% in `droppedTypes` with
counts.

**Blocked by:** INF-02.

**Status:** done

**Sources:** Q7, C:infer (`types`, `droppedTypes`), stories 129, 130.

- [x] Seam 1: a history without `revert` still proposes it; `deps` at 7% kept with
      `evidence.deps`; `wip` at 3 commits listed as `{ type: "wip", count: 3 }`.


## INF-06: `wouldFail` and `nonConventional`

**What to build:** M19 lints the Conventional Commits ones it read with M6 `lint` under the
proposed config and reports `wouldFail`; `nonConventional` counts the rest.

**Blocked by:** INF-03, INF-04, INF-05.

**Status:** done

**Sources:** Q7, C:infer, M19, story 130.

- [x] Seam 1: a history with known over-length and dropped-type commits gives the exact
      `wouldFail`; non-conventional commits are not in it.
- [x] A static test asserts M19's module imports `lint` from M6.


## INF-07: `configJson` per layer

**What to build:** M19 `configFor(proposal, layers)`: per layer (`repo`, `user`), the raw
current layer (M4 `readLayers`) with the proposal's keys replaced and every other key kept,
checked by M4 `validateLayer`, as `{ text }`; a layer that already fails validation gets
`{ errors }`.

**Blocked by:** INF-06, CFG-03, CFG-04, CFG-07.

**Status:** done

**Sources:** C:infer (`configJson`), Q6, Q7, M19, stories 132, 133.

- [x] Seam 1: a repo layer with `scanIgnore` and a `scope` → `repo.text` keeps `scanIgnore`,
      has the proposed `scope`, and passes `validateLayer`.
- [x] Seam 1: no user layer → `user.text` holds the proposal's keys only.
- [x] Seam 1: a user layer with `maxSubjectLength: 300` → `user.errors` names it; `infer`
      still exits 0 (no `config` refusal).
- [x] Seam 1: a repo layer with `scanIgnore: ["**"]` → `repo.errors` naming the pattern (a
      glob with no literal character), not `repo.text`.
- [x] A static test asserts M19 imports `validateLayer` from M4 (no duplicate
      implementation).


## INF-08: `/commit-config` skill

**What to build:** the user-only skill (`disable-model-invocation: true`): runs `infer`,
shows the proposal with its numbers (`wouldFail`, `nonConventional`, dropped types), asks
repo or user, and after confirmation writes that layer's `configJson` text verbatim; shows
`errors` and writes nothing for an invalid layer; recommends the defaults under 20 commits;
points to the opt-out below 50%. Its description size test reuses the shared ≤
200-character static-test helper WRK-01 builds, hence the WRK-01 blocker.

**Blocked by:** INF-07, FND-02, WRK-01.

**Status:** done

**Sources:** prompt-only blocks (`/commit-config`), Q7, Q14, Q24, stories 130-134.

- [x] A static test reads the skill frontmatter: `disable-model-invocation: true` (Q7)
- [x] CI size test: description ≤ 200 characters.
- [x] A static test: the skill text names the script by the plugin-root path.


## INF-09: `/commit-config` hand-test

**What to build:** a manual run of the skill in a real session covering each outcome.

**Blocked by:** INF-08, REL-01.

**Status:** needs-human

**Sources:** story-verification (manual hand-test of the skill), Q7, Q14.

- [ ] Proposal shown with numbers; nothing written before confirmation.
- [ ] The written file equals the chosen layer's `configJson` text byte for byte.
- [ ] An invalid chosen layer: errors shown, file unchanged.
- [ ] Under 20 commits: defaults recommended; under 50%: opt-out line pointed to.
