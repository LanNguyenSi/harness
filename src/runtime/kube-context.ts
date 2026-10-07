// Resolves the current Kubernetes context + namespace from the
// standard `~/.kube/config`, for the Phase 7 #4 Context Resolver's
// `kube_context_patterns` / `kube_namespace_patterns` signals.
//
// Like `git-context.ts`, this is a deliberate filesystem approximation:
// it reads `~/.kube/config` directly and does NOT consult `$KUBECONFIG`
// file lists or in-cluster service-account state. For classifying a
// target environment those exotic setups are out of the MVP's scope.
// Every failure path returns empty strings, never throws — callers
// treat "" as "unknown".

import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { readRegularFileBounded } from "../io/read-regular-file.js";

export interface KubeContext {
  /** Current context name, or "" when unresolved. */
  context: string;
  /** Namespace of the current context, or "" when unresolved. */
  namespace: string;
  /**
   * Present only when a kubeconfig IS at the path but could not be read
   * (over the size cap, not a regular file, unreadable). `context` and
   * `namespace` are then "" (unknown), exactly as for an absent file, but
   * the environment signal a production kube context would have given is
   * lost, so the hook that resolved it writes this text to stderr instead
   * of letting the loss pass silently. Absent for a missing file and for
   * every other outcome (a parsed config, an unparseable one).
   */
  unreadable?: string;
}

const EMPTY: KubeContext = { context: "", namespace: "" };

// A kubeconfig can legitimately carry many clusters with their certificate
// authority data inline, so the gate-marker 1 MiB cap would be too tight; a
// file past 8 MiB is not a kubeconfig. The read is bounded either way, so a
// sparse planted file cannot run the hook past its budget.
const MAX_KUBECONFIG_BYTES = 8 * 1024 * 1024;

export interface ResolveKubeContextOptions {
  /** Override the kubeconfig path (tests). Defaults to `~/.kube/config`. */
  kubeconfigPath?: string;
}

function describeUnreadableKubeconfig(configPath: string, kind: "symlink" | "not-regular" | "unreadable"): string {
  const why =
    kind === "not-regular"
      ? "is not a regular file"
      : `is unreadable or larger than the ${MAX_KUBECONFIG_BYTES / (1024 * 1024)} MiB read cap`;
  return (
    `kubeconfig ${JSON.stringify(configPath)} ${why}; the kube context and namespace are treated as unknown, ` +
    "so a production kube context cannot raise the target environment for this call"
  );
}

/**
 * Resolve `{ context, namespace }` from `~/.kube/config`. Returns empty
 * strings when the file is absent, unparseable, or declares no
 * `current-context`.
 */
export function resolveKubeContext(
  opts: ResolveKubeContextOptions = {},
): KubeContext {
  const configPath =
    opts.kubeconfigPath ?? path.join(os.homedir(), ".kube", "config");

  // Bounded, non-blocking read through the opened descriptor (a symlinked
  // kubeconfig is followed, as before). A FIFO, a device, a directory, an
  // oversized or unreadable file reads as "unknown" ("" / ""), exactly
  // like an absent file (the resolver never throws); the one thing it
  // must not do is wait. Unlike an absent file, a kubeconfig that IS there
  // but cannot be read is reported in `unreadable`: a real config past the
  // cap would otherwise lose its production context with no trace.
  const read = readRegularFileBounded(configPath, {
    followSymlinks: true,
    maxBytes: MAX_KUBECONFIG_BYTES,
  });
  if (read.kind === "missing") return EMPTY;
  if (read.kind !== "ok") {
    return { ...EMPTY, unreadable: describeUnreadableKubeconfig(configPath, read.kind) };
  }
  const raw = read.content;

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return EMPTY;
  }
  if (typeof doc !== "object" || doc === null) return EMPTY;

  const config = doc as { "current-context"?: unknown; contexts?: unknown };
  const context =
    typeof config["current-context"] === "string"
      ? config["current-context"]
      : "";
  if (context === "") return EMPTY;

  let namespace = "";
  if (Array.isArray(config.contexts)) {
    for (const entry of config.contexts) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as { name?: unknown; context?: unknown };
      if (e.name !== context) continue;
      if (typeof e.context === "object" && e.context !== null) {
        const ns = (e.context as { namespace?: unknown }).namespace;
        if (typeof ns === "string") namespace = ns;
      }
      break;
    }
  }

  return { context, namespace };
}
