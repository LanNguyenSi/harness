// Suite-wide ambient-env hygiene for `UNDERSTANDING_GATE_MODE` (task
// 5d73d78d review MEDIUM-5). `resolveMode()`
// (src/policy-packs/builtin/understanding-before-execution.ts) reads this
// env var LIVE for its Env-priority resolution (the live-runtime-consumer
// contract — approve/understanding.ts's stdin gap-fill, and the Codex
// UserPromptSubmit injector). Any test file exercising that path — or,
// transitively, `harness apply`/`approveUnderstanding` in a test that
// does not itself know to guard this var — would otherwise silently pick
// up whatever the operator (or the CI shell) happens to have exported,
// making the suite's pass/fail depend on ambient state instead of what
// each test actually declares.
//
// Individual files that specifically exercise the Env-priority contract
// (tests/policy-packs/resolve-mode.test.ts, tests/policy-packs/
// expand.test.ts's env-override case) already save/restore the var
// around their own cases; this setup file additionally deletes it before
// EVERY test in EVERY file, so a file that does not know to guard it
// (every other file in the suite) still gets a deterministic, env-clean
// baseline. A file's own beforeEach (registered after this setup file's,
// since setupFiles load first) still runs afterwards and can set/save
// whatever it needs for its own cases — this hook only guarantees the
// baseline going INTO each test, it does not prevent a test from setting
// the var for its own duration.
import { beforeEach } from "vitest";

const MODE_ENV = "UNDERSTANDING_GATE_MODE";

// Also scrub once at module top level: a module-top-level or
// describe-body read of the var (unlikely for this one, but cheap to
// cover) would otherwise see the operator's ambient value during
// collection, before any beforeEach ever runs.
delete process.env[MODE_ENV];

beforeEach(() => {
  delete process.env[MODE_ENV];
});
