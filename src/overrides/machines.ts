import * as fs from "node:fs";
import * as os from "node:os";

export type MachineOs = "linux" | "darwin" | "wsl2" | "win32" | "default";

export interface MachineDiscriminators {
  hostname: string;
  os: MachineOs;
}

export interface DiscriminatorOptions {
  hostname?: string;
  platform?: NodeJS.Platform;
  procVersionPath?: string;
}

function detectWsl2(procVersionPath: string): boolean {
  try {
    const contents = fs.readFileSync(procVersionPath, "utf8");
    return /microsoft/i.test(contents);
  } catch {
    return false;
  }
}

export function resolveMachineDiscriminators(
  opts: DiscriminatorOptions = {},
): MachineDiscriminators {
  const platform = opts.platform ?? process.platform;
  const procVersionPath = opts.procVersionPath ?? "/proc/version";
  const hostname = (opts.hostname ?? os.hostname() ?? "").toLowerCase();

  let osLabel: MachineOs;
  if (platform === "linux" && detectWsl2(procVersionPath)) {
    osLabel = "wsl2";
  } else if (platform === "linux") {
    osLabel = "linux";
  } else if (platform === "darwin") {
    osLabel = "darwin";
  } else if (platform === "win32") {
    osLabel = "win32";
  } else {
    osLabel = "default";
  }

  return { hostname, os: osLabel };
}

export function machineOverrideCandidates(
  discriminators: MachineDiscriminators,
): string[] {
  const candidates: string[] = ["default", discriminators.os];
  if (discriminators.hostname) candidates.push(discriminators.hostname);
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}
