export const CONTRACT_PATH: string;
export const HASH_ALGORITHM: string;
export const SCHEMA: string;
export interface Provenance {
  repository: string;
  revision: string;
  contractPath: string;
  hashAlgorithm: string;
  sha256: string;
  fileCount: number;
}
export interface ContractTree {
  paths: string[];
  sha256: string;
  fileCount: number;
}
export function regularTree(root: string): string[];
export function parseManifest(root: string): { manifest: Record<string, unknown>; listed: Set<string> };
export function treeDigest(root: string, paths?: string[]): string;
export function validateCorpus(root: string): ContractTree;
export function readProvenance(path: string): Provenance;
export function checkContract(consumerRoot?: string): ContractTree & { provenance: Provenance };
export interface SyncContractTestOps {
  renameSync?: typeof import("node:fs").renameSync;
  rmSync?: typeof import("node:fs").rmSync;
}
export function syncContract(options: { source: string; revision: string; consumerRoot?: string; testOps?: SyncContractTestOps }): ContractTree & { revision: string };
