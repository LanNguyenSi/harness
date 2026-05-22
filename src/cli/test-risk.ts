// Phase 7 #3 — `harness test-risk` CLI entrypoint.
//
// Debug verb for the Risk Gate. Reads a tool-event JSON file, builds
// the Action Envelope (#2), classifies it against the manifest's
// `risk.classifiers[]` (#3), and prints the resulting risk profile.
// The inspection surface for the Risk Classifier, the counterpart of
// `harness explain-action` one stage further down the pipeline.
//
// File read, JSON guards, and envelope build are the shared
// `event-input` front end; manifest load + classification + rendering
// live here.

import { stringify as stringifyYaml } from "yaml";
import { classifyRisk, type RiskProfile } from "../runtime/index.js";
import type { Manifest } from "../schema/index.js";
import { loadEventEnvelope, type EventInputSeams } from "./event-input.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

export interface TestRiskOptions extends EventInputSeams, LoaderOptions {
  /** Path to the tool-event JSON file. */
  eventPath: string;
  /** Emit JSON instead of YAML. */
  json?: boolean;
  /** Inject the resolved manifest (tests); bypasses `loadManifest`. */
  manifest?: Manifest;
}

export interface TestRiskResult {
  output: string;
  profile: RiskProfile;
}

/**
 * Build the Action Envelope for a tool-event JSON file, classify it
 * against the manifest's risk classifiers, and render the profile.
 *
 * Throws `HarnessExitError(EX_NOINPUT)` when the event file is missing,
 * malformed, or not a JSON object (see `loadEventEnvelope`). A manifest
 * with no `risk.classifiers[]` is valid: every action then classifies
 * as unclassified ("unknown is not safe").
 */
export function testRisk(opts: TestRiskOptions): TestRiskResult {
  const { envelope } = loadEventEnvelope(opts.eventPath, opts, "test-risk");
  const manifest = opts.manifest ?? loadManifest(opts).manifest;
  const profile = classifyRisk(envelope, manifest.risk.classifiers);
  const output = opts.json
    ? `${JSON.stringify(profile, null, 2)}\n`
    : stringifyYaml(profile, { lineWidth: 0 });
  return { output, profile };
}
