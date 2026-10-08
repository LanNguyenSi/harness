// Import-boundary fitness function (task 19e293c6). Pins the layering the
// architecture review described: schema -> policies -> runtime ->
// policy-packs -> cli (each layer may import from layers to its LEFT, never
// to its right). The goal is catching the next reverse import, not a style
// crusade (docs/CONTRIBUTING.md).
//
// The four de-facto SHARED UTILITIES that used to live inside layer dirs
// (src/policies/duration.ts, src/policies/extract.ts,
// src/runtime/ledger-record.ts, src/runtime/expand-home.ts) were relocated
// into src/io/ (structural-concentration slice 4, agent-tasks 61a37b25,
// follow-up to task f86b2425).
//
// src/io still has no assigned layer position of its own (that is a bigger
// design decision, out of scope here -- see io-no-upward-imports below for
// what IS gated in the meantime). src/probes and src/overrides remain
// DELIBERATELY UNCONSTRAINED utility/leaf directories with no assigned
// position in the layer chain; only the floors above forbid importing
// probes/.
//
// io-no-upward-imports (task 9bc0d546) closes the gap the four relocated
// utilities opened: src/io is no longer a structurally invisible zone
// where any upward import silently escapes the layer rules. New files
// under src/io must not import from policies/runtime/policy-packs/cli.
// Exactly two pre-existing files still do, and are exempted by an
// explicit `from.pathNot` naming those two files (NOT a `to.pathNot`
// grandfather -- see the ratchet test in
// tests/dependency-cruiser-config.test.ts, which fails if any rule in
// this file ever gains a `to.pathNot`):
//   - src/io/claude-mcp.ts imports src/runtime/hermetic-spawn-guard.ts
//   - src/io/ledger-record.ts imports src/policies/ledger-client.ts,
//     src/policies/requires.ts, src/policies/timestamp.ts (values) and
//     src/runtime/intercept.ts (type-only); it is not a leaf.
// Assign io/probes/overrides a real layer position if/when the shared
// utilities get sorted for real (out of scope for this task).
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "schema-no-upward-imports",
      comment:
        "schema/ is the base vocabulary layer: it must not depend on policies/runtime/policy-packs/cli/probes",
      severity: "error",
      from: { path: "^src/schema" },
      to: { path: "^src/(policies|runtime|policy-packs|cli|probes)" },
    },
    {
      name: "policies-no-upward-imports",
      comment: "policies/ may use schema/ only",
      severity: "error",
      from: { path: "^src/policies" },
      to: { path: "^src/(runtime|policy-packs|cli|probes)" },
    },
    {
      name: "runtime-no-upward-imports",
      comment: "runtime/ may use schema/ and policies/ only",
      severity: "error",
      from: { path: "^src/runtime" },
      to: { path: "^src/(policy-packs|cli|probes)" },
    },
    {
      name: "policy-packs-no-cli-imports",
      comment: "policy-packs/ must not reach into the cli/ layer",
      severity: "error",
      from: { path: "^src/policy-packs" },
      to: { path: "^src/cli" },
    },
    {
      name: "solution-acceptance-hook-reads-marker-once",
      comment:
        "src/cli/pack/hook-solution-acceptance.ts observes the verdict marker " +
        "exactly once, through readVerdictDetailed, and classifies its deny " +
        "text from that one outcome: a second look can disagree with the " +
        "first (an attempt finishing in between), and a note rendered from " +
        "the later one describes a rejection the gate never made (task " +
        "8fe0f633). Importing the shared marker reader directly is the way " +
        "to take that second look without going through readVerdictDetailed, " +
        "so it is forbidden here. This rule cannot forbid a named import: a " +
        "second readVerdictDetailed call is guarded by the call-count test " +
        "in tests/cli/pack-hook-solution-acceptance.test.ts instead.",
      severity: "error",
      from: { path: "^src/cli/pack/hook-solution-acceptance\\.ts$" },
      to: { path: "^src/io/read-regular-file\\.ts$" },
    },
    {
      name: "branch-protection-stays-decoupled",
      comment:
        "The branch-protection gate (its hook, its pack modules and the git " +
        "branch reader) asks git for the branch and nothing else (task " +
        "a4d8adc5): it must not import the understanding gate, the ledger " +
        "client or writer (nor the src/policies barrel that re-exports it), " +
        "approval signing, pending approvals, git-context or the pause " +
        "machinery. Those components are being removed, and the kept gate " +
        "must not depend on any of them.",
      severity: "error",
      from: { path: "^src/(cli/pack/hook-branch-protection|policy-packs/builtin/branch-protection|runtime/git-branch)" },
      to: {
        path:
          "^src/(.*(understanding|ledger|approval-signing|pending-approval|git-context|pause)|policies/index\\.ts$)",
      },
    },
    {
      name: "io-no-upward-imports",
      comment:
        "io/ must not import from policies/runtime/policy-packs/cli. Two " +
        "pre-existing files are exempted by exact file path (from.pathNot, " +
        "not a to.pathNot grandfather -- see the header comment above and " +
        "tests/dependency-cruiser-config.test.ts): src/io/claude-mcp.ts and " +
        "src/io/ledger-record.ts.",
      severity: "error",
      from: {
        path: "^src/io",
        pathNot: "^src/io/(claude-mcp|ledger-record)\\.ts$",
      },
      to: { path: "^src/(policies|runtime|policy-packs|cli)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    exclude: { path: "\\.test\\.ts$" },
  },
};
