// Import-boundary fitness function (task 19e293c6). Pins the layering the
// architecture review described: schema -> policies -> runtime ->
// policy-packs -> cli (each layer may import from layers to its LEFT, never
// to its right). The goal is catching the next reverse import, not a style
// crusade (docs/CONTRIBUTING.md).
//
// KNOWN DEBT (grandfathered below, discovered when this gate first ran —
// the review's "zero reverse imports" claim was grep-schematic, not
// file-accurate): four de-facto SHARED UTILITIES live inside layer dirs
// and are imported from below their directory's position:
//   - src/policies/duration.ts   <- src/schema/requires.ts
//   - src/policies/extract.ts    <- src/schema/extract.ts
//   - src/runtime/ledger-record.ts <- src/policies/{requires,ledger-client}.ts
//   - src/runtime/expand-home.ts   <- src/policies/ledger-client.ts
// The honest fix is moving them into a shared util layer; that relocation
// belongs to the structural-concentration follow-up (task f86b2425), not
// this gate. The exemptions are per-target-file, so ANY OTHER upward
// import still fails.
//
// DELIBERATELY UNCONSTRAINED: src/io, src/probes, and src/overrides are
// utility/leaf directories with no assigned position in the layer chain;
// only the floors above forbid importing probes/. Assign them a layer
// (and rules) if/when f86b2425 sorts the shared utilities.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "schema-no-upward-imports",
      comment:
        "schema/ is the base vocabulary layer: it must not depend on policies/runtime/policy-packs/cli/probes",
      severity: "error",
      from: { path: "^src/schema" },
      to: {
        path: "^src/(policies|runtime|policy-packs|cli|probes)",
        pathNot: ["^src/policies/duration\\.ts$", "^src/policies/extract\\.ts$"],
      },
    },
    {
      name: "policies-no-upward-imports",
      comment: "policies/ may use schema/ (and the grandfathered utils) only",
      severity: "error",
      from: { path: "^src/policies" },
      to: {
        path: "^src/(runtime|policy-packs|cli|probes)",
        pathNot: [
          "^src/runtime/ledger-record\\.ts$",
          "^src/runtime/expand-home\\.ts$",
        ],
      },
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
