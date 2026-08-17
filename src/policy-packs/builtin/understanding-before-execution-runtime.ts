// Re-export shim. The implementation moved to
// ./understanding-before-execution/ (structural concentration slice 2,
// agent-tasks 348a4d42), split into one sibling file per concern:
// ledger.ts, markers.ts, persisted-reports.ts, lifecycle.ts,
// task-markers.ts, post-tool-use-boundary.ts, active-claim.ts, composed
// by index.ts. Kept at this path so every existing import across the repo
// (hook-pre-tool-use.ts, hook-codex-pre-tool-use.ts,
// cli/approve/understanding.ts, tests, etc.) keeps working unchanged.
export * from "./understanding-before-execution/index.js";
