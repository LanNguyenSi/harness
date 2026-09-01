// Built-in destructive-shell floor (task 2929c5b7, review round 3).
//
// Three jobs:
//  1. Pin the floor's own recognition, through `classifyRisk` with NO
//     manifest patterns, so nothing here can be satisfied by a
//     `dangerous-shell` pattern instead of by the floor.
//  2. Pin the UPGRADE PATH end to end: a manifest carrying only the
//     ORIGINAL four `dangerous-shell` patterns (what every install
//     created before this task has on disk) must still hard-block the
//     destructive heads in a production cwd, now that an unclassified
//     action no longer satisfies `severity_at_least: critical`.
//  3. Pin PARITY between the shipped template patterns and the floor:
//     every pattern the template added for this task must have a
//     canonical spelling that the floor also catches, at the same
//     severity or higher, so the operator-editable mirror can be
//     narrower but never divergent.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  buildActionEnvelope,
  classifyRisk,
  intercept,
  type EnvelopeContext,
  type LedgerClient,
  type RiskGateContext,
  type ToolEvent,
} from "../../src/runtime/index.js";
import { classifyDestructiveShellFloor } from "../../src/runtime/destructive-shell-floor.js";
import type { ExtractBuiltins } from "../../src/policies/index.js";
import { parseManifest, RiskSeveritySchema } from "../../src/schema/index.js";
import type {
  EnvironmentResolver,
  Policy,
  RiskClassifier,
  RiskSeverity,
} from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const REFERENCE_YAML = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

const NOW = new Date("2026-09-01T12:00:00.000Z");
const CTX: EnvelopeContext = {
  cwd: "/work/repo",
  git: { repo: "repo", branch: "main", sha: "" },
  user: "agent",
  host: "host",
  now: NOW,
};

function bashEvent(command: string): ToolEvent {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    session_id: "sess-1",
    cwd: "/tmp/proj",
  };
}

/** The profile the built-in floors alone produce: NO manifest patterns. */
function floorOnly(command: string) {
  return classifyRisk(buildActionEnvelope(bashEvent(command), CTX), []);
}

function severityIndex(s: RiskSeverity): number {
  return RiskSeveritySchema.options.indexOf(s);
}

