---
type: invariant
title: Managed mutations validate the whole manifest
description: harness add/remove schema-validate the ENTIRE proposed harness.yaml (no baseline diff), so a pre-existing schema error anywhere blocks an unrelated call; add's asset gate DOES baseline-diff, so pre-existing asset errors warn instead of block, while remove runs no asset checks at all.
tags: [add, remove, validation, manifest, footgun]
timestamp: 2026-08-27T06:55:18Z
sources:
  - src/cli/add/index.ts
  - src/cli/remove/index.ts
  - src/io/validate-before-write.ts
  - src/cli/validate/checks.ts
  - src/cli/add/mutate.ts
  - src/schema/index.ts
  - src/schema/tools.ts
---

## The invariant

`harness add <type> <name>` and `harness remove <type> <name>` never validate just the entry being changed. Both apply the mutation to the full YAML text (`applyAdd` / `applyRemove` on a `parseDocument` of the whole file) and then validate the **entire resulting manifest**. There are two distinct gates with **different scopes**, and conflating them is what makes the errors confusing:

1. **Schema gate** (add AND remove): `validateBeforeWrite(parseYaml(proposed))` — a thin wrapper around `parseManifest` (`src/io/validate-before-write.ts:12-28`) that zod-parses the whole document. **No baseline comparison.** A pre-existing schema error anywhere in `harness.yaml` (a typo'd key under `.strict()`, a duplicate `tools.mcp`/`tools.cli` name from `ToolsSchema.superRefine` at `src/schema/tools.ts:70-87`, a duplicate hook/policy name, a policy referencing an undeclared hook via `ManifestSchema.superRefine` at `src/schema/index.ts:43-53`, a workflow step naming a missing review template at `:54-67`, or a wrong `version:`) blocks an otherwise-valid add or remove of a completely unrelated entry. Error text: `proposed manifest fails schema validation:` followed by `path: message` lines that name the *broken* entry, not the one you touched.

2. **Asset gate** (add ONLY, `src/cli/add/index.ts:76-119`): `runAssetChecks(parseManifest(parseYaml(proposed)))` also runs against the **full manifest**, but its result is **diffed against a baseline**. Add re-runs the identical checks on the *original* manifest (`:91-104`) and keys each error-severity diagnostic as `severity|path|message` (`:98`). Only diagnostics **not present in the baseline set** block (`newErrors`, `:106-119`, error text `proposed manifest fails asset validation:`). Pre-existing asset errors are demoted to a warning on the result — `harness manifest has N pre-existing asset error(s) unrelated to this add; run `harness validate` to see them` (`:121-127`) — and the add proceeds. So for asset problems the true semantics is: **pre-existing does NOT block, newly-introduced does.**

`harness remove` runs **no asset checks at all** — only the schema gate (`src/cli/remove/index.ts:166-172`) plus a schema-only recheck after lock acquisition (`:199-205`). Add has the same schema-only post-lock recheck (`src/cli/add/index.ts:134-147`); asset checks are not repeated under the lock.

What the asset gate actually checks (`runAssetChecks`, `src/cli/validate/checks.ts:1226-1252`), all against the whole manifest:
- `checkMcp` (`:107-124`): for every `tools.mcp[]` entry whose command's **first token is a rooted path** (absolute or `~/`), `statSync` the path (after `expandHome` against `opts.homeDir`); missing path → error `tools.mcp[<name>].command: path does not exist: <resolved>`. Note the bracket key is the **tool name, not an index**.
- `checkCli` (`:126-177`): binary resolvable (absolute-and-executable, or found on `PATH`); `required: true` missing binary is an error; `min_version` below installed version is an error.
- `checkSkills` (`:179-202`): every `tools.skills.required[]` name must have a `SKILL.md` under some `source_dirs` entry.
- `checkHooks` (`:204-236`): rooted hook command paths must exist, be regular files, and be executable.
- Policy-pack source/config resolution errors (`checkPolicyPacks` / `checkPolicyPackConfigsAsDiagnostics`, `:1195-1224`), `checkSolutionAcceptanceProducer` (`:292-323`, grounding-mcp missing while the pack is enabled = error), and `checkWorkflowGateWiring` (`:352-395`, added 99f47307 Slice 1: a `spawn: "required"` review-then-merge workflow whose evidence hooks are missing, or declared under the right name but wired to the wrong trigger surface/command — see the function's own header comment). Everything else in the suite (builtin drift, knob-ignored, self-attestation, risk-scope, the workflow-gate weak-overlap and merge-before-review warnings) is warning-severity and filtered out by add's `severity === "error"` filter.

Why the baseline diff is stable across the mutation: `applyAdd` **appends** to the sequence (`addToSequence` → `node.add`, `src/cli/add/mutate.ts:64-81`), and diagnostic paths for mcp/cli/skills/hooks are **name-keyed** (`tools.mcp[foo].command`), so existing entries' diagnostic keys are byte-identical between baseline and proposed and dedupe correctly.

## Where it's enforced

- Schema gate, add: `src/cli/add/index.ts:67-74` (pre-lock) and `:141-147` (post-lock recheck).
- Asset gate + baseline diff, add: `src/cli/add/index.ts:76-127` (`proposedErrors` `:82-85`, `baselineKeys` `:91-104`, `newErrors`/`preExistingErrors` split `:106-111`, block `:113-119`, warning `:121-127`).
- Schema gate, remove: `src/cli/remove/index.ts:166-172` (pre-lock) and `:199-205` (post-lock recheck). `--force` on a hook referenced by policies only skips the human-readable pre-check (`:122-129`); the schema gate still rejects the resulting dangling `policy.hook` reference (`:161-165`). Since 99f47307 Slice 1 (F8, review round 2) a SECOND pre-check sits right after the policy one (`:131-150`): a hook a `workflows[]`-derived merge gate depends on (see `derivedGateReferencingWorkflows`, `:64-97`) is refused the same way, EXCEPT `--force` here has no schema-level safety net (a derived gate is not a static YAML reference the schema can see) — see that function's header comment.
- Whole-manifest parse both gates share: `validateBeforeWrite` → `parseManifest` (`src/io/validate-before-write.ts:12-28`, `src/schema/index.ts:113-126`).
- Fail-closed backstop: if the *original* manifest cannot even be `parseManifest`'d when computing the baseline, `baselineKeys` stays empty and **every** proposed asset error counts as new, i.e. on a broken base the asset gate blocks on everything (`src/cli/add/index.ts:99-104`). In practice `applyAdd`/the schema gate throw first, so this branch is rare.

## What breaks it

The symptom: **"`harness add mcp foo` fails with an error naming a different tool or an unrelated path."** Diagnose by reading the first line of the error:

- `proposed manifest fails schema validation:` → this is the no-baseline whole-manifest gate. The named entry is a **pre-existing** schema problem elsewhere in `harness.yaml` (or one your add just created, e.g. a duplicate name — `tools.mcp.N.name: duplicate mcp entry name: foo` means an entry named `foo` already exists, since `applyAdd` appends rather than replaces; `harness adopt`'s `mcp_replace` path is what replaces in place). Fix or remove the broken entry first; your add is otherwise fine. Same story for `harness remove`.
- `proposed manifest fails asset validation:` → this diagnostic is **new relative to the original file**, so it *is* caused by your call even when the path looks unrelated to what you typed. The live example: `tools.mcp[x].command: path does not exist: /bin/true` from `harness add mcp x` — the bracket key is the tool **name** (`checkMcp`, `src/cli/validate/checks.ts:118`), so `x` is the entry being added; `checkMcp` stat'd the first token of its command on the machine running `harness add` and it wasn't there. A genuinely different-entry asset error can only block as "new" in three ways: the baseline manifest failed to parse (fail-closed backstop above), your add changed an interaction check's outcome (e.g. `checkSolutionAcceptanceProducer` is keyed at `policy_packs`, not at any mcp entry, and flips on whether `grounding-mcp` is wired), or the diagnostic's `severity|path|message` key shifted between runs (name-keyed paths make this a non-issue for appends).
- Pre-existing asset errors do **not** block add — they arrive as a warning telling you to run `harness validate`. If you see the asset-validation *failure*, stop looking for someone else's breakage and check the entry you just added, the `homeDir` in effect, and whether the command's first token is an absolute path that exists here.
- `harness remove` can never fail on asset existence (no asset gate); if remove blocks, it is schema-shaped — most commonly the dangling `policy.hook` reference after removing a hook that policies still name, which `--force` deliberately does not bypass.
