// Pins the supported Node floor to one value across the two places that
// state it: package.json's engines.node and the README install line. The
// floor went to 22 when Node 20 went EOL; CI and npm publishing already ran
// on 22 only, so neither half may drift back on its own.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ENGINES_NODE = (
  JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    engines: { node: string };
  }
).engines.node;

describe("supported Node floor", () => {
  it("package.json declares engines.node >=22", () => {
    expect(ENGINES_NODE).toBe(">=22");
  });

  it("README states the same floor as package.json", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const floor = ENGINES_NODE.replace(/>=/, "");
    expect(readme).toContain(`Node ${floor} or newer`);
    // Every "Node N or newer" floor sentence names the same N; other mentions
    // of an older Node (an EOL note, say) are fine.
    const floors = [...readme.matchAll(/Node (\d+) or newer/g)].map((m) => m[1]);
    expect(floors.length).toBeGreaterThan(0);
    expect(new Set(floors)).toEqual(new Set([floor]));
  });
});