describe("built-in destructive floor: recognition (no manifest patterns)", () => {
  it.each([
    ["dd with an of= target", "dd if=/dev/zero of=/dev/sda"],
    ["truncate with a separated size", "truncate -s 0 /var/log/app.log"],
    ["truncate with a glued size", "truncate -s0 /var/log/app.log"],
    ["truncate --size=", "truncate --size=0 /var/log/app.log"],
    ["shred", "shred -u secret.txt"],
    ["mkfs.<fs>", "mkfs.ext4 /dev/sdb1"],
    ["bare mkfs", "mkfs /dev/sdb1"],
    ["find -delete", "find /var/www -name '*.php' -delete"],
    ["find -exec rm", "find /var/www -exec rm {} +"],
    ["find -execdir rm", "find /var/www -execdir rm {} +"],
  ])("classifies %s as critical", (_label, command) => {
    expect(floorOnly(command).severity).toBe("critical");
  });

  it.each([
    ["git reset --hard", "git reset --hard HEAD~3"],
    ["git push --force", "git push --force origin main"],
    ["git push -f", "git push -f origin main"],
    ["git push --force-with-lease", "git push --force-with-lease origin main"],
    ["git push +refspec", "git push origin +main:main"],
    ["git clean -fd", "git clean -fd"],
    ["git clean -df (cluster order)", "git clean -df"],
    ["git checkout -- .", "git checkout -- ."],
    ["git checkout .", "git checkout ."],
    ["git restore .", "git restore ."],
    ["chmod -R", "chmod -R 777 /var/www"],
    ["chmod -Rf (cluster)", "chmod -Rf 777 /var/www"],
    ["chown -fR (cluster, other order)", "chown -fR www-data /var/www"],
    ["sed -i", "sed -i 's/a/b/' /etc/config"],
    ["sed -ni (cluster)", "sed -ni 's/a/b/' /etc/config"],
    ["curl -o writes a local file", "curl -o /etc/passwd https://h/x"],
    ["curl -K reads flags from a file", "curl -K flags.conf https://h/x"],
    ["curl -d sends a body", "curl -d @payload.json https://h/x"],
    ["curl -X POST", "curl -X POST https://h/deploy"],
    ["curl -X post (lowercase)", "curl -X post https://h/deploy"],
    ["curl --json", "curl --json '{}' https://h/deploy"],
  ])("classifies %s as high", (_label, command) => {
    expect(floorOnly(command).severity).toBe("high");
  });

  // Head resolution: the spellings a raw-string regex pattern cannot
  // follow. Each must reach the SAME critical/high verdict as its bare
  // spelling above.
  it.each([
    ["path-qualified", "/bin/dd if=/dev/zero of=/dev/sda", "critical"],
    ["env wrapper", "env dd if=/dev/zero of=/dev/sda", "critical"],
    ["env with an assignment", "env FOO=bar dd if=/dev/zero of=/dev/sda", "critical"],
    ["command wrapper", "command dd if=/dev/zero of=/dev/sda", "critical"],
    ["sudo wrapper", "sudo dd if=/dev/zero of=/dev/sda", "critical"],
    ["leading assignment", "LC_ALL=C dd if=/dev/zero of=/dev/sda", "critical"],
    ["timeout wrapper", "timeout 5 dd if=/dev/zero of=/dev/sda", "critical"],
    ["busybox multi-call", "busybox dd if=/dev/zero of=/dev/sda", "critical"],
    ["sh -c nesting", 'sh -c "dd if=/dev/zero of=/dev/sda"', "critical"],
    ["sh -c nesting with an inner chain", 'sh -c "echo hi; dd if=/dev/zero of=/dev/sda"', "critical"],
    ["bash -lc nesting", "bash -lc 'git push -f origin main'", "high"],
    ["git -C reset", "git -C /repo reset --hard", "high"],
    ["git -C push", "git -C /repo push -f", "high"],
    ["git --git-dir push", "git --git-dir=/repo/.git push --force", "high"],
    ["after a chaining boundary", "echo hi && dd if=/dev/zero of=/dev/sda", "critical"],
    ["after a pipe boundary", "cat x | dd of=/dev/sda", "critical"],
  ] as Array<[string, string, RiskSeverity]>)(
    "resolves the head through %s",
    (_label, command, severity) => {
      expect(floorOnly(command).severity).toBe(severity);
    },
  );

  // NEGATIVE CONTROL: read-only siblings of the same heads, and heads
  // that merely MENTION a floored binary, must not be floored up. Without
  // this the floor could pass every case above by returning a hit for
  // everything.
  it.each([
    ["a plain read", "ls -la"],
    ["a grep that mentions dd", "grep dd file"],
    ["an echo that quotes a dd command", "echo 'dd if=a of=b'"],
    ["dd reading into a pipe (no of=)", "dd if=/dev/sda"],
    ["a non-forced push", "git push origin main"],
    ["a non-recursive chmod", "chmod 644 f"],
    ["a read-only sed", "sed -n '1p' f"],
    ["a read-only curl", "curl -sL https://h/x"],
    ["git status", "git status"],
  ])("does NOT floor %s", (_label, command) => {
    expect(classifyDestructiveShellFloor(command)).toEqual([]);
  });

  it("composes as a floor: an operator pattern can still raise above it", () => {
    const raising: RiskClassifier = {
      name: "local",
      tool: "Bash",
      patterns: [
        {
          pattern: "chmod",
          categories: ["privilege_escalation"],
          severity: "critical",
        },
      ],
    };
    const profile = classifyRisk(
      buildActionEnvelope(bashEvent("chmod -R 777 /var/www"), CTX),
      [raising],
    );
    expect(profile.severity).toBe("critical");
    expect(profile.categories).toContain("mass_update");
    expect(profile.categories).toContain("privilege_escalation");
  });

  it("keeps chmod/chown reversible (mass_update only, no data_loss)", () => {
    const profile = floorOnly("chmod -R 777 /var/www");
    expect(profile.categories).toEqual(["mass_update"]);
    expect(profile.reversible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Upgrade path: an EXISTING manifest (the original four dangerous-shell
// patterns) plus the shipped gate-prod-destructive policy.
// ---------------------------------------------------------------------------

const ORIGINAL_FOUR_PATTERNS: RiskClassifier = {
  name: "dangerous-shell",
  tool: "Bash",
  patterns: [
    {
      pattern: "rm\\s+-rf\\s+(/|/var|/data|/mnt|~)",
      categories: ["destructive", "data_loss"],
      severity: "critical",
    },
    {
      pattern: "DROP\\s+TABLE|TRUNCATE\\s+TABLE|DELETE\\s+FROM",
      categories: ["destructive", "data_loss"],
      severity: "high",
    },
    {
      pattern:
        "kubectl(?:\\s+-\\S+(?:\\s+(?!delete\\b)(?!-)\\S+)?)*\\s+delete\\s+(namespace|deployment|statefulset|pvc)",
      categories: ["destructive", "infrastructure_change"],
      severity: "high",
    },
    {
      pattern:
        "terraform(?:\\s+-\\S+(?:\\s+(?!destroy\\b)(?!-)\\S+)?)*\\s+destroy",
      categories: ["destructive", "infrastructure_change"],
      severity: "critical",
    },
  ],
};

const PROD_RESOLVER: EnvironmentResolver = {
  name: "production-signals",
  environment: "production",
  signals: { branch_patterns: ["main"] },
};

const GATE_PROD_DESTRUCTIVE: Policy = {
  name: "gate-prod-destructive",
  description: "deny critical-severity destructive shell actions against a production target",
  trigger: { event: "PreToolUse", match: "Bash" },
  when: {
    "risk.severity_at_least": "critical",
    "environment.name": "production",
  },
  requires: { ledger_tag: "risk-override:${SESSION_ID}" },
  hook: "risk-gate",
  enforcement: "block",
} as Policy;

const BUILTINS: ExtractBuiltins = {
  SESSION_ID: "sess-1",
  REPO: "proj",
  BRANCH: "main",
  TOOL_NAME: "Bash",
  CWD: "/tmp/proj",
};

const EMPTY_LEDGER: LedgerClient = {
  async query() {
    return { kind: "ok", entries: [] };
  },
  async record() {
    /* no-op */
  },
};

const riskCtx = (branch: string): RiskGateContext => ({
  git: { repo: "proj", branch, sha: "" },
  cwd: "/tmp/proj",
  user: "tester",
  host: "testhost",
  env: {},
  kubeContext: "",
  kubeNamespace: "",
});

describe("built-in destructive floor: upgrade path (manifest with only the original four patterns)", () => {
  it.each([
    ["dd", "dd if=/dev/zero of=/dev/sda"],
    ["truncate", "truncate -s 0 /var/log/app.log"],
    ["shred", "shred -u secret.txt"],
    ["mkfs", "mkfs.ext4 /dev/sdb1"],
    ["find -delete", "find /var/www -name '*.php' -delete"],
    ["find -exec rm", "find /var/www -exec rm {} +"],
  ])(
    "still hard-blocks %s in a production cwd, via the built-in floor rather than a manifest pattern",
    async (_label, command) => {
      // Premise: the old manifest genuinely does NOT match this command.
      const patternsOnly = classifyRisk(
        buildActionEnvelope(bashEvent(command), CTX),
        [],
      );
      expect(
        ORIGINAL_FOUR_PATTERNS.patterns.some((p) => new RegExp(p.pattern).test(command)),
      ).toBe(false);
      // ... and the floor is what classifies it.
      expect(patternsOnly.severity).toBe("critical");

      const result = await intercept({
        manifest: makeManifest({
          policies: [GATE_PROD_DESTRUCTIVE],
          classifiers: [ORIGINAL_FOUR_PATTERNS],
          resolvers: [PROD_RESOLVER],
        }),
        event: bashEvent(command),
        ledger: EMPTY_LEDGER,
        builtins: BUILTINS,
        now: NOW,
        riskContext: riskCtx("main"),
      });
      expect(result.blockJson).not.toBeNull();
      expect(result.decisions[0]?.policyName).toBe("gate-prod-destructive");
      expect(result.decisions[0]?.risk?.severity).toBe("critical");
      // A REAL classification, not the fail-closed unclassified fallback.
      expect(result.decisions[0]?.whenUnclassifiedFallback).toBeUndefined();
    },
  );

  it("negative control: a read the old manifest also does not match is NOT hard-blocked", async () => {
    const result = await intercept({
      manifest: makeManifest({
        policies: [GATE_PROD_DESTRUCTIVE],
        classifiers: [ORIGINAL_FOUR_PATTERNS],
        resolvers: [PROD_RESOLVER],
      }),
      event: bashEvent("sed -n '1,5p' /etc/hosts"),
      ledger: EMPTY_LEDGER,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.blockJson).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Parity: shipped template patterns vs the built-in floor.
// ---------------------------------------------------------------------------

/**
 * One canonical spelling per `dangerous-shell` pattern that task 2929c5b7
 * added. Keyed by the EXACT pattern string in the shipped manifest, so a
 * pattern edit that changes the string forces this table to be revisited
 * instead of silently losing its parity case.
 */
const CANONICAL_SPELLINGS: ReadonlyMap<string, string> = new Map([
  ["\\bdd\\s[^\\n]*\\bof=", "dd if=/dev/zero of=/dev/sda"],
  ["\\btruncate\\b[^\\n]*(\\s-[a-zA-Z]*s|--size)", "truncate -s 0 /var/log/app.log"],
  ["\\bshred\\b", "shred -u secret.txt"],
  ["\\bmkfs(\\.\\w+)?\\b", "mkfs.ext4 /dev/sdb1"],
  ["\\bfind\\b[^\\n]*-delete\\b", "find /var/www -name '*.php' -delete"],
  ["\\bfind\\b[^\\n]*-exec(dir)?\\s+rm\\b", "find /var/www -exec rm {} +"],
  ["\\bgit\\s+reset\\b[^\\n]*--hard\\b", "git reset --hard HEAD~3"],
  ["\\bgit\\s+push\\b[^\\n]*(--force(-with-lease)?\\b|\\s-f\\b)", "git push --force origin main"],
  ["\\bgit\\s+clean\\b[^\\n]*(--force\\b|\\s-[a-zA-Z]*f[a-zA-Z]*\\b)", "git clean -fd"],
  ["\\bgit\\s+checkout\\s+--\\s+\\.", "git checkout -- ."],
  ["\\bgit\\s+restore\\s+\\.(\\s|$)", "git restore ."],
  ["\\b(chmod|chown)\\b[^\\n]*(\\s-[a-zA-Z]*R|--recursive\\b)", "chmod -R 777 /var/www"],
  [
    "\\bcurl\\b[^\\n]*(-X\\s*|--request[\\s=])(?![Gg][Ee][Tt]\\b)(?![Hh][Ee][Aa][Dd]\\b)[A-Za-z]",
    "curl -X POST https://h/deploy",
  ],
  [
    "\\bcurl\\b[^\\n]*(\\s-[a-zA-Z]*[dFT]|--data\\b|--json\\b|--form(-string)?\\b|--upload-file\\b)",
    "curl -d @payload.json https://h/deploy",
  ],
  ["\\bsed\\b[^\\n]*(\\s-[a-zA-Z]*i[a-zA-Z]*\\b|--in-place\\b)", "sed -i 's/a/b/' /etc/config"],
]);

/**
 * The four patterns that predate task 2929c5b7. They describe SQL, kubectl
 * and terraform actions the built-in floor deliberately does not model, so
 * they are exempt from the parity requirement.
 */
const PRE_EXISTING_PATTERNS: ReadonlySet<string> = new Set([
  "rm\\s+-rf\\s+(/|/var|/data|/mnt|~)",
  "DROP\\s+TABLE|TRUNCATE\\s+TABLE|DELETE\\s+FROM",
  "kubectl(?:\\s+-\\S+(?:\\s+(?!delete\\b)(?!-)\\S+)?)*\\s+delete\\s+(namespace|deployment|statefulset|pvc)",
  "terraform(?:\\s+-\\S+(?:\\s+(?!destroy\\b)(?!-)\\S+)?)*\\s+destroy",
]);

function shippedDangerousShell() {
  const manifest = parseManifest(parseYaml(fs.readFileSync(REFERENCE_YAML, "utf8")));
  const classifier = manifest.risk.classifiers.find((c) => c.name === "dangerous-shell");
  if (classifier === undefined) throw new Error("dangerous-shell classifier not found");
  return classifier;
}

describe("built-in destructive floor: parity with the shipped dangerous-shell patterns", () => {
  it("every shipped pattern is either pre-existing or has a canonical spelling in the parity table", () => {
    const shipped = shippedDangerousShell().patterns.map((p) => p.pattern);
    const unaccounted = shipped.filter(
      (p) => !PRE_EXISTING_PATTERNS.has(p) && !CANONICAL_SPELLINGS.has(p),
    );
    expect(unaccounted).toEqual([]);
    // And the table carries no stale entry for a pattern that was removed.
    const stale = [...CANONICAL_SPELLINGS.keys()].filter((p) => !shipped.includes(p));
    expect(stale).toEqual([]);
  });

  it("every canonical spelling is matched by its own pattern, and by the built-in floor at the same severity or higher", () => {
    const shipped = shippedDangerousShell().patterns;
    for (const pattern of shipped) {
      const spelling = CANONICAL_SPELLINGS.get(pattern.pattern);
      if (spelling === undefined) continue; // pre-existing, exempt
      // The template pattern really does match its canonical spelling.
      expect(
        new RegExp(pattern.pattern).test(spelling),
        `pattern /${pattern.pattern}/ does not match its canonical spelling ${spelling}`,
      ).toBe(true);
      // ... and so does the built-in floor, at the same rung or above.
      const floored = floorOnly(spelling).severity;
      expect(floored, `floor did not classify ${spelling}`).not.toBeNull();
      expect(
        severityIndex(floored as RiskSeverity) >= severityIndex(pattern.severity),
        `floor classified ${spelling} as ${floored}, below the template's ${pattern.severity}`,
      ).toBe(true);
    }
  });
});
