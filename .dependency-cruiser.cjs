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
// follow-up to task f86b2425) — no more grandfathered exemptions needed.
//
// DELIBERATELY UNCONSTRAINED: src/io, src/probes, and src/overrides are
// utility/leaf directories with no assigned position in the layer chain;
// only the floors above forbid importing probes/.
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
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    exclude: { path: "\\.test\\.ts$" },
  },
};
