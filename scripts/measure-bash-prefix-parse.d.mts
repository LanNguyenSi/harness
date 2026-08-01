// Exists because a relative-path ambient module declaration is only legal
// when colocated with the .mjs it types (see check-no-only.d.mts for the
// full rationale), so typecheck:tests can type
// tests/scripts/measure-bash-prefix-parse.test.ts's import without `any`.
// Keep in sync with the exports in measure-bash-prefix-parse.mjs.

export const SEPARATOR_ARMS: string[];
export const HEADS: string[];
export const TAILS: string[];
export const SABOTAGE_MISSING_SPACE: "missing-space";
export const SELF_TEST_IDENTITY_BASELINE: "candidate-as-baseline";
export const SELF_TEST_BLIND_BASELINE: "blind-control";

export interface CorpusShape {
  arm: string;
  cmd: string;
}

export function buildCorpus(options: { targetDir: string; sabotage?: string | null }): CorpusShape[];

export interface BaselineArmStats {
  hits: number;
  wrong: number;
  lost: string[];
  degradedToWrong: string[];
  phantomFixed: number;
}

export interface ArmStats {
  shapes: number;
  ran: number;
  entered: number;
  candidateHits: number;
  candidateWrong: string[];
  phantoms: string[];
  perBaseline: Map<string, BaselineArmStats>;
}

export interface BaselineTotals {
  name: string;
  lost: number;
  degradedToWrong: number;
  measuredArms: number;
  unmeasuredArms: Array<{ arm: string; reason: string }>;
  meaningfulZero: boolean;
}

export interface CandidateTotals {
  phantoms: number;
  wrong: number;
  armsWithoutObservation: string[];
  meaningfulZero: boolean;
}

export interface AuditResult {
  arms: Map<string, ArmStats>;
  gateReason: (st: ArmStats, bs: BaselineArmStats) => string | null;
  perBaselineTotals: BaselineTotals[];
  candidateTotals: CandidateTotals;
}

export interface Baseline {
  name: string;
  parse: (cmd: string) => string | null;
}

export function auditCorpus(options: {
  shapes: CorpusShape[];
  targetDir: string;
  runReal: (cmd: string) => string | null;
  candidateParse: (cmd: string) => string | null;
  baselines: Baseline[];
}): AuditResult;

export function renderReport(audit: AuditResult): string;

export function resolveBash(pathEnv?: string): string | null;

export interface BashWorkspace {
  dir: string;
  targetDir: string;
  runReal: (cmd: string) => string | null;
  dispose: () => void;
}

export function createBashWorkspace(): BashWorkspace;

export interface SelfTestEvaluation {
  failures: string[];
  warnings: string[];
}

export function evaluateSelfTest(audits: { healthy: AuditResult; sabotaged: AuditResult }): SelfTestEvaluation;

export function runSelfTest(options: {
  candidatePath: string;
}): Promise<{ ok: boolean; failures: string[]; warnings: string[] }>;

export interface ParsedArgs {
  candidate: string;
  baselines: Array<{ name: string; path: string }>;
  selfTestOnly: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs;

export function main(argv?: string[]): Promise<void>;
