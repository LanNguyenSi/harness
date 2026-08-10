// task 325ace29 (npm-prefix-g-hermeticity-guard) taught `checkNpmBinPath`
// (src/cli/doctor/npm-bin-path.ts) an injectable `exec` seam so tests never
// spawn a real `npm prefix -g`. Every caller that reaches that seam --
// `doctor()`, `init()`, `runInteractive()` -- threads it through as
// `npmBinExec`. Eleven test files ended up hand-rolling the same two literal
// stub shapes (task-followup: unify the stub-shape duplication axis).
// Centralising them here keeps the two supported `checkNpmBinPath` outcomes
// (`unknown`, `warn`) each defined exactly once.
//
// checkNpmBinPath's three possible statuses, and which stub below produces
// which:
//   ok       bin dir resolves AND is on PATH        -- not stubbed here;
//            no test file needed this axis to hit "ok" via a shared stub.
//   warn     bin dir resolves AND is NOT on PATH     -- STUB_NPM_BIN_EXEC_WARN
//   unknown  npm errored / not on PATH / empty stdout -- STUB_NPM_BIN_EXEC_UNKNOWN
//
// Pick UNKNOWN when the test doesn't care about bin-resolution output at
// all (the common case: a fixture-setup `init()` call, or a `doctor()` call
// whose assertions are about something else entirely) -- `unknown` is the
// doctor-format's deliberately silent branch, so it adds zero noise to
// unrelated assertions.
//
// Pick WARN when the code path under test needs `checkNpmBinPath` to
// actually resolve a bin dir (e.g. init's post-write bin-resolution check,
// or `runInteractive`'s wizard flow) but the test itself does not assert on
// the specific resolved path. The stubbed prefix
// (`/nonexistent-npm-global-prefix-for-hermetic-tests`) is guaranteed not to
// exist on any test host, so nothing downstream that stats real files under
// `<prefix>/bin` (doctor's PATH-shadow hint, init's bin-resolution check)
// can accidentally observe real host state, and the resulting "warn" status
// is deterministic regardless of PATH.
//
// A test that asserts on the *specific* resolved bin dir, or on the "ok"
// status, or on a genuinely broken exec (e.g. ENOENT/127), builds its own
// bespoke `npmBinExec` inline -- that's the actual subject under test, not
// duplicated boilerplate, so it stays file-local (see e.g. doctor.test.ts's
// "npm global-bin PATH check" and "PATH-shadow hint" describe blocks, and
// init.test.ts's "attaches a PATH-shadow hint" test).

import type { NpmExec } from "../../src/cli/doctor/npm-bin-path.js";

/** `checkNpmBinPath` status: "unknown" (npm exec errored). */
export const STUB_NPM_BIN_EXEC_UNKNOWN: NpmExec = async () => ({
  code: 1,
  stdout: "",
  stderr: "stub",
});

/** `checkNpmBinPath` status: "warn" (resolves, deterministically off PATH). */
export const STUB_NPM_BIN_EXEC_WARN: NpmExec = async () => ({
  code: 0,
  stdout: "/nonexistent-npm-global-prefix-for-hermetic-tests\n",
  stderr: "",
});
