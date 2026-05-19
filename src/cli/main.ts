#!/usr/bin/env node
// Opt the binary into reading the operator's real harness home dir
// (`~/.harness/harness.yaml` preferred, `~/.claude/harness.yaml` as
// legacy fallback) when no --config / --home is supplied. The loader
// (`resolvePaths`)
// refuses that fallback unless this flag is set, so tests that forget to
// inject `homeDir` / `generatedDir` fail loudly instead of silently
// reading/writing the operator's runtime dir. Recurring class, two prior
// incidents (v0.21.1 preflight stage + v0.22.0 approveUnderstanding leak)
// are documented in CHANGELOG; this guard catches the next one at write
// time rather than after the fact.
//
// Caveat for future contributors: `resolvePaths` is only safe to call
// from code that runs AFTER this env-var assignment. The call sites today
// are all lazy (inside function bodies), so the import-time ordering does
// not matter; if you add a TOP-LEVEL `resolvePaths()` in any module on
// `index.js`'s import graph, you must either inject explicit
// homeDir/configPath there or hoist this assignment above the import.
process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = "1";

import { run } from "./index.js";

run().then((code) => {
  process.exit(code);
});
