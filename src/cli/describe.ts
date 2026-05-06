import { stringify as stringifyYaml } from "yaml";
import type { Manifest } from "../schema/index.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

export type Pillar =
  | "grounding"
  | "tools"
  | "memory"
  | "hooks"
  | "policies"
  | "workflows"
  | "review_templates";

const PILLARS: readonly Pillar[] = [
  "grounding",
  "tools",
  "memory",
  "hooks",
  "policies",
  "workflows",
  "review_templates",
];

export function isPillar(value: string): value is Pillar {
  return (PILLARS as readonly string[]).includes(value);
}

export interface DescribeOptions extends LoaderOptions {
  pillar?: Pillar;
  json?: boolean;
}

export interface DescribeResult {
  output: string;
  manifest: Manifest;
}

function projectPillar(manifest: Manifest, pillar: Pillar): Record<string, unknown> {
  return { version: manifest.version, [pillar]: manifest[pillar] };
}

export function describe(opts: DescribeOptions = {}): DescribeResult {
  const { manifest } = loadManifest(opts);
  const projection: Record<string, unknown> = opts.pillar
    ? projectPillar(manifest, opts.pillar)
    : (manifest as unknown as Record<string, unknown>);

  const output = opts.json
    ? JSON.stringify(projection, null, 2)
    : stringifyYaml(projection, { lineWidth: 0 });

  return { output, manifest };
}
