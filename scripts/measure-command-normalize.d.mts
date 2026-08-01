// Exists because a relative-path ambient module declaration is only legal
// when colocated with the .mjs it types (see check-no-only.d.mts for the
// full rationale), so typecheck:tests can type
// tests/scripts/measure-command-normalize.test.ts's import without `any`.
// Keep in sync with the exports in measure-command-normalize.mjs.

export const DEFAULT_MANIFEST: string;
export const DEFAULT_DIST_DIR: string;

export const WRAPPERS: string[];
export const QVALS: string[];
export interface Verb {
  verb: string;
  policy: string;
  verbHead: string;
}
export const VERBS: Verb[];
export const REQUIRED_POLICIES: string[];
export const KNOWN_GOOD_WRAPPERS: string[];
export const KNOWN_UNSUPPORTED_WRAPPERS: string[];
export const VERB_HEADS: string[];

export interface ShapeA {
  arm: string;
  wrapper: string;
  verb: string;
  verbHead: string;
  policy: string;
  qval?: string;
  cmd: string;
}

export function buildCorpusA(options?: {
  wrappers?: string[];
  qvals?: string[];
  verbs?: Verb[];
}): { shapes: ShapeA[]; controls: ShapeA[] };

export type Gates = (cmd: string, policyName: string) => boolean;
export type BashRan = (cmd: string, verbHead: string) => boolean;

export interface ArmAControl {
  verb: string;
  cmd: string;
  bashRan: boolean;
  gated: boolean;
}

export interface ArmAStats {
  shapes: number;
  bashRan: number;
  gated: number;
  ranAndGated: number;
  notGated: string[];
  controls: ArmAControl[];
}

export interface ArmATotals {
  keptGate: number;
  regressed: number;
  totalArms: number;
  measuredArms: number;
  unmeasuredArms: Array<{ arm: string; reason: string }>;
  meaningfulZero: boolean;
}

export interface ArmAAudit {
  arms: Map<string, ArmAStats>;
  gateReason: (st: ArmAStats) => string | null;
  totals: ArmATotals;
}

export function auditArmA(options: {
  shapes: ShapeA[];
  controls: ShapeA[];
  gates: Gates;
  bashRan: BashRan;
}): ArmAAudit;

export function renderReportA(audit: ArmAAudit): string;

export interface ShapeB {
  family: string;
  wrapper: string;
  verb: string;
  policy: string;
  cmd: string;
}

export function buildCorpusB(options?: { wrappers?: string[]; verbs?: Verb[] }): ShapeB[];

export interface ArmBAudit {
  total: number;
  gated: number;
  ungated: number;
  ungatedCmds: string[];
  byFamily: Map<string, { total: number; ungated: number }>;
}

export function auditArmB(options: { shapes: ShapeB[]; gates: Gates }): ArmBAudit;

export function renderReportB(audit: ArmBAudit): string;

export interface CaseC {
  label: string;
  cmd: string;
  expected: string;
}

export function buildCorpusC(): CaseC[];

export interface ArmCResult extends CaseC {
  actual: string | null;
  pass: boolean;
}

export interface ArmCAudit {
  results: ArmCResult[];
  failed: ArmCResult[];
  allPass: boolean;
}

export function auditArmC(options: {
  cases: CaseC[];
  normalize: (cmd: string) => { targetDir: string | null };
}): ArmCAudit;

export function renderReportC(audit: ArmCAudit): string;

export function renderReport(results: { armA: ArmAAudit; armB: ArmBAudit; armC: ArmCAudit }): string;

export interface SelfTestEvaluation {
  failures: string[];
  warnings: string[];
}

export function evaluateSelfTest(audits: { healthy: ArmAAudit; sabotaged: ArmAAudit }): SelfTestEvaluation;

export function createVerbWorkspace(): {
  bashRan: BashRan;
  dispose: () => void;
};

export function loadRealGates(options?: { manifestPath?: string; distDir?: string }): Promise<Gates>;

export function loadCommandNormalize(
  distDir?: string,
): Promise<{ normalizeCommand: (cmd: string) => { normalized: string; targetDir: string | null; targetBase: string | null; truncated: boolean } }>;

export function runSelfTest(options?: {
  manifestPath?: string;
  distDir?: string;
}): Promise<{ ok: boolean; failures: string[]; warnings: string[] }>;

export interface ParsedArgs {
  selfTestOnly: boolean;
  manifest: string;
  distDir: string;
}

export function parseArgs(argv: string[]): ParsedArgs;

export function main(argv?: string[]): Promise<void>;
