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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export interface KubeContext {
  /** Current context name, or "" when unresolved. */
  context: string;
  /** Namespace of the current context, or "" when unresolved. */
  namespace: string;
}

const EMPTY: KubeContext = { context: "", namespace: "" };

export interface ResolveKubeContextOptions {
  /** Override the kubeconfig path (tests). Defaults to `~/.kube/config`. */
  kubeconfigPath?: string;
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

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return EMPTY;
  }

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
