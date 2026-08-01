// Exists because a relative-path ambient module declaration is only legal
// when colocated with the .mjs it types (see check-no-only.d.mts for the
// full rationale), so typecheck:tests can type
// tests/scripts/measure-bash-prefix-parse.test.ts's import without `any`.
// Keep in sync with the exports in measure-bash-prefix-parse.mjs.

export const SEPARATOR_ARMS: string[];
export const HEADS: string[];
export const TAILS: string[];
export const SABOTAGE_MISSING_SPACE: "missing-space";

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

export interface AuditResult {
  arms: Map<string, ArmStats>;
  gateReason: (st: ArmStats, bs: BaselineArmStats) => string | null;
  perBaselineTotals: BaselineTotals[];
  candidateTotals: { phantoms: number; wrong: number };
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

export interface BashWorkspace {
  dir: string;
  targetDir: string;
  runReal: (cmd: string) => string | null;
  dispose: () => void;
}

export function createBashWorkspace(): BashWorkspace;

export function runSelfTest(options: { candidatePath: string }): Promise<{ ok: boolean; failures: string[] }>;

export function main(argv?: string[]): Promise<void>;
