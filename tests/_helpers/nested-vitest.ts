// Shared by every test that spawns a REAL, nested `vitest run` subprocess
// under the active suite-wide hermetic spawn allowlist (task 052f9d5b;
// tests/_helpers/hermetic-spawn-allowlist.ts).
//
// Why `process.execPath` + this resolved entry, not `npx vitest`
// (task 052f9d5b review H1): `npx` resolves to a real, standalone binary
// (typically /usr/local/bin/npx or similar) that is neither a D3 tmpdir
// fixture nor a D6 INFRA entry — spawning it under the active guard is a
// genuine, correctly-blocked violation, not a false positive. CI runs
// `npm run test:integration` (package.json; .github/workflows/ci.yml)
// unconditionally, using the SAME vitest.config.ts (same setupFiles), so
// a nested spawn that uses `npx` breaks CI every time, not just when a
// contributor happens to run the suite locally with the hook active.
// `process.execPath` is the exact node binary already running vitest —
// D6-INFRA-allowlisted in tests/_helpers/hermetic-spawn-allowlist.ts — and
// pairing it with vitest's own resolved CLI entry point (not a shell
// command string) keeps the whole call on the argv-style path, with no
// shell involved at all.
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolves the absolute path to the vitest CLI's own bin entry (the file
 * `npx vitest` would ultimately exec), via `vitest/package.json`'s `bin`
 * field — not a hardcoded relative path, so it keeps working across a
 * vitest version bump without maintenance.
 */
export function resolveVitestEntry(): string {
  const requireCjs = createRequire(import.meta.url);
  const vitestPkgPath = requireCjs.resolve("vitest/package.json");
  const vitestPkg = JSON.parse(fs.readFileSync(vitestPkgPath, "utf8")) as { bin: Record<string, string> };
  return path.resolve(path.dirname(vitestPkgPath), vitestPkg.bin["vitest"]!);
}
