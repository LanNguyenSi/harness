// Phase 7 #4 — `harness resolve-env` CLI entrypoint.
//
// Debug verb for the Risk Gate. Reads a tool-event JSON file, builds
// the Action Envelope (#2), and resolves its target environment
// against the manifest's `environments.resolvers[]` (#4). The
// inspection surface for the Context Resolver, a sibling of
// `harness explain-action` and `harness test-risk`, one per pipeline
// stage.
//
// File read, JSON guards, and envelope build are the shared
// `event-input` front end, the hook's Bash-prefix enrichment is the
// shared `enriched-event` step; manifest load, environment resolution,
// and rendering live here.

import { stringify as stringifyYaml } from "yaml";
import { resolveEnvironment, type EnvironmentResolution } from "../runtime/index.js";
import type { Manifest } from "../schema/index.js";
import { enrichLoadedEvent } from "./enriched-event.js";
import { loadEventEnvelope, type EventInputSeams } from "./event-input.js";
import { loadManifest, type LoaderOptions } from "./loader.js";

export interface ResolveEnvOptions extends EventInputSeams, LoaderOptions {
  /** Path to the tool-event JSON file. */
  eventPath: string;
  /** Emit JSON instead of YAML. */
  json?: boolean;
  /** Inject the resolved manifest (tests); bypasses `loadManifest`. */
  manifest?: Manifest;
  /** Inject env vars for `env_var_patterns` (tests); defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Inject the kube context (tests); bypasses `~/.kube/config`. */
  kubeContext?: string;
  /** Inject the kube namespace (tests); bypasses `~/.kube/config`. */
  kubeNamespace?: string;
}

export interface ResolveEnvResult {
  output: string;
  resolution: EnvironmentResolution;
}

/**
 * Build the Action Envelope for a tool-event JSON file, resolve its
 * environment against the manifest's resolvers, and render the result.
 *
 * Throws `HarnessExitError(EX_NOINPUT)` when the event file is missing,
 * malformed, or not a JSON object (see `loadEventEnvelope`). A manifest
 * with no `environments.resolvers[]` is valid: every action then
 * resolves to `unknown` ("unknown is not safe").
 */
export function resolveEnv(opts: ResolveEnvOptions): ResolveEnvResult {
  const loaded = loadEventEnvelope(opts.eventPath, opts, "resolve-env");
  const manifest = opts.manifest ?? loadManifest(opts).manifest;

  // The same Bash-prefix enrichment the hook applies (inline `VAR=value`,
  // leading `cd`, leading `git switch|checkout`, task 8b891e83), so this
  // verb resolves the environment the gate would. The kube seams resolve
  // together inside the helper (either injected: no `~/.kube/config` read).
  const { envelope, enrichment, kube } = enrichLoadedEvent(loaded, manifest, opts);

  const resolution = resolveEnvironment(
    envelope,
    manifest.environments.resolvers,
    {
      env: enrichment.env,
      kubeContext: kube.context,
      kubeNamespace: kube.namespace,
    },
  );

  const output = opts.json
    ? `${JSON.stringify(resolution, null, 2)}\n`
    : stringifyYaml(resolution, { lineWidth: 0 });

  return { output, resolution };
}
