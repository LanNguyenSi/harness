import { stringify as stringifyYaml } from "yaml";
import { EX_USAGE, HarnessExitError } from "./exit-codes.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

export interface ExplainOptions extends LoaderOptions {
  json?: boolean;
}

export interface ExplainResult {
  output: string;
}

export function explain(policyName: string, opts: ExplainOptions = {}): ExplainResult {
  const { manifest } = loadManifest(opts);
  const policy = manifest.policies.find((p) => p.name === policyName);
  if (!policy) {
    const available = manifest.policies.map((p) => p.name).join(", ") || "(none)";
    throw new HarnessExitError(
      `policy "${policyName}" not found; available: ${available}`,
      EX_USAGE,
    );
  }
  const projection = {
    name: policy.name,
    description: policy.description,
    trigger: policy.trigger,
    requires: policy.requires,
    hook: policy.hook,
    enforcement: policy.enforcement,
    note: "schema valid; last-evaluated tracking ships in Phase 4",
  };
  const output = opts.json
    ? `${JSON.stringify(projection, null, 2)}\n`
    : stringifyYaml(projection, { lineWidth: 0 });
  return { output };
}
